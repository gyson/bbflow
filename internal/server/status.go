package server

import (
	"time"

	"bonbon/internal/history"
	"bonbon/internal/protocol"
)

const (
	// An application redraws after an input, a size change, or a signal from a view.
	// Output in this time after one of them is not application activity.
	echoWindow = 300 * time.Millisecond
	// A live terminal without application output for this time is idle.
	idleAfter = 3 * time.Second
)

// activity derives running or idle from the output times of a live terminal. It is not
// durable. Idle means only that there was no recent output. It does not mean that the
// application completed its work or is ready for input.
type activity struct {
	output time.Time // The start of the terminal, or its latest application output.
	view   time.Time // The latest input, size change, or signal from a view.
}

func (a *activity) viewAction(now time.Time) { a.view = now }

func (a *activity) applicationOutput(now time.Time) {
	if now.Sub(a.view) >= echoWindow {
		a.output = now
	}
}

func (a *activity) status(now time.Time) string {
	if now.Sub(a.output) < idleAfter {
		return "running"
	}
	return "idle"
}

// status returns running or idle for a live terminal, and ended after its process ends.
func (r *runningSession) status(now time.Time) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.ended {
		return "ended"
	}
	return r.activity.status(now)
}

// sessionStatus derives the one status that the UI shows for a session: draft,
// running, idle, or ended. The stored run and preparation states do not change.
// Worktree creation and process start show as running.
func (s *Server) sessionStatus(session history.Session, now time.Time) string {
	if r := s.running(session.ID); r != nil {
		if status := r.status(now); status != "ended" {
			return status
		}
	}
	if session.Run == nil && session.Preparation != nil {
		switch session.Preparation.State {
		case "draft":
			return "draft"
		case "creating":
			return "running"
		}
	}
	return "ended"
}

func (s *Server) sessionDetail(session history.Session) protocol.SessionDetail {
	return protocol.SessionDetail{Session: session, Status: s.sessionStatus(session, time.Now())}
}
