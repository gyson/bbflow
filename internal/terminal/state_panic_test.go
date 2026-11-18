package terminal

import (
	"bytes"
	"fmt"
	"log"
	"strings"
	"testing"

	"bbflow/internal/history"
	"bbflow/internal/protocol"
	xterm "github.com/eugenioenko/xterm-go"
)

// captureLog sends the standard logger to a buffer until the test ends.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buffer bytes.Buffer
	output, flags := log.Writer(), log.Flags()
	log.SetOutput(&buffer)
	t.Cleanup(func() { log.SetOutput(output); log.SetFlags(flags) })
	return &buffer
}

// bbflow 0.0.11 stopped when a shrink reflowed more rows than the scrollback holds
// (gitpod-io/xterm-go issue 61). The emulator must drop the oldest rows and keep the
// newest output, without the panic recovery.
func TestApplyOverflowingShrinkKeepsNewestOutput(t *testing.T) {
	logged := captureLog(t)
	for _, cols := range []int{80, 40, 20} {
		s := New(protocol.Size{Cols: 153, Rows: 34})
		for i := range Scrollback + 100 {
			s.Apply(history.Event{Kind: "output", Data: fmt.Appendf(nil, "L%05d%s\r\n", i, strings.Repeat(".", 140))})
		}
		s.Apply(history.Event{Kind: "output", Data: []byte("TAILMARK\r\n")})
		if _, err := s.Apply(history.Event{Kind: "resize", Data: fmt.Appendf(nil, `{"rows":6,"cols":%d}`, cols)}); err != nil {
			t.Fatal(err)
		}
		if got, want := s.Size(), (protocol.Size{Cols: uint16(cols), Rows: 6}); got != want {
			t.Fatalf("size %v, want %v", got, want)
		}
		if logged.Len() > 0 {
			t.Fatalf("%d columns: the emulator panicked:\n%s", cols, logged)
		}
		text := s.View().PlainText()
		if !strings.Contains(text, "TAILMARK") || !strings.Contains(text, fmt.Sprintf("L%05d", Scrollback+99)) {
			t.Fatalf("%d columns: the newest output is not in the view; tail:\n%s", cols, text[max(0, len(text)-300):])
		}
	}
}

// An emulator panic must stay inside Apply. The terminal starts again blank at the
// requested size and continues to work.
func TestApplyRecoversFromEmulatorPanic(t *testing.T) {
	logged := captureLog(t)
	s := New(protocol.Size{Cols: 80, Rows: 24})
	s.term.RegisterCsiHandler(xterm.FunctionIdentifier{Final: 'z'}, func(*xterm.Params) bool { panic("injected") })
	before := s.View().Epoch
	responses, err := s.Apply(history.Event{SessionID: "s1", Seq: 7, Kind: "output", Data: []byte("before\x1b[6n\x1b[z")})
	if err != nil || responses != nil {
		t.Fatalf("Apply returned %q, %v after an emulator panic", responses, err)
	}
	if !strings.Contains(logged.String(), "session s1: terminal emulator panic at event 7 (output)") || !strings.Contains(logged.String(), "injected") {
		t.Fatalf("log does not report the panic:\n%s", logged)
	}
	if _, err := s.Apply(history.Event{Kind: "resize", Data: []byte(`{"rows":10,"cols":40}`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Apply(history.Event{Kind: "output", Data: []byte("after")}); err != nil {
		t.Fatal(err)
	}
	view := s.View()
	if view.Size != (protocol.Size{Cols: 40, Rows: 10}) || view.Epoch <= before {
		t.Fatalf("size %v epoch %d after the reset, want 40x10 and an epoch after %d", view.Size, view.Epoch, before)
	}
	if text := view.PlainText(); strings.Contains(text, "before") || !strings.Contains(text, "after") {
		t.Fatalf("view after the reset: %q", text)
	}
	// The new emulator keeps the query reply handler.
	if responses, _ := s.Apply(history.Event{Kind: "output", Data: []byte("\x1b[6n")}); len(responses) == 0 {
		t.Fatal("no reply to a cursor position query after the reset")
	}
}

// A panic during a resize resets the terminal to the requested size. The PTY and the
// views already use that size.
func TestApplyPanicDuringResizeKeepsRequestedSize(t *testing.T) {
	captureLog(t)
	s := New(protocol.Size{Cols: 80, Rows: 24})
	s.term.OnResize(func(xterm.BufferResizeEvent) { panic("injected") })
	if _, err := s.Apply(history.Event{Kind: "resize", Data: []byte(`{"rows":6,"cols":20}`)}); err != nil {
		t.Fatal(err)
	}
	if got, want := s.Size(), (protocol.Size{Cols: 20, Rows: 6}); got != want {
		t.Fatalf("size %v, want %v", got, want)
	}
}
