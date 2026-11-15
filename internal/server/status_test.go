package server

import (
	"encoding/json"
	"testing"
	"time"

	"bonbon/internal/history"
	"bonbon/internal/protocol"
	agent "bonbon/internal/runtime"
	"bonbon/internal/terminal"
)

func TestActivityFollowsApplicationOutput(t *testing.T) {
	start := time.Unix(1000, 0)
	a := activity{output: start}
	check := func(reason string, after time.Duration, want string) {
		t.Helper()
		if got := a.status(start.Add(after)); got != want {
			t.Fatalf("%s: status after %v is %s, expected %s", reason, after, got, want)
		}
	}
	check("a new terminal", 0, "running")
	check("a new terminal", idleAfter-time.Millisecond, "running")
	check("a terminal without output", idleAfter, "idle")

	a.applicationOutput(start.Add(10 * time.Second))
	check("background output", 10*time.Second, "running")
	check("the last output", 10*time.Second+idleAfter, "idle")

	// The echo of typed input and the redraw after a size change are not activity.
	for at := 20 * time.Second; at < 30*time.Second; at += 200 * time.Millisecond {
		a.viewAction(start.Add(at))
		a.applicationOutput(start.Add(at + echoWindow - time.Millisecond))
	}
	check("typed input", 30*time.Second, "idle")

	// Output continues after the view action, as when an agent starts to work.
	a.viewAction(start.Add(40 * time.Second))
	a.applicationOutput(start.Add(40*time.Second + echoWindow))
	check("output after the echo window", 40*time.Second+echoWindow, "running")
}

func TestSessionStatusHasFourValues(t *testing.T) {
	s, session := handoffFixture(t)
	now := time.Now()
	check := func(reason, want string) {
		t.Helper()
		current, err := s.store.Session(session.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got := s.sessionStatus(current, now); got != want {
			t.Fatalf("%s: status is %s, expected %s", reason, got, want)
		}
		listed, err := s.listSessions(history.SessionFilter{Query: session.ID})
		if err != nil || len(listed) != 1 || listed[0].Status != want {
			t.Fatalf("%s: list is %+v, %v, expected %s", reason, listed, err, want)
		}
		data, _ := json.Marshal(s.sessionDetail(current))
		var detail struct{ ID, Status string }
		if err = json.Unmarshal(data, &detail); err != nil || detail.ID != session.ID || detail.Status != want {
			t.Fatalf("%s: detail is %s, expected %s", reason, data, want)
		}
	}
	revision := session.Preparation.Revision
	check("a session that did not start", "draft")
	if err := s.store.SetPreparationState(session.ID, revision, "draft", "creating"); err != nil {
		t.Fatal(err)
	}
	check("worktree creation", "running")
	if err := s.store.SetPreparationState(session.ID, revision, "creating", "launched"); err != nil {
		t.Fatal(err)
	}
	check("a launch without a process", "ended")

	// A new terminal has no run record until its process starts.
	live := &runningSession{id: session.ID, activity: activity{output: now}}
	s.sessions[session.ID] = live
	check("a starting terminal", "running")
	run := recordRun(t, s, session.ID, map[string]any{}, "output\r\n", "running", false)
	check("a terminal with recent output", "running")
	live.activity.output = now.Add(-idleAfter)
	check("a terminal without recent output", "idle")
	live.ended = true
	check("a terminal after its process ended", "ended")
	delete(s.sessions, session.ID)

	// The stored status of the latest run does not change the four values.
	for _, status := range []string{"exited", "stopped", "failed", "interrupted"} {
		run.Status, run.Ended = status, history.Now()
		if err := s.store.SaveRun(run); err != nil {
			t.Fatal(err)
		}
		check("a run that "+status, "ended")
	}
	s.sessions[session.ID] = &runningSession{id: session.ID, activity: activity{output: now}}
	check("a new terminal in an ended session", "running")
}

// Only a resize that changes the PTY size makes the application redraw.
func TestOnlyChangedResizeStartsEchoWindow(t *testing.T) {
	size := protocol.Size{Cols: 80, Rows: 24}
	for _, test := range []struct {
		name string
		size protocol.Size
		want string
	}{
		{"an unchanged size", size, "running"},
		{"a changed size", protocol.Size{Cols: 40, Rows: 10}, "idle"},
	} {
		r := &runningSession{id: "fixture", controls: make(chan agent.Control, 16), done: make(chan struct{}), terminal: terminal.New(size)}
		view := r.subscribe(nil, size)
		before := time.Now().Add(-time.Minute)
		r.activity = activity{output: before, view: before}
		r.control(view, protocol.Message{Type: "resize", Size: test.size})
		if control := <-r.controls; control.Type != "resize" || control.Size != test.size {
			t.Fatalf("%s: the runtime got %+v", test.name, control)
		}
		if _, err := r.publish(history.Event{Kind: "output", Data: []byte("line\r\n")}); err != nil {
			t.Fatal(err)
		}
		if got := r.status(time.Now()); got != test.want {
			t.Fatalf("output after %s has status %s, expected %s", test.name, got, test.want)
		}
	}
}

func TestLiveStatusesOmitEndedTerminals(t *testing.T) {
	now := time.Now()
	s := &Server{sessions: map[string]*runningSession{
		"running": {id: "running", activity: activity{output: now}},
		"idle":    {id: "idle", activity: activity{output: now.Add(-idleAfter)}},
		"ended":   {id: "ended", activity: activity{output: now}, ended: true},
	}}
	got := s.liveStatuses(now)
	if len(got) != 2 || got["running"] != "running" || got["idle"] != "idle" {
		t.Fatalf("live statuses: %v", got)
	}
}
