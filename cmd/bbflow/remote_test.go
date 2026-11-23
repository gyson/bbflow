package main

import (
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"bbflow/internal/protocol"
	"github.com/gorilla/websocket"
)

// TestRemoteAccess sends the requests of a reverse proxy, such as Tailscale Serve, to a
// real test server. The proxy connects to the loopback port, keeps the Host of the
// remote request, and names the Tailscale user in a header.
func TestRemoteAccess(t *testing.T) {
	directory := t.TempDir()
	port := startTestServer(t, directory)
	address := "127.0.0.1:" + port
	const host, login = "my-mac.example.ts.net", "user@example.com"
	cli := func(args ...string) string {
		t.Helper()
		output, err := testCommand(args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %s %v", args, output, err)
		}
		return string(output)
	}
	// get sends one page request with a Host and an optional Tailscale login.
	get := func(requestHost, requestLogin string) *http.Response {
		t.Helper()
		request, _ := http.NewRequest("GET", "http://"+address+"/", nil)
		request.Host = requestHost
		if requestLogin != "" {
			request.Header.Set("Tailscale-User-Login", requestLogin)
		}
		response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		return response
	}
	// dial opens a WebSocket connection as a browser on the remote page does.
	dial := func(requestHost, origin, requestLogin string) (*websocket.Conn, int) {
		t.Helper()
		headers := http.Header{"Host": {requestHost}, "Origin": {origin}}
		if requestLogin != "" {
			headers.Set("Tailscale-User-Login", requestLogin)
		}
		conn, response, _ := (&websocket.Dialer{HandshakeTimeout: time.Second}).Dial("ws://"+address+"/ws", headers)
		if response == nil {
			t.Fatal("no handshake response")
		}
		response.Body.Close()
		return conn, response.StatusCode
	}
	rejected := func(name, requestHost, requestLogin string) {
		t.Helper()
		if response := get(requestHost, requestLogin); response.StatusCode != http.StatusForbidden {
			t.Fatalf("%s: page request got %d", name, response.StatusCode)
		}
		if conn, status := dial(requestHost, "https://"+requestHost, requestLogin); status != http.StatusForbidden {
			conn.Close()
			t.Fatalf("%s: WebSocket upgrade got %d", name, status)
		}
	}

	// Remote access starts off. One saved value alone keeps it off.
	rejected("off", host, login)
	if output := cli("settings", "set", "remote-host", "My-Mac.Example.ts.net"); output != "Saved remote-host: "+host+".\nRemote access is off. It needs both remote-host and remote-login.\n" {
		t.Fatalf("set remote-host: %q", output)
	}
	rejected("host alone", host, login)
	rejected("host alone, no login", host, "")
	if output := cli("settings", "set", "remote-login", login); output != "Saved remote-login: "+login+".\nRemote access is on.\n" {
		t.Fatalf("set remote-login: %q", output)
	}
	if output := cli("settings", "get", "remote-host"); output != host+"\n" {
		t.Fatalf("get remote-host: %q", output)
	}

	// The remote page gets a policy for its own WebSocket origin.
	response := get(host, login)
	policy := response.Header.Get("Content-Security-Policy")
	if response.StatusCode != http.StatusOK || !strings.Contains(policy, "connect-src 'self' ws://"+host+" wss://"+host+";") || strings.Contains(policy, "127.0.0.1") {
		t.Fatalf("remote page: %d %q", response.StatusCode, policy)
	}
	if response = get(host, "USER@example.com"); response.StatusCode != http.StatusOK {
		t.Fatal("the login check depends on letter case")
	}
	if policy = get(address, "").Header.Get("Content-Security-Policy"); !strings.Contains(policy, "ws://127.0.0.1:"+port+" ws://localhost:"+port+";") || strings.Contains(policy, host) {
		t.Fatalf("local policy changed: %q", policy)
	}
	rejected("no login", host, "")
	rejected("another login", host, "other@example.com")
	rejected("another host", "other.example.ts.net", login)
	rejected("another port", host+":"+port, login)
	rejected("a longer host", "evil."+host, login)
	// Tailscale Funnel requests come from the internet and name no Tailscale user.
	request, _ := http.NewRequest("GET", "http://"+address+"/", nil)
	request.Host = host
	request.Header.Set("Tailscale-Funnel-Request", "?1")
	if response, err := http.DefaultClient.Do(request); err != nil || response.StatusCode != http.StatusForbidden {
		t.Fatal("accepted a Funnel request", response, err)
	} else {
		response.Body.Close()
	}
	// Two copies of the header do not come from Tailscale Serve.
	request, _ = http.NewRequest("GET", "http://"+address+"/", nil)
	request.Host = host
	request.Header["Tailscale-User-Login"] = []string{login, login}
	if response, err := http.DefaultClient.Do(request); err != nil || response.StatusCode != http.StatusForbidden {
		t.Fatal("accepted two login headers", response, err)
	} else {
		response.Body.Close()
	}
	// The Origin of a remote upgrade must be the remote host.
	if conn, status := dial(host, "https://example.com", login); status != http.StatusForbidden {
		conn.Close()
		t.Fatal("accepted a foreign origin for the remote host")
	}

	// A remote view and a local view watch the statuses.
	watch := func(requestHost, origin, requestLogin string) *websocket.Conn {
		t.Helper()
		conn, status := dial(requestHost, origin, requestLogin)
		if status != http.StatusSwitchingProtocols {
			t.Fatalf("upgrade for %s got %d", requestHost, status)
		}
		t.Cleanup(func() { conn.Close() })
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		readGreeting(t, conn)
		if err := conn.WriteJSON(protocol.Message{Type: "request", Request: &protocol.Request{Protocol: protocol.Version, Operation: "status-watch"}}); err != nil {
			t.Fatal(err)
		}
		var statuses protocol.Message
		if err := conn.ReadJSON(&statuses); err != nil || statuses.Type != "statuses" {
			t.Fatalf("status watch: %+v %v", statuses, err)
		}
		return conn
	}
	remote := watch(host, "https://"+host, login)
	local := watch(address, "http://"+address, "")
	// closed tells if the server closed the connection within the wait.
	closed := func(conn *websocket.Conn, wait time.Duration) bool {
		conn.SetReadDeadline(time.Now().Add(wait))
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				timeout, ok := err.(net.Error)
				return !ok || !timeout.Timeout()
			}
		}
	}
	// A save of another setting keeps the remote connection.
	cli("settings", "set", "appearance", "dark")
	if closed(remote, 300*time.Millisecond) {
		t.Fatal("a save of another setting closed the remote connection")
	}
	// A change of remote access closes the remote connection, and only that one.
	remote = watch(host, "https://"+host, login)
	if output := cli("settings", "set", "remote-login", ""); output != "Saved remote-login: none.\nRemote access is off. It needs both remote-host and remote-login.\n" {
		t.Fatalf("clear remote-login: %q", output)
	}
	if !closed(remote, 3*time.Second) {
		t.Fatal("the remote connection stayed open after remote access went off")
	}
	if closed(local, 300*time.Millisecond) {
		t.Fatal("the local connection closed with remote access")
	}
	rejected("off again", host, login)

	// Saved remote access applies again after a server restart.
	cli("settings", "set", "remote-login", login)
	cli("--dir", directory, "server", "restart")
	if response = get(host, login); response.StatusCode != http.StatusOK {
		t.Fatalf("remote page after a restart: %d", response.StatusCode)
	}
	cli("settings", "set", "remote-host", "")
	rejected("host removed", host, login)

	// A proxy on another HTTPS port keeps that port in the Host.
	cli("settings", "set", "remote-host", host+":8443")
	if response = get(host+":8443", login); response.StatusCode != http.StatusOK {
		t.Fatalf("remote page with a port: %d", response.StatusCode)
	}
	rejected("the host without its port", host, login)
}
