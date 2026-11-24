package server

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bbflow/internal/history"
	"bbflow/internal/protocol"
	agent "bbflow/internal/runtime"
	"bbflow/internal/terminal"
	"github.com/gorilla/websocket"
)

// Each peer consumes its own acknowledged frame stream.
type testView struct {
	t    *testing.T
	peer *websocket.Conn
	done <-chan struct{}
}

func openTestView(t *testing.T, s *Server, r *runningSession, size protocol.Size) *testView {
	t.Helper()
	conn, peer := attachmentPair(t)
	done := make(chan struct{})
	go func() { defer close(done); s.attach(conn, r, size, nil, "") }()
	v := &testView{t, peer, done}
	t.Cleanup(func() { peer.Close(); <-done })
	v.read("session")
	return v
}
func (v *testView) send(m protocol.Message) {
	v.t.Helper()
	if err := v.peer.WriteJSON(m); err != nil {
		v.t.Fatal(err)
	}
}
func (v *testView) ack(m protocol.Message) {
	v.send(protocol.Message{Type: "frame-ack", Revision: m.Revision})
}
func (v *testView) read(kind string) protocol.Message {
	v.t.Helper()
	v.peer.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		var m protocol.Message
		if err := v.peer.ReadJSON(&m); err != nil {
			v.t.Fatal(err)
		}
		if m.Type == kind {
			return m
		}
		if m.Type == "error" {
			v.t.Fatal(m.Error)
		}
		if m.Type == "frame" {
			v.ack(m)
		}
	}
}

func TestSharedViewsSizeOwnerAndIndependentFlow(t *testing.T) {
	size := protocol.Size{Cols: 80, Rows: 24}
	small := protocol.Size{Cols: 40, Rows: 10}
	r := &runningSession{id: "fixture", controls: make(chan agent.Control, 16), done: make(chan struct{}), terminal: terminal.New(size), revision: 1}
	s := &Server{}
	next := func() agent.Control {
		t.Helper()
		select {
		case control := <-r.controls:
			return control
		case <-time.After(5 * time.Second):
			t.Fatal("control missing")
			return agent.Control{}
		}
	}
	none := func(reason string) {
		t.Helper()
		select {
		case control := <-r.controls:
			t.Fatalf("%s: %+v", reason, control)
		default:
		}
	}
	owner := func() *attachment {
		r.mu.Lock()
		defer r.mu.Unlock()
		return r.sizeOwner
	}
	first := openTestView(t, s, r, size)
	firstFrame := first.read("frame") // Intentionally never acknowledge this slow view yet.
	if control := next(); control.Type != "resize" || control.Size != size {
		t.Fatalf("first view did not set the PTY size: %+v", control)
	}
	second := openTestView(t, s, r, small)
	initial := second.read("frame")
	if !initial.Full || initial.Size != small {
		t.Fatal(initial)
	}
	second.ack(initial)
	none("a new view changed the PTY size")
	for i := 0; i < 1000; i++ {
		if _, err := r.publish(history.Event{RunID: "run-fixture", Kind: "output", Data: []byte(fmt.Sprintf("\x1b[24;1H\x1b[2KAnswer %d", i))}); err != nil {
			t.Fatal(err)
		}
	}
	for {
		m := second.read("frame")
		second.ack(m)
		if strings.Contains(string(m.Data), "Answer 999") {
			break
		}
	}
	// Input from another view moves the PTY size to that view before the input.
	second.send(protocol.Message{Type: "input", ID: "same-id", Data: []byte("typed")})
	if control := next(); control.Type != "resize" || control.Size != small {
		t.Fatalf("input did not move the PTY size first: %+v", control)
	}
	accepted := next()
	if accepted.Type != "input" || string(accepted.Data) != "typed" {
		t.Fatal(accepted)
	}
	// The receipt must reach its sender, even when another view uses the same input ID.
	// The first view must acknowledge its baseline before it sends input.
	first.send(protocol.Message{Type: "frame-ack", Revision: firstFrame.Revision})
	first.send(protocol.Message{Type: "input", ID: "same-id", Data: []byte("first")})
	if control := next(); control.Type != "resize" || control.Size != size {
		t.Fatalf("input did not return the PTY size: %+v", control)
	}
	returned := next()
	if returned.Type != "input" || string(returned.Data) != "first" {
		t.Fatal(returned)
	}
	accepted.Ack(nil)
	if m := second.read("input-ack"); m.ID != "same-id" || m.Error != "" {
		t.Fatal(m)
	}
	returned.Ack(nil)
	if m := first.read("input-ack"); m.ID != "same-id" || m.Error != "" {
		t.Fatal(m)
	}
	// Only the size owner resizes the PTY. Other views keep their own viewport.
	medium := protocol.Size{Cols: 50, Rows: 12}
	second.send(protocol.Message{Type: "resize", Size: medium})
	for {
		m := second.read("frame")
		second.ack(m)
		if m.Size == medium {
			break
		}
	}
	none("a view without the size resized the PTY")
	large := protocol.Size{Cols: 90, Rows: 30}
	first.send(protocol.Message{Type: "resize", Size: large})
	if control := next(); control.Type != "resize" || control.Size != large {
		t.Fatalf("owner resize missing: %+v", control)
	}
	// A signal reaches the process but does not move the PTY size.
	second.send(protocol.Message{Type: "signal", Signal: 2})
	if control := next(); control.Type != "signal" {
		t.Fatalf("signal changed the PTY size: %+v", control)
	}
	first.peer.Close()
	<-first.done
	r.mu.Lock()
	remaining, ended := len(r.clients), r.ended
	r.mu.Unlock()
	if remaining != 1 || owner() != nil || ended {
		t.Fatal("leaving ended work or selected another size owner")
	}
	// Without a size owner, the next view that sends its size takes it.
	second.send(protocol.Message{Type: "resize", Size: small})
	if control := next(); control.Type != "resize" || control.Size != small {
		t.Fatalf("remaining view did not take the PTY size: %+v", control)
	}
	r.finish(7, "exited", nil)
	for {
		m := second.read("frame")
		second.ack(m)
		r.mu.Lock()
		final := r.revision
		r.mu.Unlock()
		if m.Revision == final {
			break
		}
	}
	// The exit message names its run, so a view does not apply it to a later run.
	if m := second.read("exit"); m.Code != 7 || m.Status != "exited" || m.Run != "run-fixture" {
		t.Fatal(m)
	}
}

// When the process ends, a view of another size gets the saved screen as its last frame,
// as a reload shows it. A view of the terminal size gets no extra frame.
func TestEndedViewOfAnotherSizeGetsTheSavedScreen(t *testing.T) {
	size := protocol.Size{Cols: 80, Rows: 24}
	narrow := protocol.Size{Cols: 40, Rows: 10}
	r := &runningSession{id: "fixture", controls: make(chan agent.Control, 16), done: make(chan struct{}), terminal: terminal.New(size), revision: 1}
	wide := "wide row " + strings.Repeat("x", 60)
	if _, err := r.terminal.Apply(history.Event{Kind: "output", Data: []byte(wide + "\r\n")}); err != nil {
		t.Fatal(err)
	}
	s := &Server{}
	same := openTestView(t, s, r, size)
	other := openTestView(t, s, r, narrow)
	// frames returns the frames of a view until its exit message, and acknowledges each.
	frames := func(v *testView) []protocol.Message {
		t.Helper()
		var received []protocol.Message
		for {
			v.peer.SetReadDeadline(time.Now().Add(5 * time.Second))
			var m protocol.Message
			if err := v.peer.ReadJSON(&m); err != nil {
				t.Fatal(err)
			}
			switch m.Type {
			case "frame":
				received = append(received, m)
				v.ack(m)
			case "exit":
				return received
			case "error":
				t.Fatal(m.Error)
			}
		}
	}
	r.finish(0, "exited", nil)
	r.mu.Lock()
	final := r.revision
	r.mu.Unlock()
	for _, m := range frames(same) {
		if m.Revision > final {
			t.Fatalf("a view of the terminal size got an extra frame: %+v", m.Size)
		}
	}
	got := frames(other)
	last := got[len(got)-1]
	if last.Size != size || !last.Full || last.Revision != final+1 || !strings.Contains(string(last.Data), wide) {
		t.Fatalf("last frame of a narrower view: size %+v, full %v, revision %d", last.Size, last.Full, last.Revision)
	}
}

// A focus report or a mouse report reaches the process, but only user input moves the
// PTY size to its view. The server uses the frames of a view to identify its reports,
// and a mouse report names the terminal cell that the view shows.
func TestReportsDoNotChangeTheSizeOwner(t *testing.T) {
	size := protocol.Size{Cols: 80, Rows: 24}
	small := protocol.Size{Cols: 40, Rows: 10}
	r := &runningSession{id: "fixture", controls: make(chan agent.Control, 16), done: make(chan struct{}), terminal: terminal.New(size), revision: 1}
	s := &Server{}
	next := func() agent.Control {
		t.Helper()
		select {
		case control := <-r.controls:
			return control
		case <-time.After(5 * time.Second):
			t.Fatal("control missing")
			return agent.Control{}
		}
	}
	output := func(data string) {
		t.Helper()
		if _, err := r.publish(history.Event{RunID: "run-fixture", Kind: "output", Data: []byte(data)}); err != nil {
			t.Fatal(err)
		}
	}
	// shows makes the view acknowledge frames until it shows the latest state.
	shows := func(view *testView) {
		t.Helper()
		for {
			m := view.read("frame")
			view.ack(m)
			r.mu.Lock()
			latest := r.revision
			r.mu.Unlock()
			if m.Revision == latest {
				return
			}
		}
	}
	// report sends input with the report mark. It fails when the input changed the PTY
	// size before it reached the process, or when the process got other bytes than want.
	report := func(view *testView, reason, data, want string) {
		t.Helper()
		view.send(protocol.Message{Type: "input", Report: true, Data: []byte(data)})
		if control := next(); control.Type != "input" || string(control.Data) != want {
			t.Fatalf("%s: %+v", reason, control)
		}
	}
	// typed fails when the input did not move the PTY size to want first.
	typed := func(view *testView, reason string, message protocol.Message, want protocol.Size) {
		t.Helper()
		view.send(message)
		if control := next(); control.Type != "resize" || control.Size != want {
			t.Fatalf("%s: %+v", reason, control)
		}
		if control := next(); control.Type != "input" || string(control.Data) != string(message.Data) {
			t.Fatalf("%s: %+v", reason, control)
		}
	}
	first := openTestView(t, s, r, size)
	shows(first)
	if control := next(); control.Type != "resize" || control.Size != size {
		t.Fatalf("first view did not set the PTY size: %+v", control)
	}
	second := openTestView(t, s, r, small)
	shows(second)
	output("\x1b[?1004h\x1b[?1000h\x1b[?1006h")
	shows(first)
	shows(second)
	report(second, "a focus report moved the PTY size", "\x1b[I", "\x1b[I")
	report(second, "a focus report moved the PTY size", "\x1b[O", "\x1b[O")
	// The view of 10 rows shows terminal rows 15 to 24.
	report(second, "a mouse report did not name the terminal row", "\x1b[<0;3;2M", "\x1b[<0;3;16M")
	// A larger view shows padding around the terminal. The process gets no report for it.
	large := openTestView(t, s, r, protocol.Size{Cols: 100, Rows: 30})
	shows(large)
	large.send(protocol.Message{Type: "input", Report: true, Data: []byte("\x1b[<0;3;25M")})
	large.send(protocol.Message{Type: "input", Report: true, Data: []byte("\x1b[<0;81;2M")})
	large.send(protocol.Message{Type: "input", Report: true, Data: []byte("\x1b[<0;81;2m")})
	report(large, "a click in the padding reached the process", "\x1b[<0;3;24M", "\x1b[<0;3;24M")
	report(large, "the release of that click", "\x1b[<0;3;24m", "\x1b[<0;3;24m")
	// A press on a terminal cell with a release in the padding. The process gets the
	// release, on the nearest terminal cell.
	report(large, "the press at the edge", "\x1b[<0;80;2M", "\x1b[<0;80;2M")
	report(large, "the release in the padding did not reach the process", "\x1b[<0;81;2m", "\x1b[<0;80;2m")
	report(large, "the focus report after the gesture", "\x1b[O", "\x1b[O")
	// A frame between a press and its release keeps the gesture, because the frame
	// writes no mode that did not change.
	report(large, "the press at the edge", "\x1b[<0;80;2M", "\x1b[<0;80;2M")
	output("redraw")
	if redraw := large.read("frame"); redraw.Full || strings.Contains(string(redraw.Data), "\x1b[?1000") {
		t.Fatalf("the frame of a redraw resets the mouse tracking of the view: %q", redraw.Data)
	} else {
		large.ack(redraw)
	}
	report(large, "the release after a frame did not reach the process", "\x1b[<0;81;2m", "\x1b[<0;80;2m")
	// A full frame makes xterm.js stop the reports of a gesture. After the view shows
	// that frame, a motion in the padding is not a part of the earlier gesture.
	report(large, "the press at the edge", "\x1b[<0;80;2M", "\x1b[<0;80;2M")
	large.send(protocol.Message{Type: "resize", Size: protocol.Size{Cols: 100, Rows: 31}})
	shows(large)
	large.send(protocol.Message{Type: "input", Report: true, Data: []byte("\x1b[<32;81;2M")})
	report(large, "a motion in the padding after a full frame reached the process", "\x1b[O", "\x1b[O")
	shows(first)
	shows(second)
	// A receipt does not change a report. The process gets the terminal row, and the
	// view gets its receipt, also for a report that the process does not get.
	second.send(protocol.Message{Type: "input", Report: true, ID: "receipt-1", Data: []byte("\x1b[<0;3;2M")})
	receipt := next()
	if receipt.Type != "input" || string(receipt.Data) != "\x1b[<0;3;16M" {
		t.Fatalf("a report with a receipt: %+v", receipt)
	}
	receipt.Ack(nil)
	if m := second.read("input-ack"); m.ID != "receipt-1" || m.Error != "" {
		t.Fatal(m)
	}
	report(second, "the release of the report with a receipt", "\x1b[<0;3;2m", "\x1b[<0;3;16m")
	large.send(protocol.Message{Type: "input", Report: true, ID: "receipt-2", Data: []byte("\x1b[<0;81;2M")})
	if m := large.read("input-ack"); m.ID != "receipt-2" || m.Error != "" {
		t.Fatal(m)
	}
	// A resize of a view without the size still does not reach the PTY.
	wider := protocol.Size{Cols: 42, Rows: 10}
	second.send(protocol.Message{Type: "resize", Size: wider})
	shows(second)
	report(first, "a report from the size owner changed the PTY size", "\x1b[I", "\x1b[I")
	// The view makes a report from the frame that it shows. The application turns focus
	// reporting off, but the view did not acknowledge that frame.
	output("\x1b[?1004l")
	held := second.read("frame")
	report(second, "a report of the shown frame moved the PTY size", "\x1b[O", "\x1b[O")
	second.ack(held)
	// The view did not acknowledge the frame that turns focus reporting on, and the
	// application turns it off again.
	output("\x1b[?1004h")
	held = second.read("frame")
	output("\x1b[?1004l")
	report(second, "a report of the frame in transit moved the PTY size", "\x1b[I", "\x1b[I")
	second.ack(held)
	shows(second)
	// Typed input moves the PTY size to its view first.
	typed(second, "typed input did not move the PTY size first", protocol.Message{Type: "input", Data: []byte("x")}, wider)
	// Marked input is user input when the frames of the view have the mode off.
	shows(first)
	typed(first, "input without the focus mode did not move the PTY size", protocol.Message{Type: "input", Report: true, Data: []byte("\x1b[I")}, size)
	// A paste has no report mark. It is user input, also when it has the bytes of a
	// report. The process and the record get the bytes of the paste: not another row,
	// and also a position outside the terminal.
	output("\x1b[?1004h")
	shows(first)
	shows(second)
	shows(large)
	typed(second, "a paste did not move the PTY size", protocol.Message{Type: "input", Data: []byte("\x1b[<0;3;2M")}, wider)
	typed(large, "a paste with a position in the padding", protocol.Message{Type: "input", Data: []byte("\x1b[<0;81;2M")}, protocol.Size{Cols: 100, Rows: 31})
	typed(second, "a paste with the bytes of a focus report", protocol.Message{Type: "input", Data: []byte("\x1b[I")}, wider)
	typed(first, "a message with the bytes of a focus report", protocol.Message{Type: "input", ID: "draft-1", Data: []byte("\x1b[I")}, size)
}

func TestEndedScreenCacheAndArchiveReconstruction(t *testing.T) {
	store, err := history.Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	session, err := store.CreateSession("fixture", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{store: store}
	r := &runningSession{id: session.ID, terminal: terminal.New(protocol.Size{Cols: 28, Rows: 8})}
	for _, event := range []history.Event{{Kind: "start", Data: []byte(`{"cols":28,"rows":8}`)}, {Kind: "output", Data: []byte("\x1b[2J\x1b[HWorking\r\x1b[2KAnswer: café 你好\r\n\x1b[6n")}, {Kind: "input", Data: []byte("NEVER REPLAY")}} {
		recorded, err := store.Append(session.ID, "run", event.Kind, event.Data, "")
		if err != nil {
			t.Fatal(err)
		}
		if event.Kind != "input" {
			r.publish(recorded)
		}
	}
	for _, cached := range []bool{false, true} {
		if cached {
			if err := s.saveScreen(r); err != nil {
				t.Fatal(err)
			}
		}
		view, err := s.loadScreen(session.ID, "run")
		if err != nil {
			t.Fatal(err)
		}
		data, _ := view.Render(nil)
		if !strings.Contains(string(data), "Answer: café 你好") || strings.Contains(string(data), "Working") || strings.Contains(string(data), "NEVER REPLAY") || strings.Contains(string(data), "[6n") {
			t.Fatalf("cached=%v: %q", cached, data)
		}
	}
}

// A narrow terminal keeps more than 10,000 history rows. Its saved screen must load.
func TestSavedScreenKeepsTheRowLimitOfItsWidth(t *testing.T) {
	store, err := history.Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	session, err := store.CreateSession("fixture", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{store: store}
	r := &runningSession{id: session.ID, terminal: terminal.New(protocol.Size{Cols: 40, Rows: 8})}
	var out strings.Builder
	for i := range 30000 {
		fmt.Fprintf(&out, "row %05d\r\n", i)
	}
	r.terminal.Apply(history.Event{Kind: "output", Data: []byte(out.String())})
	if err = s.saveScreen(r); err != nil {
		t.Fatal(err)
	}
	view, err := s.loadScreen(session.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(view.History) != terminal.ScrollbackRows(40) {
		t.Fatalf("saved screen has %d history rows, want %d", len(view.History), terminal.ScrollbackRows(40))
	}
	// A saved screen with more rows than the limit of its width loads with the newest
	// rows. A rejected screen could not show its session.
	wide := &terminal.View{Size: protocol.Size{Cols: 120, Rows: 2}, Lines: []string{"a", "b"}, Offset: 5}
	for i := range terminal.ScrollbackRows(120) + 1 {
		wide.History = append(wide.History, fmt.Sprintf("row %05d", i))
	}
	data, err := json.Marshal(savedScreen{Format: 1, View: wide})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Append(session.ID, "wide", "terminal-screen", data, ""); err != nil {
		t.Fatal(err)
	}
	if view, err = s.loadScreen(session.ID, "wide"); err != nil {
		t.Fatal(err)
	}
	if len(view.History) != terminal.ScrollbackRows(120) || view.History[0] != "row 00001" || view.Offset != 6 {
		t.Fatalf("wide saved screen has %d history rows from %q at offset %d", len(view.History), view.History[0], view.Offset)
	}
}

// Each run has its own terminal. An interrupted later run must not show the saved
// screen of an earlier run, and replay must not mix the output of two runs.
func TestEachRunReplaysOnlyItsOwnTerminal(t *testing.T) {
	store, err := history.Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	session, err := store.CreateSession("fixture", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{store: store}
	first := &runningSession{id: session.ID, terminal: terminal.New(protocol.Size{Cols: 30, Rows: 6})}
	for _, event := range []history.Event{{Kind: "start", Data: []byte(`{"cols":30,"rows":6}`)}, {Kind: "output", Data: []byte("FIRST TERMINAL\r\n")}} {
		recorded, err := store.Append(session.ID, "first", event.Kind, event.Data, "")
		if err != nil {
			t.Fatal(err)
		}
		first.publish(recorded)
	}
	if err = s.saveScreen(first); err != nil {
		t.Fatal(err)
	}
	// The second run has no saved screen, as after a server crash.
	for _, event := range []history.Event{{Kind: "start", Data: []byte(`{"cols":40,"rows":5}`)}, {Kind: "output", Data: []byte("SECOND TERMINAL\r\n")}} {
		if _, err := store.Append(session.ID, "second", event.Kind, event.Data, ""); err != nil {
			t.Fatal(err)
		}
	}
	for _, check := range []struct{ run, want, other string }{{"first", "FIRST TERMINAL", "SECOND"}, {"second", "SECOND TERMINAL", "FIRST"}} {
		view, err := s.loadScreen(session.ID, check.run)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := view.Render(nil)
		if !strings.Contains(string(data), check.want) || strings.Contains(string(data), check.other) {
			t.Fatalf("run %s: %q", check.run, data)
		}
	}
}
