package terminal

import (
	"testing"

	"bbflow/internal/history"
	"bbflow/internal/protocol"
)

const (
	focusIn  = "\x1b[I"
	sgrClick = "\x1b[<35;12;7M"
	x10Click = "\x1b[M !!"
)

func TestReportsUseTheModesOfTheFrame(t *testing.T) {
	state := New(protocol.Size{Cols: 80, Rows: 24})
	set := func(modes string) {
		t.Helper()
		if _, err := state.Apply(history.Event{Kind: "output", Data: []byte(modes)}); err != nil {
			t.Fatal(err)
		}
	}
	check := func(reason, data string, want bool) {
		t.Helper()
		out, got := state.View().Reports.Translate([]byte(data))
		if got != want {
			t.Fatalf("%s: Translate(%q) = %q, %v", reason, data, out, got)
		}
		// A view of the same size as the terminal needs no other position.
		if got && string(out) != data {
			t.Fatalf("%s: Translate(%q) changed the report to %q", reason, data, out)
		}
	}
	// The application did not ask for reports.
	for _, data := range []string{focusIn, "\x1b[O", sgrClick, x10Click} {
		check("no mode is on", data, false)
	}
	set("\x1b[?1004h")
	check("focus reporting is on", focusIn, true)
	check("focus reporting is on", "\x1b[O", true)
	check("focus reporting is on", "\x1b[O"+focusIn, true)
	check("mouse tracking is off", sgrClick, false)
	check("mouse tracking is off", focusIn+sgrClick, false)
	for _, data := range []string{"", "a", "\r", "\x1b[A", "\x1b[Ia", "a" + focusIn, "\x1b[200~" + focusIn + "\x1b[201~"} {
		check("user input", data, false)
	}
	set("\x1b[?1004l\x1b[?1003h\x1b[?1006h")
	check("focus reporting is off", focusIn, false)
	for _, data := range []string{sgrClick, "\x1b[<0;1;1m", sgrClick + sgrClick, x10Click, "\x1b[M\xff\x70\x37"} {
		check("mouse tracking is on", data, true)
	}
	for _, data := range []string{"\x1b[<35;12M", "\x1b[<35;12;7", "\x1b[<;12;7M", "\x1b[<35;12;7x", "\x1b[M !", sgrClick + "a", "\x1b[<", "\x1b[<0;123456;1M"} {
		check("not a complete mouse report", data, false)
	}
	set("\x1b[?1004h")
	check("both modes are on", focusIn+sgrClick+x10Click, true)
	set("\x1b[?1003l")
	check("mouse tracking is off again", sgrClick, false)
}

// A view with fewer rows shows the last rows of the terminal. A larger view shows
// padding around the terminal. A mouse report must name the terminal cell under the
// pointer, or the PTY must not get it.
func TestMouseReportsNameTheTerminalCellOfTheView(t *testing.T) {
	state := New(protocol.Size{Cols: 80, Rows: 24})
	if _, err := state.Apply(history.Event{Kind: "output", Data: []byte("\x1b[?1004h\x1b[?1000h\x1b[?1006h")}); err != nil {
		t.Fatal(err)
	}
	check := func(reason string, reports Reports, data, want string) {
		t.Helper()
		out, ok := reports.Translate([]byte(data))
		if !ok || string(out) != want {
			t.Fatalf("%s: Translate(%q) = %q, %v, want %q", reason, data, out, ok, want)
		}
	}
	small := state.ViewFor(protocol.Size{Cols: 40, Rows: 10}, nil).Reports
	if small.Top != 14 {
		t.Fatalf("a view of 10 rows starts at terminal row %d", small.Top)
	}
	check("row 2 of the view is terminal row 16", small, "\x1b[<0;3;2M", "\x1b[<0;3;16M")
	check("the last row of the view is the last terminal row", small, "\x1b[<0;40;10m", "\x1b[<0;40;24m")
	check("the default encoding", small, "\x1b[M\x20\x23\x22", "\x1b[M\x20\x23\x30")
	check("a focus report has no position", small, focusIn, focusIn)
	check("each report of one input", small, focusIn+"\x1b[<0;3;2M\x1b[<0;3;2m", focusIn+"\x1b[<0;3;16M\x1b[<0;3;16m")

	large := state.ViewFor(protocol.Size{Cols: 100, Rows: 30}, nil).Reports
	check("a cell of the terminal", large, "\x1b[<0;80;24M", "\x1b[<0;80;24M")
	check("padding below the terminal", large, "\x1b[<0;3;25M", "")
	check("padding at the right of the terminal", large, "\x1b[<0;81;2M", "")
	check("padding in the default encoding", large, "\x1b[M\x20\x71\x22", "")
	check("only the report inside the terminal stays", large, "\x1b[<0;81;2M\x1b[<0;80;2M", "\x1b[<0;80;2M")
	check("position 0 is not a cell", large, "\x1b[<0;0;0M", "")

	// The server cannot change a row in pixels.
	if _, err := state.Apply(history.Event{Kind: "output", Data: []byte("\x1b[?1016h")}); err != nil {
		t.Fatal(err)
	}
	check("a pixel report of a view without the first row", state.ViewFor(protocol.Size{Cols: 40, Rows: 10}, nil).Reports, "\x1b[<0;30;20M", "")
	check("a pixel report of a view with the first row", state.ViewFor(protocol.Size{Cols: 100, Rows: 30}, nil).Reports, "\x1b[<0;900;700M", "\x1b[<0;900;700M")

	// The default encoding has no byte for a row after 223.
	tall := New(protocol.Size{Cols: 80, Rows: 250})
	if _, err := tall.Apply(history.Event{Kind: "output", Data: []byte("\x1b[?1000h")}); err != nil {
		t.Fatal(err)
	}
	check("a row that the default encoding cannot hold", tall.ViewFor(protocol.Size{Cols: 80, Rows: 10}, nil).Reports, "\x1b[M\x20\x23\x22", "")
}
