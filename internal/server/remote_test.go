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
	on := history.Settings{Revision: 2, RemoteOn: true, RemoteHost: host, RemoteLogin: login}
	off := history.Settings{Revision: 3, RemoteHost: host, RemoteLogin: login}
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
		t.Fatal("the earlier revision turned remote access on again")
	}
	if access.add(nil, request) {
		t.Fatal("a connection registered after the switch turned off")
	}
	on.Revision = 4
	access.saved(on, nil)
	if err := access.check(request); err != nil {
		t.Fatal("revision 4 did not apply:", err)
	}
}

// The error of a rejected request tells the first check that failed: the Host, the
// switch, then the login.
func TestRemoteAccessErrors(t *testing.T) {
	const host, login = "my-mac.example.ts.net", "user@example.com"
	const invalid, off, wrongLogin = "invalid host", "remote access is off", "remote access needs the Tailscale login of Settings"
	for _, test := range []struct {
		name     string
		settings history.Settings
		host     string
		login    string
		want     string
	}{
		{"on", history.Settings{RemoteOn: true, RemoteHost: host, RemoteLogin: login}, host, login, ""},
		{"off", history.Settings{RemoteHost: host, RemoteLogin: login}, host, login, off},
		{"off, another host", history.Settings{RemoteHost: host, RemoteLogin: login}, "other.example.ts.net", login, invalid},
		{"off, no values", history.Settings{}, host, login, invalid},
		{"on, no values", history.Settings{RemoteOn: true}, host, login, invalid},
		{"on, no host", history.Settings{RemoteOn: true, RemoteLogin: login}, host, login, invalid},
		{"on, no login", history.Settings{RemoteOn: true, RemoteHost: host}, host, login, wrongLogin},
		{"on, no login, empty header", history.Settings{RemoteOn: true, RemoteHost: host}, host, "", wrongLogin},
		{"on, another login", history.Settings{RemoteOn: true, RemoteHost: host, RemoteLogin: login}, host, "other@example.com", wrongLogin},
		{"on, another host", history.Settings{RemoteOn: true, RemoteHost: host, RemoteLogin: login}, "other.example.ts.net", login, invalid},
	} {
		var access remoteAccess
		test.settings.Revision = 1
		access.saved(test.settings, nil)
		got := ""
		if err := access.check(remoteRequest(test.host, test.login)); err != nil {
			got = err.Error()
		}
		if got != test.want {
			t.Errorf("%s: got %q, want %q", test.name, got, test.want)
		}
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
	const host, login = "my-mac.example.ts.net", "user@example.com"
	request := remoteRequest(host, login)
	if !remoteOrigin(request) {
		t.Fatal("the HTTPS origin of the Host failed")
	}
	for _, origins := range [][]string{nil, {"http://" + host}, {"https://" + host + ":443"}, {"https://other.example.ts.net"}, {"null"}, {"https://" + host, "https://" + host}} {
		request.Header["Origin"] = origins
		if remoteOrigin(request) {
			t.Fatalf("the origins %q passed", origins)
		}
	}
}

// A save can change the remote host between the check of a request and its upgrade.
// The Origin must then still agree with the Host of the same request.
func TestRemoteOriginDuringAHostChange(t *testing.T) {
	const host, next, login = "my-mac.example.ts.net", "other.example.ts.net", "user@example.com"
	var access remoteAccess
	access.saved(history.Settings{Revision: 1, RemoteOn: true, RemoteHost: host, RemoteLogin: login}, nil)
	// The page of the first host sends an upgrade with the Origin of the second host.
	request := remoteRequest(host, login)
	request.Header.Set("Origin", "https://"+next)
	if err := access.check(request); err != nil {
		t.Fatal(err)
	}
	access.saved(history.Settings{Revision: 2, RemoteOn: true, RemoteHost: next, RemoteLogin: login}, nil)
	if remoteOrigin(request) {
		t.Fatal("an Origin of the new host passed for a request with the earlier Host")
	}
	// A request that agrees with itself passes the origin check. The registration then
	// rejects it, because its Host is no longer the saved host.
	request.Header.Set("Origin", "https://"+host)
	if !remoteOrigin(request) || access.add(nil, request) {
		t.Fatal("a request for the earlier host registered after the change")
	}
}
