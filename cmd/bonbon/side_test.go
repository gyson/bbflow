package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bonbon/internal/client"
	"bonbon/internal/protocol"
)

func sideView(t *testing.T, operation, id string) *sessionView {
	t.Helper()
	return openSessionView(t, protocol.Request{Operation: operation, Session: id, Size: protocol.Size{Rows: 24, Cols: 80}})
}

func (c *sessionView) shellID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.shell
}

func sideCall(t *testing.T, request protocol.Request) (map[string]bool, error) {
	t.Helper()
	output, err := (client.Target{Dir: os.Getenv("BONBON_DIR")}).Call(request)
	if err != nil {
		return nil, err
	}
	var result map[string]bool
	if err = json.Unmarshal(output, &result); err != nil {
		t.Fatal(err)
	}
	return result, nil
}

// noSide checks that the session has no live side terminal.
func noSide(t *testing.T, id string) {
	t.Helper()
	view := sideView(t, "side-terminal-resume", id)
	select {
	case m := <-view.done:
		if m.Type != "history-end" {
			t.Fatalf("resume without a side terminal = %+v", m)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("resume without a side terminal did not end")
	}
}

func TestSideTerminalIsSeparateFromTheSession(t *testing.T) {
	dataDir := t.TempDir()
	startTestServer(t, dataDir)
	store := archive(t, dataDir)
	workspace := t.TempDir()
	canonical, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		t.Fatal(err)
	}
	main := newShell(t, workspace, "side fixture")
	id := sessionInfos(t, 10)[0].ID
	noSide(t, id)

	// Open starts a shell in the session workspace. The session terminal is not changed.
	side := sideView(t, "side-terminal-open", id)
	waitFor(t, func() bool { return strings.Contains(side.text(), "BONBON_SHELL_PROMPT> ") })
	// A long path wraps on the screen. Compare it in the shell.
	if _, err = side.Write([]byte("[ \"$(pwd -P)\" = '" + canonical + "' ] && echo IN-\"WORKSPACE\"; echo \"SIDE-$BONBON_SESSION\"\r")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		return strings.Contains(side.text(), "IN-WORKSPACE") && strings.Contains(side.text(), "SIDE-"+id)
	})
	if strings.Contains(main.text(), "SIDE-") {
		t.Fatal("side terminal output reached the session terminal")
	}
	if side.status() != "" {
		t.Fatalf("side terminal sent session statuses: %s", side.status())
	}
	if info := sessionInfos(t, 10)[0]; info.Viewers != 1 {
		t.Fatalf("side terminal views count as session viewers: %+v", info)
	}
	events, err := recordedEvents(t, store, id)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if bytes.Contains(event.Data, []byte("SIDE-")) || bytes.Contains(event.Data, []byte("WORKSPACE")) {
			t.Fatalf("archive recorded side terminal %s event: %q", event.Kind, event.Data)
		}
	}

	// A second open joins the same shell. A closed view leaves the shell running.
	second := sideView(t, "side-terminal-open", id)
	waitFor(t, func() bool { return strings.Contains(second.text(), "SIDE-"+id) })
	side.Close()
	second.Close()
	resumed := sideView(t, "side-terminal-resume", id)
	waitFor(t, func() bool { return strings.Contains(resumed.text(), "SIDE-"+id) })

	// Stop session ends the session terminal only.
	stopTestSession(t, id)
	main.wait(t, 129)
	if _, err = resumed.Write([]byte("echo after-$((40+2))\r")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return strings.Contains(resumed.text(), "after-42") })

	// Stop ends the shell for every view.
	result, err := sideCall(t, protocol.Request{Operation: "side-terminal-stop", Session: id})
	if err != nil || !result["stopped"] {
		t.Fatalf("stop = %v, %v", result, err)
	}
	resumed.wait(t, 129)
	noSide(t, id)
	if result, err = sideCall(t, protocol.Request{Operation: "side-terminal-stop", Session: id}); err != nil || result["stopped"] {
		t.Fatalf("second stop = %v, %v", result, err)
	}

	// A request for an ended shell does not join or stop the next shell.
	first := resumed.shellID()
	exiting := sideView(t, "side-terminal-open", id)
	waitFor(t, func() bool { return strings.Contains(exiting.text(), "BONBON_SHELL_PROMPT> ") })
	if first == "" || exiting.shellID() == "" || exiting.shellID() == first {
		t.Fatalf("shell IDs = %q, then %q", first, exiting.shellID())
	}
	stale := openSessionView(t, protocol.Request{Operation: "side-terminal-resume", Session: id, Shell: first, Size: protocol.Size{Rows: 24, Cols: 80}})
	select {
	case m := <-stale.done:
		if m.Type != "history-end" {
			t.Fatalf("resume of an ended shell = %+v", m)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("resume of an ended shell did not end")
	}
	if result, err = sideCall(t, protocol.Request{Operation: "side-terminal-stop", Session: id, Shell: first}); err != nil || result["stopped"] {
		t.Fatalf("stop of an ended shell = %v, %v", result, err)
	}
	current := openSessionView(t, protocol.Request{Operation: "side-terminal-resume", Session: id, Shell: exiting.shellID(), Size: protocol.Size{Rows: 24, Cols: 80}})
	waitFor(t, func() bool { return strings.Contains(current.text(), "BONBON_SHELL_PROMPT> ") })

	// A shell that exits ends the side terminal.
	if _, err = exiting.Write([]byte("exit 3\r")); err != nil {
		t.Fatal(err)
	}
	exiting.wait(t, 3)
	noSide(t, id)

	// Archive stops the side terminal. An archived session cannot open one.
	archived := sideView(t, "side-terminal-open", id)
	waitFor(t, func() bool { return strings.Contains(archived.text(), "BONBON_SHELL_PROMPT> ") })
	if _, err = sideCall(t, protocol.Request{Operation: "session-archive", Session: id, Archived: true}); err != nil {
		t.Fatal(err)
	}
	archived.wait(t, 129)
	refused := sideView(t, "side-terminal-open", id)
	select {
	case m := <-refused.done:
		if m.Type != "error" || !strings.Contains(m.Error, "restore the session") {
			t.Fatalf("archived open = %+v", m)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("archived open did not fail")
	}
	if events, err = recordedEvents(t, store, id); err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if bytes.Contains(event.Data, []byte("after-")) || bytes.Contains(event.Data, []byte("exit 3")) {
			t.Fatalf("archive recorded side terminal %s event: %q", event.Kind, event.Data)
		}
	}
}

func TestSideTerminalNeedsAStartedSession(t *testing.T) {
	startTestServer(t, t.TempDir())
	request := shellStartRequest(t, t.TempDir(), "draft", protocol.Size{Rows: 24, Cols: 80})
	refused := sideView(t, "side-terminal-open", request.Session)
	select {
	case m := <-refused.done:
		if m.Type != "error" || !strings.Contains(m.Error, "start the session") {
			t.Fatalf("draft open = %+v", m)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("draft open did not fail")
	}
	missing := sideView(t, "side-terminal-resume", "missing")
	select {
	case m := <-missing.done:
		if m.Type != "error" {
			t.Fatalf("missing session resume = %+v", m)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("missing session resume did not fail")
	}
}
