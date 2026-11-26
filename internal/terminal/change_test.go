package terminal

import (
	"strings"
	"testing"

	"bbflow/internal/history"
	"bbflow/internal/protocol"
	xterm "github.com/eugenioenko/xterm-go"
)

// ApplyChange tells whether an output changed what a view shows. Agent CLIs write output
// that changes nothing while they wait, such as a frame that only puts the cursor back.
func TestApplyChangeComparesWhatAViewShows(t *testing.T) {
	captureLog(t)
	state := New(protocol.Size{Cols: 40, Rows: 6})
	state.term.RegisterCsiHandler(xterm.FunctionIdentifier{Final: 'z'}, func(*xterm.Params) bool { panic("injected") })
	step := func(reason, output string, want bool) {
		t.Helper()
		if _, changed, err := state.ApplyChange(history.Event{Kind: "output", Data: []byte(output)}); err != nil || changed != want {
			t.Fatalf("%s: changed is %v, %v, expected %v", reason, changed, err, want)
		}
	}
	apply := func(kind, data string) {
		t.Helper()
		if _, err := state.Apply(history.Event{Kind: kind, Data: []byte(data)}); err != nil {
			t.Fatal(err)
		}
	}
	step("new characters", "prompt> ", true)
	// Codex 0.172.0 writes this frame about every 15 seconds while it waits for input.
	step("a frame that puts the cursor back", "\x1b[?2026h\x1b[39m\x1b[49m\x1b[0m\x1b[1;9H\x1b[?25h\x1b[?2026l", false)
	step("a cursor move", "\x1b[4;5H", false)
	step("the cursor, a title, a bell, and input modes", "\x1b[?25l\x1b]0;✳ title\x07\x07\x1b[?2004h\x1b[?1004h\x1b(B\x1b[?25h", false)
	step("a query", "\x1b[6n\x1b[c", false)
	step("the same characters again", "\x1b[1;1Hprompt> ", false)
	step("a style", "\x1b[1;1H\x1b[1mprompt> \x1b[0m", true)
	step("a color", "\x1b[1;1H\x1b[31mprompt> \x1b[0m", true)
	step("an underline", "\x1b[1;1H\x1b[31;4mp\x1b[0m", true)
	step("an underline style", "\x1b[1;1H\x1b[31;4:3mp\x1b[0m", true)
	step("the same underline style", "\x1b[1;1H\x1b[31;4:3mp\x1b[0m", false)
	// Other cell attributes can draw the same row.
	step("red text", "\x1b[5;1H\x1b[31mred\x1b[0m", true)
	step("the same red in another SGR form", "\x1b[5;1H\x1b[38;5;1mred\x1b[0m", false)
	step("the same red in protected cells", "\x1b[5;1H\x1b[31m\x1b[1\"qred\x1b[0\"q\x1b[0m", false)
	step("one cell of the red text in another SGR form", "\x1b[5;2H\x1b[38;5;1me\x1b[0m", false)
	step("the cell in the first SGR form again", "\x1b[5;2H\x1b[31me\x1b[0m", false)
	step("text that the output also erases", "\x1b[3;1Hnotice\x1b[3;1H\x1b[K", false)
	// Claude Code shows a notice in its footer, and it erases the notice later.
	step("a notice", "\x1b[3;1Hnotice", true)
	step("an erased notice", "\x1b[3;1H\x1b[K", true)
	// Output that writes the same row again and again still adds history rows.
	step("rows that fill the screen", "\x1b[6;1H"+strings.Repeat("\r\ny", 6), true)
	step("the same row again", "\r\ny", true)

	// After Apply, ApplyChange compares with the screen before its own event.
	apply("output", "typed")
	step("a frame after the echo of typed input", "\x1b[?25h", false)
	apply("resize", `{"cols":30,"rows":8}`)
	step("a frame after a size change", "\x1b[1;1H\x1b[?25h", false)
	step("text after a size change", "x", true)

	step("the alternate screen", "\x1b[?1049h", true)
	step("a frame on the alternate screen", "\x1b[2;2H", false)
	step("text on the alternate screen", "menu", true)
	step("the normal screen", "\x1b[?1049l", true)

	// A reset after an emulator panic gives a blank screen.
	step("a reset", "\x1b[z", true)
	step("a frame after a reset", "\x1b[1;1H", false)
}

// An erase of the history changes the history rows of a view, but not the screen rows.
func TestApplyChangeFindsAnEraseOfTheHistory(t *testing.T) {
	state := New(protocol.Size{Cols: 10, Rows: 2})
	step := func(reason, output string, want bool, history int) {
		t.Helper()
		_, changed, err := state.ApplyChange(historyEvent(output))
		if got := len(state.View().History); err != nil || changed != want || got != history {
			t.Fatalf("%s: changed is %v, %v, with %d history rows, expected %v with %d", reason, changed, err, got, want, history)
		}
	}
	step("four rows", "1\r\n2\r\n3\r\n4", true, 2)
	step("an erase of the history", "\x1b[3J", true, 0)
	step("an erase of an empty history", "\x1b[3J", false, 0)
}

// SameAsMark finds output that changes what a view shows and then changes it back.
// Claude Code 2.1.332 shows "Checking for updates…" in its footer every 30 minutes, and
// it erases the notice about 0.2 seconds later.
func TestSameAsMarkFindsAChangeThatIsChangedBack(t *testing.T) {
	state := New(protocol.Size{Cols: 40, Rows: 6})
	apply := func(kind, data string) {
		t.Helper()
		if _, err := state.Apply(history.Event{Kind: kind, Data: []byte(data)}); err != nil {
			t.Fatal(err)
		}
	}
	check := func(reason string, want bool) {
		t.Helper()
		if got := state.SameAsMark(); got != want {
			t.Fatalf("%s: SameAsMark is %v, expected %v", reason, got, want)
		}
	}
	check("a state without a mark", false)
	apply("output", "prompt> ")
	state.Mark()
	check("the marked screen", true)
	apply("output", "\x1b[?25l\x1b[5;20H\x1b[?25h\x07")
	check("a cursor move and a bell", true)
	apply("output", "\x1b7\x1b[5;20H\x1b[38;2;153;153;153mChecking for updates…\x1b[39m\x1b8")
	check("a notice", false)
	apply("output", "\x1b7\x1b[5;20H\x1b[K\x1b8")
	check("the erased notice", true)
	apply("output", "\x1b[1;1H\x1b[31mprompt> \x1b[0m")
	check("a color", false)
	apply("output", "\x1b[1;1H\x1b[38;5;1mprompt> \x1b[0m")
	check("the same color in another SGR form", false)
	apply("output", "\x1b[1;1Hprompt> ")
	check("the color changed back", true)
	apply("output", "\x1b[?1049hmenu")
	check("a menu on the alternate screen", false)
	apply("output", "\x1b[?1049l")
	check("the closed menu", true)
	// New rows in history stay a change.
	apply("output", "\x1b[6;1H\n")
	check("a new row in history", false)
	state.Mark()
	apply("resize", `{"cols":30,"rows":6}`)
	check("a size change", false)
}

// The comparison of an unchanged screen allocates nothing, also for a row with cells
// that have extended attributes before plain cells.
func TestCompareScreenAllocatesNothing(t *testing.T) {
	state := New(protocol.Size{Cols: 40, Rows: 6})
	if _, _, err := state.ApplyChange(historyEvent("\x1b[4:3mcurly\x1b[0m plain\r\n\x1b[58;5;2;4mcolored\x1b[0m plain")); err != nil {
		t.Fatal(err)
	}
	if allocs := testing.AllocsPerRun(100, func() { state.compareScreen() }); allocs != 0 {
		t.Fatalf("the comparison of an unchanged screen made %v allocations", allocs)
	}
	state.Mark()
	if allocs := testing.AllocsPerRun(100, func() { state.Mark(); state.SameAsMark() }); allocs != 0 {
		t.Fatalf("a mark and a comparison of an unchanged screen made %v allocations", allocs)
	}
}

func historyEvent(output string) history.Event {
	return history.Event{Kind: "output", Data: []byte(output)}
}
