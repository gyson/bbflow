package server

import (
	"context"
	"maps"
	"time"

	"bbflow/internal/history"
	"bbflow/internal/protocol"
)

const (
	// An application redraws after an input, a size change, or a signal from a view.
	// Output in this time after one of them is not application activity.
	echoWindow = 300 * time.Millisecond
	// A live terminal without application output for this time is idle. Some agent CLIs
	// write no output for several seconds while they work.
	idleAfter = 10 * time.Second
	// A status watch finds a change in this time.
	watchInterval = 200 * time.Millisecond
)

// activity derives running or idle from the output times of a live terminal. It is not
// durable. Only output that changes what a view shows counts. Idle means only that there
// was no such output recently. It does not mean that the application completed its work
// or is ready for input.
type activity struct {
	output time.Time // The start of the terminal, or its latest application output.
	view   time.Time // The latest input, size change, or signal from a view.
}

func (a *activity) viewAction(now time.Time) { a.view = now }

// afterEcho tells whether output at this time comes after the echo window of the latest
// view action.
func (a *activity) afterEcho(now time.Time) bool { return now.Sub(a.view) >= echoWindow }

// applicationOutput records output that changed what a view shows. Output in the echo
// window of a view action is not application activity.
func (a *activity) applicationOutput(now time.Time) {
	if a.afterEcho(now) {
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

// liveStatuses returns running or idle for each session that has a live terminal.
func (s *Server) liveStatuses(now time.Time) map[string]string {
	s.mu.Lock()
	sessions := make([]*runningSession, 0, len(s.sessions))
	for _, r := range s.sessions {
		sessions = append(sessions, r)
	}
	s.mu.Unlock()
	statuses := make(map[string]string, len(sessions))
	for _, r := range sessions {
		if status := r.status(now); status != "ended" {
			statuses[r.id] = status
		}
	}
	return statuses
}

func sameRelease(a, b protocol.Release) bool {
	pointers := same(a.Offer, b.Offer) && same(a.Failed, b.Failed)
	a.Offer, b.Offer, a.Failed, b.Failed = nil, nil, nil, nil
	return pointers && a == b
}

// same compares the values of two pointers. Two nil pointers are the same.
func same[T comparable](a, b *T) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

// watchStatus sends the status of each live terminal, then all of them again after each
// change. It also sends them after a session title changes or the release check state
// changes. The statuses come from memory, not from the archive. A session whose terminal
// ended is absent. The view must send ping at least every 30 seconds. Closing the view
// only removes the watch.
func (s *Server) watchStatus(ctx context.Context, conn *protocol.Conn) {
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		for {
			conn.SetReadDeadline(time.Now().Add(30 * time.Second))
			message, err := conn.Receive()
			if err != nil || message.Type != "ping" || conn.Send(protocol.Message{Type: "pong"}) != nil {
				return
			}
		}
	}()
	defer func() { conn.Close(); <-closed }()
	ticker := time.NewTicker(watchInterval)
	defer ticker.Stop()
	var sent map[string]string
	var titles int64
	var shown protocol.Release
	for {
		next, revision, release := s.liveStatuses(time.Now()), s.titles.Load(), s.release()
		if sent == nil || !maps.Equal(sent, next) || revision != titles || !sameRelease(shown, release) {
			if conn.Send(protocol.Message{Type: "statuses", Statuses: next, Revision: revision, Release: &release}) != nil {
				return
			}
			sent, titles, shown = next, revision, release
		}
		select {
		case <-ctx.Done():
			return
		case <-closed:
			return
		case <-ticker.C:
		}
	}
}
