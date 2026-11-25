package server

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"bbflow/internal/history"
	"bbflow/internal/protocol"
	agent "bbflow/internal/runtime"
	"bbflow/internal/terminal"
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
	// The idle delay is 10 seconds. The tooltip of the web client gives the same value.
	check("a new terminal", 0, "running")
	check("a new terminal", 10*time.Second-time.Millisecond, "running")
	check("a terminal without output", 10*time.Second, "idle")

	a.applicationOutput(start.Add(10 * time.Second))
	check("background output", 10*time.Second, "running")
	check("the last output", 20*time.Second-time.Millisecond, "running")
	check("the last output", 20*time.Second, "idle")

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
		if err != nil || len(listed.Sessions) != 1 || listed.Sessions[0].Status != want {
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

// Agent CLIs write output that changes nothing on the screen while they wait. Such output
// keeps the session idle. The archive marks it quiet, so it does not move the session in
// the session list.
func TestOutputThatChangesNothingIsQuiet(t *testing.T) {
	var quiet []int64
	r := &runningSession{id: "fixture", terminal: terminal.New(protocol.Size{Cols: 80, Rows: 24}),
		quiet: func(seq int64) error { quiet = append(quiet, seq); return nil }}
	idle := time.Now().Add(-time.Minute)
	r.activity = activity{output: idle, view: idle}
	publish := func(reason string, event history.Event, status string, marked ...int64) {
		t.Helper()
		if _, err := r.publish(event); err != nil {
			t.Fatal(err)
		}
		if got := r.status(time.Now()); got != status || fmt.Sprint(quiet) != fmt.Sprint(marked) {
			t.Fatalf("%s: status %s and quiet events %v, expected %s and %v", reason, got, quiet, status, marked)
		}
	}
	output := func(seq int64, data string) history.Event {
		return history.Event{Seq: seq, Kind: "output", Data: []byte(data)}
	}
	publish("a prompt", output(1, "prompt> "), "running")
	r.activity.output = idle
	// Codex 0.172.0 writes this frame about every 15 seconds while it waits for input.
	publish("a frame that puts the cursor back", output(2, "\x1b[?2026h\x1b[39m\x1b[49m\x1b[0m\x1b[1;9H\x1b[?25h\x1b[?2026l"), "idle", 2)
	// Claude Code rings the bell while it waits for input.
	publish("a bell", output(3, "\x07"), "idle", 2, 3)
	// The application answers a focus report of a view.
	r.activity.viewAction(time.Now())
	publish("the reply to a focus report", output(4, "\x1b(B\x1b[?2004h"), "idle", 2, 3, 4)
	// The echo of typed input changes the screen, but it is not application activity.
	publish("the echo of typed input", output(5, "x"), "idle", 2, 3, 4, 5)
	r.activity.view = idle
	publish("a notice", output(6, "\r\nnotice"), "running", 2, 3, 4, 5)
	publish("a size change", history.Event{Seq: 7, Kind: "resize", Data: []byte(`{"cols":40,"rows":10}`)}, "running", 2, 3, 4, 5)
}

// The runtime records output before the server compares the screen and sets the quiet
// flag. The session list must not count the output in that time.
func TestSessionListWaitsForTheQuietFlag(t *testing.T) {
	s, session := handoffFixture(t)
	other, err := s.store.CreateSession("other", session.Workspace, session.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	marking, release := make(chan struct{}), make(chan struct{})
	live := &runningSession{id: session.ID, terminal: terminal.New(protocol.Size{Cols: 80, Rows: 24}),
		quiet: func(seq int64) error { close(marking); <-release; return s.store.MarkQuiet(seq) }}
	s.sessions[session.ID] = live
	record := func(id, kind, data string) history.Event {
		t.Helper()
		event, err := s.store.Append(id, "run", kind, []byte(data), "")
		if err != nil {
			t.Fatal(err)
		}
		return event
	}
	publish := func(event history.Event) {
		t.Helper()
		if _, err := live.publish(event); err != nil {
			t.Fatal(err)
		}
	}
	first := func(reason, want string) {
		t.Helper()
		page, err := s.listSessions(history.SessionFilter{Limit: 10})
		if err != nil {
			t.Fatal(err)
		}
		for _, info := range page.Sessions {
			if info.ID == session.ID || info.ID == other.ID {
				if info.ID != want {
					t.Fatalf("%s: %s comes first, expected %s", reason, info.ID, want)
				}
				return
			}
		}
		t.Fatalf("%s: the list has neither session: %+v", reason, page)
	}
	publish(record(session.ID, "start", `{"cols":80,"rows":24}`))
	publish(record(session.ID, "output", "prompt> "))
	record(other.ID, "output", "newer")
	first("the newer output", other.ID)
	// A frame that changes nothing is recorded with quiet=0. The server sets the flag
	// after it compares the screen.
	frame := record(session.ID, "output", "\x1b[?25h")
	done := make(chan error)
	go func() { _, err := live.publish(frame); done <- err }()
	<-marking
	first("a frame before its quiet flag", other.ID)
	close(release)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	first("a frame with its quiet flag", other.ID)
	publish(record(session.ID, "output", "answer"))
	first("output that changes the screen", session.ID)
}

// A terminal can start while the server reads the session list. The list must not count
// its output before the quiet flag either.
func TestSessionListWaitsForTheQuietFlagOfANewTerminal(t *testing.T) {
	s, session := handoffFixture(t)
	other, err := s.store.CreateSession("other", session.Workspace, session.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	record := func(id, kind, data string) history.Event {
		t.Helper()
		event, err := s.store.Append(id, "run", kind, []byte(data), "")
		if err != nil {
			t.Fatal(err)
		}
		return event
	}
	record(other.ID, "output", "older")
	// The list request reads its bounds. Then the terminal starts.
	filter, err := s.orderFilter(history.SessionFilter{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	marking, release := make(chan struct{}), make(chan struct{})
	live := &runningSession{id: session.ID, terminal: terminal.New(protocol.Size{Cols: 80, Rows: 24}),
		quiet: func(seq int64) error { close(marking); <-release; return s.store.MarkQuiet(seq) }}
	s.mu.Lock()
	s.sessions[session.ID] = live
	s.mu.Unlock()
	if _, err = live.publish(record(session.ID, "start", `{"cols":80,"rows":24}`)); err != nil {
		t.Fatal(err)
	}
	record(other.ID, "input", "x")
	frame := record(session.ID, "output", "\x1b[?25h")
	done := make(chan error)
	go func() { _, err := live.publish(frame); done <- err }()
	<-marking
	page, err := s.store.ListSessions(filter)
	close(release)
	if err != nil || <-done != nil {
		t.Fatal(err)
	}
	for _, listed := range page.Sessions {
		if listed.ID == session.ID || listed.ID == other.ID {
			if listed.ID != other.ID {
				t.Fatalf("a frame of a terminal that started during the list read came first: %+v", page.Sessions)
			}
			return
		}
	}
	t.Fatalf("the list has neither session: %+v", page.Sessions)
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
