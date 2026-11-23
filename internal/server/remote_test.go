package server

import (
	"net/http"
	"testing"

	"bbflow/internal/history"
)

// remoteRequest returns a request that Tailscale Serve forwards for a host and a login.
func remoteRequest(host, login string) *http.Request {
	request, _ := http.NewRequest("GET", "http://127.0.0.1/", nil)
	request.Host = host
	request.Header.Set("X-Forwarded-Host", host)
	request.Header.Set("Tailscale-User-Login", login)
	request.Header.Set("Origin", "https://"+host)
	return request
}

// Two saves can apply their settings in the other order than their revisions. The
// settings of the earlier revision must not replace the later ones.
func TestRemoteAccessKeepsTheLatestRevision(t *testing.T) {
	const host, login = "my-mac.example.ts.net", "user@example.com"
	on := history.Settings{Revision: 2, RemoteHost: host, RemoteLogin: login}
	off := history.Settings{Revision: 3, RemoteHost: host}
	request := remoteRequest(host, login)
	var access remoteAccess
	access.saved(on, nil)
	if err := access.check(request); err != nil {
		t.Fatal("revision 2 did not apply:", err)
	}
	access.saved(off, nil)
	if access.check(request) == nil {
		t.Fatal("revision 3 did not turn remote access off")
	}
	// The save of revision 2 applies after the save of revision 3.
	access.saved(on, nil)
	if access.check(request) == nil {
		t.Fatal("the earlier revision restored the removed login")
	}
	if access.add(nil, request) {
		t.Fatal("a connection registered with the removed login")
	}
	on.Revision = 4
	access.saved(on, nil)
	if err := access.check(request); err != nil {
		t.Fatal("revision 4 did not apply:", err)
	}
}

func TestForwardedRequest(t *testing.T) {
	request, _ := http.NewRequest("GET", "http://127.0.0.1/", nil)
	if forwarded(request) {
		t.Fatal("a direct request counts as forwarded")
	}
	for _, name := range proxyHeaders {
		request, _ := http.NewRequest("GET", "http://127.0.0.1/", nil)
		request.Header.Set(name, "")
		if !forwarded(request) {
			t.Fatalf("a request with an empty %s does not count as forwarded", name)
		}
	}
}

func TestRemoteOrigin(t *testing.T) {
	const host = "my-mac.example.ts.net"
	var access remoteAccess
	request := remoteRequest(host, "user@example.com")
	if access.origin(request) {
		t.Fatal("an origin passed while remote access has no host")
	}
	access.saved(history.Settings{Revision: 1, RemoteHost: host, RemoteLogin: "user@example.com"}, nil)
	if !access.origin(request) {
		t.Fatal("the HTTPS origin of the remote host failed")
	}
	for _, origins := range [][]string{nil, {"http://" + host}, {"https://" + host + ":443"}, {"https://other.example.ts.net"}, {"null"}, {"https://" + host, "https://" + host}} {
		request.Header["Origin"] = origins
		if access.origin(request) {
			t.Fatalf("the origins %q passed", origins)
		}
	}
}
