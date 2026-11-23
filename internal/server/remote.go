package server

import (
	"errors"
	"net/http"
	"strings"
	"sync"

	"bbflow/internal/history"
	"bbflow/internal/protocol"
)

// loginHeader is the header in which Tailscale Serve names the Tailscale user of a
// request. Serve removes each copy that the client sent. It sets the header only for a
// user device of the tailnet. A request of Tailscale Funnel, which comes from the
// internet, never has it.
const loginHeader = "Tailscale-User-Login"

// proxyHeaders are the headers that a reverse proxy adds to a request. Tailscale Serve
// sets X-Forwarded-Host on each request that it forwards, after it removes the
// forwarding headers of the client.
var proxyHeaders = []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", loginHeader, "Tailscale-Funnel-Request"}

// forwarded tells if a reverse proxy forwarded the request. Such a request is never a
// local request, also when its Host names the loopback host. Tailscale Serve keeps the
// Host of its client, and a client can send any Host.
func forwarded(r *http.Request) bool {
	for _, name := range proxyHeaders {
		if len(r.Header.Values(name)) > 0 {
			return true
		}
	}
	return false
}

// remoteAccess admits the requests that a reverse proxy on this computer forwards for
// the remote host of Settings. The server listens only on loopback, so each of these
// requests comes from a local program. The checks stop a proxy that forwards for
// another host name or another Tailscale user. They do not authenticate local programs,
// which can already use the loopback host names without the headers of a proxy.
type remoteAccess struct {
	mu sync.Mutex
	// host and login are the saved values. Remote access is on while both are set.
	host, login string
	// revision is the settings revision of host and login.
	revision int64
	// conns holds the open WebSocket connections of remote requests. A change of the
	// remote access settings closes them.
	conns map[*protocol.Conn]struct{}
}

// check returns nil for a request that remote access admits.
func (a *remoteAccess) check(r *http.Request) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.checkLocked(r)
}

func (a *remoteAccess) checkLocked(r *http.Request) error {
	if a.host == "" || a.login == "" || r.Host != a.host {
		return errors.New("invalid host")
	}
	if logins := r.Header.Values(loginHeader); len(logins) != 1 || !strings.EqualFold(logins[0], a.login) {
		return errors.New("remote access needs the Tailscale login of Settings")
	}
	return nil
}

// add registers the connection of a remote request. It checks the request again, because
// the settings can change during the WebSocket upgrade. After a false result, the
// caller closes the connection.
func (a *remoteAccess) add(conn *protocol.Conn, r *http.Request) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.checkLocked(r) != nil {
		return false
	}
	if a.conns == nil {
		a.conns = make(map[*protocol.Conn]struct{})
	}
	a.conns[conn] = struct{}{}
	return true
}

func (a *remoteAccess) remove(conn *protocol.Conn) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.conns, conn)
}

// origin tells if the Origin of a remote WebSocket upgrade is the HTTPS origin of the
// remote host. A comparison of the host alone also admits an HTTP page of that host.
func (a *remoteAccess) origin(r *http.Request) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	origins := r.Header.Values("Origin")
	return a.host != "" && len(origins) == 1 && origins[0] == "https://"+a.host
}

// saved applies saved settings. Settings with an earlier revision than the applied one
// do not apply, because two saves can call this function in the other order. A change
// closes each open remote connection, so that a view that the earlier values admitted
// does not stay connected. The connection keep stays open. It is the connection of the
// save request, which still needs its reply.
func (a *remoteAccess) saved(settings history.Settings, keep *protocol.Conn) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if settings.Revision < a.revision {
		return
	}
	a.revision = settings.Revision
	if a.host == settings.RemoteHost && a.login == settings.RemoteLogin {
		return
	}
	a.host, a.login = settings.RemoteHost, settings.RemoteLogin
	for conn := range a.conns {
		if conn != keep {
			conn.Close()
			delete(a.conns, conn)
		}
	}
}

// socketOrigin returns the secure WebSocket origin of the remote host for the content
// security policy of a remote page.
func (a *remoteAccess) socketOrigin() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return "wss://" + a.host
}
