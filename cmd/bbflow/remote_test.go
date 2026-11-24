package main

import (
	"io"
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
// remote request, adds forwarding headers, and names the Tailscale user in a header.
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
	// proxy returns the headers that Tailscale Serve adds to a request for requestHost.
	// A direct request to the loopback address has none.
	proxy := func(requestHost, requestLogin string) http.Header {
		headers := http.Header{}
		if requestHost != address {
			headers.Set("X-Forwarded-Host", requestHost)
			headers.Set("X-Forwarded-Proto", "https")
			headers.Set("X-Forwarded-For", "100.64.0.1")
		}
		if requestLogin != "" {
			headers.Set("Tailscale-User-Login", requestLogin)
		}
		return headers
	}
	// send sends one page request with a Host and headers.
	send := func(requestHost string, headers http.Header) *http.Response {
		t.Helper()
		request, _ := http.NewRequest("GET", "http://"+address+"/", nil)
		request.Host = requestHost
		request.Header = headers
		response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		return response
	}
	// get sends one page request with a Host and an optional Tailscale login.
	get := func(requestHost, requestLogin string) *http.Response {
		t.Helper()
		return send(requestHost, proxy(requestHost, requestLogin))
	}
	// failure returns the error text of a rejected page request.
	failure := func(requestHost, requestLogin string) string {
		t.Helper()
		request, _ := http.NewRequest("GET", "http://"+address+"/", nil)
		request.Host = requestHost
		request.Header = proxy(requestHost, requestLogin)
		response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		text, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != http.StatusForbidden {
			t.Fatalf("page request for %s got %d: %v", requestHost, response.StatusCode, err)
		}
		return strings.TrimSpace(string(text))
	}
	// upgrade opens a WebSocket connection with a Host, an Origin, and headers.
	upgrade := func(requestHost, origin string, headers http.Header) (*websocket.Conn, int) {
		t.Helper()
		headers.Set("Host", requestHost)
		headers.Set("Origin", origin)
		conn, response, _ := (&websocket.Dialer{HandshakeTimeout: time.Second}).Dial("ws://"+address+"/ws", headers)
		if response == nil {
			t.Fatal("no handshake response")
		}
		response.Body.Close()
		return conn, response.StatusCode
	}
	// dial opens a WebSocket connection as a browser on the remote page does.
	dial := func(requestHost, origin, requestLogin string) (*websocket.Conn, int) {
		t.Helper()
		return upgrade(requestHost, origin, proxy(requestHost, requestLogin))
	}
	// loopbackRejected sends a loopback Host through the proxy. Tailscale Serve selects
	// its backend by the TLS server name and keeps the Host that the client sent. Such a
	// request must not get the access of a local request.
	loopbackRejected := func(name string, headers http.Header) {
		t.Helper()
		for _, loopback := range []string{address, "localhost:" + port} {
			headers.Set("X-Forwarded-Host", loopback)
			if response := send(loopback, headers.Clone()); response.StatusCode != http.StatusForbidden {
				t.Fatalf("%s: page request for %s through the proxy got %d", name, loopback, response.StatusCode)
			}
			if conn, status := upgrade(loopback, "http://"+loopback, headers.Clone()); status != http.StatusForbidden {
				conn.Close()
				t.Fatalf("%s: WebSocket upgrade for %s through the proxy got %d", name, loopback, status)
			}
		}
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

	const off = "Remote access is off. Turn it on with: bbflow settings set remote true\n"
	const incomplete = "The remote switch is on, but remote access needs both remote-host and remote-login.\n"
	// Remote access starts off. One saved value alone keeps it off.
	rejected("off", host, login)
	loopbackRejected("off", http.Header{"Tailscale-User-Login": {login}})
	if output := cli("settings", "set", "remote-host", "My-Mac.Example.ts.net"); output != "Saved remote-host: "+host+".\n"+off {
		t.Fatalf("set remote-host: %q", output)
	}
	rejected("host alone", host, login)
	rejected("host alone, no login", host, "")
	// Both values keep remote access off until the switch turns on.
	if output := cli("settings", "set", "remote-login", login); output != "Saved remote-login: "+login+".\n"+off {
		t.Fatalf("set remote-login: %q", output)
	}
	rejected("switch off", host, login)
	if text := failure(host, login); text != "remote access is off" {
		t.Fatalf("the error does not tell that the switch is off: %q", text)
	}
	if text := failure("other.example.ts.net", login); text != "invalid host" {
		t.Fatalf("another host while the switch is off: %q", text)
	}
	if output := cli("settings", "set", "remote", "true"); output != "Saved remote: true.\nRemote access is on.\n" {
		t.Fatalf("set remote: %q", output)
	}
	if output := cli("settings", "get", "remote-host"); output != host+"\n" {
		t.Fatalf("get remote-host: %q", output)
	}
	if output := cli("settings", "get", "remote"); output != "true\n" {
		t.Fatalf("get remote: %q", output)
	}

	// The remote page gets a policy for its own WebSocket origin.
	response := get(host, login)
	policy := response.Header.Get("Content-Security-Policy")
	if response.StatusCode != http.StatusOK || !strings.Contains(policy, "connect-src 'self' wss://"+host+";") || strings.Contains(policy, "ws://") || strings.Contains(policy, "127.0.0.1") {
		t.Fatalf("remote page: %d %q", response.StatusCode, policy)
	}
	if response = get(host, "USER@example.com"); response.StatusCode != http.StatusOK {
		t.Fatal("the login check depends on letter case")
	}
	if response = get(address, ""); response.StatusCode != http.StatusOK {
		t.Fatalf("direct local page: %d", response.StatusCode)
	}
	if policy = response.Header.Get("Content-Security-Policy"); !strings.Contains(policy, "ws://127.0.0.1:"+port+" ws://localhost:"+port+";") || strings.Contains(policy, host) {
		t.Fatalf("local policy changed: %q", policy)
	}
	// A loopback Host through the proxy stays rejected while remote access is on.
	loopbackRejected("the saved login", http.Header{"Tailscale-User-Login": {login}})
	loopbackRejected("another login", http.Header{"Tailscale-User-Login": {"other@example.com"}})
	loopbackRejected("no login", http.Header{})
	loopbackRejected("Funnel", http.Header{"Tailscale-Funnel-Request": {"?1"}})
	// Each header of a proxy alone marks a forwarded request.
	for _, name := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Proto", "Tailscale-User-Login", "Tailscale-Funnel-Request"} {
		if response := send(address, http.Header{name: {"value"}}); response.StatusCode != http.StatusForbidden {
			t.Fatalf("a loopback Host with %s got %d", name, response.StatusCode)
		}
	}
	rejected("no login", host, "")
	rejected("another login", host, "other@example.com")
	rejected("another host", "other.example.ts.net", login)
	rejected("another port", host+":"+port, login)
	rejected("a longer host", "evil."+host, login)
	// Tailscale Funnel requests come from the internet and name no Tailscale user.
	request, _ := http.NewRequest("GET", "http://"+address+"/", nil)
	request.Host = host
	request.Header.Set("X-Forwarded-Host", host)
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
	// The Origin of a remote upgrade must be the HTTPS origin of the remote host.
	for _, origin := range []string{"https://example.com", "http://" + host, "https://" + host + ":8443", "https://" + strings.ToUpper(host)} {
		if conn, status := dial(host, origin, login); status != http.StatusForbidden {
			conn.Close()
			t.Fatalf("accepted the origin %s for the remote host", origin)
		}
	}
	// A browser sends an Origin with each upgrade. A remote upgrade without one fails.
	headers := proxy(host, login)
	headers.Set("Host", host)
	if conn, response, _ := (&websocket.Dialer{HandshakeTimeout: time.Second}).Dial("ws://"+address+"/ws", headers); response == nil || response.StatusCode != http.StatusForbidden {
		if conn != nil {
			conn.Close()
		}
		t.Fatal("accepted a remote upgrade without an Origin")
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
	if output := cli("settings", "set", "remote-login", ""); output != "Saved remote-login: none.\n"+incomplete {
		t.Fatalf("clear remote-login: %q", output)
	}
	if !closed(remote, 3*time.Second) {
		t.Fatal("the remote connection stayed open after remote access went off")
	}
	if closed(local, 300*time.Millisecond) {
		t.Fatal("the local connection closed with remote access")
	}
	rejected("no login again", host, login)
	cli("settings", "set", "remote-login", login)

	// The switch turns remote access off and keeps both values. It closes the remote
	// connection too.
	remote = watch(host, "https://"+host, login)
	if output := cli("settings", "set", "remote", "false"); output != "Saved remote: false.\n"+off {
		t.Fatalf("set remote false: %q", output)
	}
	if !closed(remote, 3*time.Second) {
		t.Fatal("the remote connection stayed open after the switch turned off")
	}
	rejected("switched off", host, login)
	if output := cli("settings", "get", "remote-login"); output != login+"\n" {
		t.Fatalf("the switch removed the login: %q", output)
	}

	// Saved remote access applies again after a server restart.
	cli("settings", "set", "remote", "true")
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
	if conn, status := dial(host+":8443", "https://"+host+":8443", login); status != http.StatusSwitchingProtocols {
		t.Fatalf("remote upgrade with a port got %d", status)
	} else {
		conn.Close()
	}
	if conn, status := dial(host+":8443", "https://"+host, login); status != http.StatusForbidden {
		conn.Close()
		t.Fatal("accepted the origin of the default port for the host with a port")
	}
	rejected("the host without its port", host, login)
}
