package server

import (
	"context"
	"errors"
	"fmt"
	"time"

	"bonbon/internal/protocol"
	agent "bonbon/internal/runtime"
	"bonbon/internal/terminal"
)

// A side terminal is an interactive shell for ad hoc work in the session workspace. It
// uses the same server emulator, frames, and size owner rules as the session terminal.
// It keeps no events in SQLite. It has no run, no session status, and no handoff. Each
// session has at most one live side terminal.

// openSide attaches a view to the side terminal of a session. With start, it starts a
// shell when the session has no live side terminal. Without start, a session without a
// live side terminal gets an inactive session message and history-end.
func (s *Server) openSide(ctx context.Context, conn *protocol.Conn, id string, size protocol.Size, start bool) {
	if !terminal.ValidSize(size) {
		s.reply(conn, nil, errors.New("terminal size must be 2–512 columns and 1–256 rows"))
		return
	}
	// Serialize with archive and worktree removal. Two views cannot start two shells.
	s.launchMu.Lock()
	r := s.side(id)
	var err error
	if r == nil && start {
		r, err = s.startSide(ctx, id, size)
	} else if r == nil {
		_, err = s.store.Session(id)
	}
	s.launchMu.Unlock()
	if err != nil {
		s.reply(conn, nil, err)
		return
	}
	if r == nil {
		if conn.Send(protocol.Message{Type: "session", Session: id}) == nil {
			conn.Send(protocol.Message{Type: "history-end"})
		}
		return
	}
	s.attach(conn, r, size, nil)
}

// startSide starts the shell of a side terminal. The caller holds launchMu.
func (s *Server) startSide(ctx context.Context, id string, size protocol.Size) (*runningSession, error) {
	session, err := s.store.Session(id)
	if err != nil {
		return nil, err
	}
	if session.Archived {
		return nil, errors.New("restore the session before you open a side terminal")
	}
	if session.Run == nil && s.running(id) == nil {
		return nil, errors.New("start the session before you open a side terminal")
	}
	session.Workspace, err = agent.Canonical(session.Workspace)
	if err != nil {
		return nil, fmt.Errorf("the session workspace is not available: %w", err)
	}
	launch := agent.Launch{Run: protocol.Run{Workspace: session.Workspace, Size: size}}
	if launch.Shell, launch.Env, err = serverShell(); err != nil {
		return nil, err
	}
	runContext, cancel := context.WithCancel(ctx)
	r := &runningSession{id: id, controls: make(chan agent.Control, 16), cancel: cancel, done: make(chan struct{}), terminal: terminal.New(size), revision: 1, side: true}
	s.mu.Lock()
	s.sides[id] = r
	s.mu.Unlock()
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer cancel()
		code, err := agent.Side(runContext, s.info.DataDir, session, launch, r.controls, r.publish)
		r.finish(code, "", err)
		s.mu.Lock()
		if s.sides[id] == r {
			delete(s.sides, id)
		}
		s.mu.Unlock()
		close(r.done)
	}()
	return r, nil
}

func (s *Server) side(id string) *runningSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sides[id]
}

// stopSide ends the shell of the side terminal and its foreground job. The session
// terminal continues.
func (s *Server) stopSide(id string) (map[string]bool, error) {
	r := s.side(id)
	if r == nil {
		return map[string]bool{"stopped": false}, nil
	}
	r.cancel()
	select {
	case <-r.done:
		return map[string]bool{"stopped": true}, nil
	case <-time.After(10 * time.Second):
		return nil, errors.New("the side terminal has not finished stopping")
	}
}
