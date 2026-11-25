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
