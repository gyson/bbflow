// Package server owns agent processes and the open history archive.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"bbflow/internal/desktop"
	"bbflow/internal/history"
	"bbflow/internal/instance"
	"bbflow/internal/protocol"
	"bbflow/internal/webui"
	"github.com/gorilla/websocket"
)

type Server struct {
	store    *history.Store
	info     protocol.ServerInfo
	cancel   context.CancelFunc
	wg       sync.WaitGroup
	mu       sync.Mutex
	launchMu sync.Mutex
	sessions map[string]*runningSession
	sides    map[string]*runningSession // Side terminals by session ID.
	watchMu  sync.Mutex
	watchers map[string]map[*draftWatcher]struct{} // Draft watchers by session ID.
	// ctx ends at server stop. Background jobs use it, and Serve waits for them before
	// the caller closes the archive.
	ctx  context.Context
	jobs sync.WaitGroup
	// titles counts title changes. A status watch sends it, so that views read titles again.
	titles atomic.Int64
	// releases is nil for a build that cannot update, such as a development build.
	releases Releases
	updates  updates
	// open opens a file with the default application of the user. Tests replace it.
	// A nil open rejects workspace-open.
	open func(ctx context.Context, path string) error
}

// On cancellation, Serve stops new requests and waits for agent cleanup. The caller
// owns the archive and the exclusive server lock for its directory. Serve publishes
// server.json and returns the published identity. The caller removes that descriptor
// after its own cleanup, immediately before it releases the lock. Until then, clients
// can identify a server that is shutting down. A nil releases turns off the release
// check and the update operation.
func Serve(ctx context.Context, listener net.Listener, store *history.Store, releases Releases) (protocol.ServerInfo, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	executable, _ := os.Executable()
	s := &Server{ctx: ctx, store: store, cancel: cancel, sessions: make(map[string]*runningSession), sides: make(map[string]*runningSession), info: protocol.ServerInfo{
		Protocol: protocol.Version, Instance: history.ID(), PID: os.Getpid(),
		DataDir: filepath.Dir(store.Path), Port: listener.Addr().(*net.TCPAddr).Port,
		Executable: executable,
	}, releases: releases, open: desktop.Open}
	s.updates.load(store)
	if err := s.ensureGeneral(); err != nil {
		return protocol.ServerInfo{}, err
	}
	if err := instance.Publish(s.info); err != nil {
		return protocol.ServerInfo{}, err
	}
	if releases != nil {
		s.jobs.Add(1)
		go func() {
			defer s.jobs.Done()
			s.checkReleases(ctx)
		}()
	}
	upgrader := websocket.Upgrader{HandshakeTimeout: 5 * time.Second}
	mux := http.NewServeMux()
	webui.Register(mux, func() (string, error) {
		settings, err := s.store.Settings()
		return settings.Appearance, err
	})
	mux.HandleFunc("GET /client-config", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s.info)
	})
	mux.HandleFunc("GET "+protocol.Path, func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		if ctx.Err() != nil {
			s.mu.Unlock()
			http.Error(w, "server is stopping", http.StatusServiceUnavailable)
			return
		}
		// HTTP shutdown does not wait for upgraded connections. Register before the upgrade.
		// Prevent new registrations after shutdown starts.
		s.wg.Add(1)
		s.mu.Unlock()
		defer s.wg.Done()
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		wire := protocol.Wrap(conn)
		defer wire.Close()
		s.handle(ctx, wire)
	})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Apply the loopback Host restriction to both assets and WebSockets.
		// The upgrader also rejects foreign browser origins.
		if r.Host != listener.Addr().String() && r.Host != fmt.Sprintf("localhost:%d", s.info.Port) {
			http.Error(w, "invalid local host", http.StatusForbidden)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", fmt.Sprintf("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:%d ws://localhost:%d; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", s.info.Port, s.info.Port))
		mux.ServeHTTP(w, r)
	})
	httpServer := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() { <-ctx.Done(); httpServer.Close() }()
	err := httpServer.Serve(listener)
	s.mu.Lock()
	cancel()
	s.mu.Unlock()
	httpServer.Close()
	s.wg.Wait()
	s.jobs.Wait()
	if errors.Is(err, http.ErrServerClosed) || errors.Is(err, net.ErrClosed) {
		return s.info, nil
	}
	return s.info, err
}

func (s *Server) handle(ctx context.Context, conn *protocol.Conn) {
	// Let attached clients receive the final screen and exit status during normal
	// shutdown. A stalled peer must release its handler within five seconds.
	finished := make(chan struct{})
	defer close(finished)
	stopClose := context.AfterFunc(ctx, func() {
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			conn.Close()
		}
	})
	defer stopClose()
	if err := conn.Send(protocol.Message{Type: "server", Server: &s.info}); err != nil {
		return
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	message, err := conn.Receive()
	if err != nil || message.Type != "request" || message.Request == nil {
		return
	}
	conn.SetReadDeadline(time.Time{})
	request := message.Request
	if request.Protocol != protocol.Version {
		s.reply(conn, nil, errors.New("unsupported client protocol; rebuild the client and restart the server"))
		return
	}
	if ctx.Err() != nil {
		s.reply(conn, nil, errors.New("server is stopping"))
		return
	}
	switch request.Operation {
	case "settings-get":
		result, err := s.store.Settings()
		s.reply(conn, result, err)
	case "settings-save":
		if request.Settings == nil {
			s.reply(conn, nil, errors.New("missing settings"))
			return
		}
		err := s.checkPort(request.Settings.Port)
		var result history.Settings
		if err == nil {
			result, err = s.store.SaveSettings(*request.Settings)
		}
		if err == nil {
			s.updates.saved(result)
		}
		s.reply(conn, result, err)
	case "workspace-inspect":
		s.reply(conn, inspectRepository(ctx, request.Workspace), nil)
	case "project-draft":
		result, err := s.prepareProject(ctx, request.Project, request.Parent)
		s.reply(conn, s.sessionDetail(result), err)
	case "session-config":
		if request.Preparation == nil {
			result, err := s.store.Session(request.Session)
			s.reply(conn, s.sessionDetail(result), err)
		} else {
			result, err := s.savePreparation(request)
			s.reply(conn, s.sessionDetail(result), err)
		}
	case "session-start":
		s.startPrepared(ctx, conn, request)
	case "worktree-remove":
		err := s.removeWorktree(ctx, request.Session)
		s.reply(conn, map[string]bool{"removed": err == nil}, err)
	case "update-start":
		err := s.startUpdate(request.Version, request.Revision)
		s.reply(conn, map[string]bool{"updating": err == nil}, err)
	case "stop":
		if request.Instance != s.info.Instance {
			s.reply(conn, nil, errors.New("server instance changed; retry stop"))
			return
		}
		s.reply(conn, map[string]bool{"stopping": true}, nil)
		s.cancel()
	case "project-list":
		result, err := s.store.Projects()
		s.reply(conn, result, err)
	case "project-add":
		result, err := s.addProject(request.Name, request.Workspace)
		s.reply(conn, result, err)
	case "project-rename":
		err := s.store.RenameProject(request.Project, request.Name)
		s.reply(conn, map[string]bool{"renamed": err == nil}, err)
	case "project-remove":
		err := s.store.RemoveProject(request.Project)
		s.reply(conn, map[string]bool{"removed": err == nil}, err)
	case "session-rename":
		err := s.store.RenameSession(request.Session, request.Name)
		if err == nil {
			s.titles.Add(1)
		}
		s.reply(conn, map[string]bool{"renamed": err == nil}, err)
	case "title-tools":
		s.reply(conn, titleTools, nil)
	case "title-test":
		if request.Settings == nil {
			s.reply(conn, nil, errors.New("missing title tool"))
			return
		}
		s.cancelableRead(ctx, conn, func(ctx context.Context) (any, error) {
			command, err := titleCommand(request.Settings.TitleTool)
			if err != nil {
				return nil, err
			}
			title, err := runTitleCommand(ctx, command, request.Text)
			return map[string]string{"title": title}, err
		})
	case "session-resume":
		s.resumeSession(conn, request.Session, request.Run, request.Size)
	case "session-terminals":
		result, err := s.terminals(request.Session)
		s.reply(conn, result, err)
	case "session-handoff":
		result, err := s.handoffInfo(request.Session)
		s.reply(conn, result, err)
	case "session-continue":
		s.continueSession(ctx, conn, request)
	case "side-terminal-open":
		s.openSide(ctx, conn, request.Session, "", request.Size, true)
	case "side-terminal-resume":
		s.openSide(ctx, conn, request.Session, request.Shell, request.Size, false)
	case "side-terminal-stop":
		result, err := s.stopSide(request.Session, request.Shell)
		s.reply(conn, result, err)
	case "session-list":
		// The groups bound the reply. Without them, a reply could list each project.
		var result protocol.SessionPage
		err := errors.New("session-list needs groups")
		if len(request.Groups) > 0 {
			result, err = s.listSessions(history.SessionFilter{
				Limit: request.Limit, Groups: request.Groups, Offset: request.Offset, Include: request.Session, Archived: request.Archived, Query: request.Query,
			})
		}
		s.reply(conn, result, err)
	case "status-watch":
		s.watchStatus(ctx, conn)
	case "session-archive":
		err := s.archiveSession(request.Session, request.Archived, request.Members)
		s.reply(conn, map[string]bool{"archived": request.Archived}, err)
	case "session-stop":
		result, err := s.stopSession(request.Session)
		s.reply(conn, result, err)
	case "query":
		result, err := s.store.Query(ctx, request.SQL)
		s.reply(conn, result, err)
	case "storage-report":
		s.cancelableRead(ctx, conn, func(ctx context.Context) (any, error) { return s.store.StorageReport(ctx) })
	case "history-search":
		if request.Search == nil {
			s.reply(conn, nil, errors.New("missing history search"))
			return
		}
		s.cancelableRead(ctx, conn, func(ctx context.Context) (any, error) { return s.store.Search(ctx, *request.Search) })
	case "history-context":
		if request.Context == nil {
			s.reply(conn, nil, errors.New("missing history context"))
			return
		}
		s.cancelableRead(ctx, conn, func(ctx context.Context) (any, error) { return s.store.SearchContext(ctx, *request.Context) })
	case "workspace-changes":
		s.cancelableRead(ctx, conn, func(ctx context.Context) (any, error) { return s.workspaceChanges(ctx, request.Session, request.Diff) })
	case "workspace-files":
		s.cancelableRead(ctx, conn, func(ctx context.Context) (any, error) { return s.workspaceFiles(ctx, request.Session) })
	case "workspace-folders":
		s.cancelableRead(ctx, conn, func(ctx context.Context) (any, error) { return s.workspaceFolders(ctx, request.Session, request.Diff) })
	case "workspace-file":
		s.cancelableRead(ctx, conn, func(ctx context.Context) (any, error) { return s.workspaceFile(ctx, request.Session, request.Diff) })
	case "workspace-open":
		err := s.workspaceOpen(ctx, request.Session, request.Diff)
		s.reply(conn, map[string]bool{"opened": err == nil}, err)
	case "composer-draft":
		result, err := s.composer(request.Session, request.Draft)
		s.reply(conn, result, err)
	case "composer-watch":
		s.watchComposer(ctx, conn, request.Session)
	case "composer-sent":
		result, err := s.sentMessages(request.Session, request.Revision)
		s.reply(conn, result, err)
	case "composer-attach":
		result, err := s.upload(request.Session, request.Upload)
		s.reply(conn, result, err)
	default:
		s.reply(conn, nil, errors.New("unknown request"))
	}
}

// checkPort rejects a new port for Settings when another program holds it now. A port
// that is free now can still be held at the next start. The check skips the saved port,
// so other settings can save while another program holds that port. SaveSettings checks
// the range.
func (s *Server) checkPort(port int) error {
	if port < history.MinPort || port > 65535 || port == s.info.Port {
		return nil
	}
	saved, err := s.store.Settings()
	if err != nil || port == saved.Port {
		return err
	}
	listener, err := ListenLoopback(port)
	if errors.Is(err, syscall.EADDRINUSE) {
		return fmt.Errorf("another program uses port %d; choose another port", port)
	}
	if err != nil {
		return fmt.Errorf("cannot use port %d: %w", port, err)
	}
	return listener.Close()
}

func (s *Server) reply(conn *protocol.Conn, result any, err error) {
	if err != nil {
		conn.Send(protocol.Message{Type: "error", Error: err.Error()})
		return
	}
	data, err := json.Marshal(result)
	if err != nil {
		conn.Send(protocol.Message{Type: "error", Error: err.Error()})
		return
	}
	// The client must get an answer, also when the result is too large to send.
	if errors.Is(conn.Send(protocol.Message{Type: "result", Result: data}), protocol.ErrMessageTooLarge) {
		conn.Send(protocol.Message{Type: "error", Error: "the result exceeds 16 MiB"})
	}
}

// A read connection carries one request. Disconnecting cancels its SQLite or Git work.
func (s *Server) cancelableRead(ctx context.Context, conn *protocol.Conn, read func(context.Context) (any, error)) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stopClose := context.AfterFunc(ctx, func() { conn.Close() })
	defer stopClose()
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn.Receive()
		cancel()
	}()
	defer func() { conn.Close(); <-done }()
	result, err := read(ctx)
	if ctx.Err() == nil {
		s.reply(conn, result, err)
	}
}
