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

// remoteAccess admits the requests that a reverse proxy on this computer forwards for
// the remote host of Settings. The server listens only on loopback, so each of these
// requests comes from a local program. The checks stop a proxy that forwards for
// another host name or another Tailscale user. They do not authenticate local programs,
// which can already use the loopback host names.
type remoteAccess struct {
	mu sync.Mutex
	// host and login are the saved values. Remote access is on while both are set.
	host, login string
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

// saved applies the settings. A change closes each open remote connection, so that a
// view that the earlier values admitted does not stay connected.
func (a *remoteAccess) saved(settings history.Settings) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.host == settings.RemoteHost && a.login == settings.RemoteLogin {
		return
	}
	a.host, a.login = settings.RemoteHost, settings.RemoteLogin
	for conn := range a.conns {
		conn.Close()
	}
	clear(a.conns)
}

// origins returns the WebSocket origins of the remote host for the content security
// policy of a remote page.
func (a *remoteAccess) origins() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return "ws://" + a.host + " wss://" + a.host
}
