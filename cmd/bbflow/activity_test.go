package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"bbflow/internal/client"
	"bbflow/internal/protocol"
)

func TestSessionViewsDoNotChangeActivityOrder(t *testing.T) {
	directory := t.TempDir()
	startTestServer(t, directory)
	store := archive(t, directory)
	trigger := filepath.Join(t.TempDir(), "emit")
	first := launchAgent(t, t.TempDir(), "activity", trigger)
	waitFor(t, func() bool { return strings.Contains(first.text(), "READY") })
	firstID := sessionInfos(t, 10)[0].ID
	first.Close()
	waitFor(t, func() bool { return sessionInfos(t, 10)[0].Viewers == 0 })
	second := newShell(t, t.TempDir(), "more recent")
	before := sessionInfos(t, 10)
	if len(before) != 2 || before[0].ID == firstID {
		t.Fatalf("newer shell is not first: %+v", before)
	}
	resumed := resumeView(t, firstID)
	waitFor(t, func() bool { return strings.Contains(resumed.text(), "READY") })
	// An unchanged viewport must remain display-only.
	if err := resumed.conn.Send(protocol.Message{Type: "resize", Size: protocol.Size{Rows: 24, Cols: 80}}); err != nil {
		t.Fatal(err)
	}
	// Allow the runtime to process controls and any accidental SIGWINCH output.
	time.Sleep(250 * time.Millisecond)
	after := sessionInfos(t, 10)
	if len(after) != len(before) {
		t.Fatalf("viewing changed session count: %+v", after)
	}
	for i := range before {
		if after[i].ID != before[i].ID || after[i].Updated != before[i].Updated {
			t.Fatalf("viewing changed activity order: before=%+v after=%+v", before, after)
		}
	}
	events, err := recordedEvents(t, store, firstID)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Kind == "resize" {
			t.Fatal("same-size reattachment recorded a resize")
		}
	}
	// A real dimension change still reaches the PTY and notifies the application.
	if err = resumed.conn.Send(protocol.Message{Type: "resize", Size: protocol.Size{Rows: 30, Cols: 100}}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return strings.Contains(recordedOutput(t, store, firstID), "RESIZED=30x100") })
	events, err = recordedEvents(t, store, firstID)
	if err != nil {
		t.Fatal(err)
	}
	resizes := 0
	for _, event := range events {
		if event.Kind == "resize" {
			resizes++
		}
	}
	if resizes != 1 {
		t.Fatalf("recorded %d resizes; want one actual size change", resizes)
	}
	resumed.Close()
	waitFor(t, func() bool {
		for _, info := range sessionInfos(t, 10) {
			if info.ID == firstID {
				return info.Viewers == 0
			}
		}
		return false
	})
	if _, err = second.Write([]byte("printf 'newer-%s\\n' activity\r")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return strings.Contains(second.text(), "newer-activity") })
	if sessionInfos(t, 10)[0].ID == firstID {
		t.Fatal("terminal interaction did not promote the second session")
	}
	if err = os.WriteFile(trigger, nil, 0600); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return strings.Contains(recordedOutput(t, store, firstID), "BACKGROUND_ACTIVITY") })
	if sessionInfos(t, 10)[0].ID != firstID {
		t.Fatal("detached terminal output did not promote the first session")
	}
}

func TestSessionStatusFollowsApplicationOutput(t *testing.T) {
	startTestServer(t, t.TempDir())
	trigger := filepath.Join(t.TempDir(), "emit")
	view := launchAgent(t, t.TempDir(), "activity", trigger)
	waitFor(t, func() bool { return strings.Contains(view.text(), "READY") })
	listed := func() string { return sessionInfos(t, 10)[0].Status }
	// The fixture writes no more output. The session becomes idle without a view action.
	waitFor(t, func() bool { return listed() == "idle" && view.status() == "running,idle" })
	id := sessionInfos(t, 10)[0].ID
	watch := watchStatuses(t)
	// The terminal echoes typed input. This echo is not application activity.
	if _, err := view.Write([]byte("typed")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return strings.Contains(view.text(), "typed") })
	time.Sleep(500 * time.Millisecond)
	if got := listed(); got != "idle" {
		t.Fatalf("typed input changed the status to %s", got)
	}
	// Output without a view action is application activity.
	if err := os.WriteFile(trigger, nil, 0600); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return listed() == "running" && view.status() == "running,idle,running" })
	waitFor(t, func() bool { return listed() == "idle" && view.status() == "running,idle,running,idle" })
	// A view that joins later gets the current status.
	second := resumeView(t, id)
	waitFor(t, func() bool { return second.status() == "idle" })
	// A status watch gets each change without a view of the session.
	waitFor(t, func() bool { return watch.of(id) == "idle,running,idle" })
	stopTestSession(t, id)
	if got := listed(); got != "ended" {
		t.Fatalf("a stopped session has status %s", got)
	}
	// A session whose terminal ended is absent from the watch.
	waitFor(t, func() bool { return watch.of(id) == "idle,running,idle,absent" })
}

// A view that reconnects sends its size again. The runtime ignores an unchanged size, so
// the application does not redraw. The output that follows is application activity.
func TestUnchangedResizeDoesNotHideApplicationOutput(t *testing.T) {
	startTestServer(t, t.TempDir())
	trigger := filepath.Join(t.TempDir(), "emit")
	view := launchAgent(t, t.TempDir(), "activity", trigger)
	waitFor(t, func() bool { return strings.Contains(view.text(), "READY") })
	listed := func() string { return sessionInfos(t, 10)[0].Status }
	waitFor(t, func() bool { return listed() == "idle" })
	if err := view.conn.Send(protocol.Message{Type: "resize", Size: protocol.Size{Rows: 24, Cols: 80}}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(trigger, nil, 0600); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return strings.Contains(view.text(), "BACKGROUND_ACTIVITY") })
	if strings.Contains(view.text(), "RESIZED") {
		t.Fatalf("an unchanged size reached the application: %q", view.text())
	}
	if got := listed(); got != "running" {
		t.Fatalf("output after an unchanged resize has status %s", got)
	}
}

// statusWatch records the messages of one status watch stream.
type statusWatch struct {
	mu   sync.Mutex
	seen []map[string]string
}

func watchStatuses(t *testing.T) *statusWatch {
	t.Helper()
	conn, err := (client.Target{Dir: os.Getenv("BBFLOW_DIR")}).Connect(protocol.Request{Operation: "status-watch"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	w := &statusWatch{}
	go func() {
		for {
			m, err := conn.Receive()
			if err != nil || m.Type != "statuses" {
				return
			}
			w.mu.Lock()
			w.seen = append(w.seen, m.Statuses)
			w.mu.Unlock()
		}
	}()
	return w
}

// of returns each status that the watch sent for one session, in order. A session
// without a live terminal is absent.
func (w *statusWatch) of(id string) string {
	w.mu.Lock()
	defer w.mu.Unlock()
	var statuses []string
	for _, message := range w.seen {
		status := message[id]
		if status == "" {
			status = "absent"
		}
		if len(statuses) == 0 || statuses[len(statuses)-1] != status {
			statuses = append(statuses, status)
		}
	}
	return strings.Join(statuses, ",")
}
