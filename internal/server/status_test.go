package server

import (
	"encoding/json"
	"testing"
	"time"

	"bonbon/internal/history"
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
