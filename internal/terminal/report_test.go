package terminal

import (
	"testing"

	"bbflow/internal/history"
	"bbflow/internal/protocol"
)

func TestIsReportUsesTheModesOfTheApplication(t *testing.T) {
	const focus, sgr, x10 = "\x1b[I", "\x1b[<35;12;7M", "\x1b[M !!"
	state := New(protocol.Size{Cols: 80, Rows: 24})
	set := func(modes string) {
		t.Helper()
		if _, err := state.Apply(history.Event{Kind: "output", Data: []byte(modes)}); err != nil {
			t.Fatal(err)
		}
	}
	check := func(reason, data string, want bool) {
		t.Helper()
		if got := state.IsReport([]byte(data)); got != want {
			t.Fatalf("%s: IsReport(%q) = %v", reason, data, got)
		}
	}
	// The application did not ask for reports.
	for _, data := range []string{focus, "\x1b[O", sgr, x10} {
		check("no mode is on", data, false)
	}
	set("\x1b[?1004h")
	check("focus reporting is on", focus, true)
	check("focus reporting is on", "\x1b[O", true)
	check("focus reporting is on", "\x1b[O"+focus, true)
	check("mouse tracking is off", sgr, false)
	check("mouse tracking is off", focus+sgr, false)
	for _, data := range []string{"", "a", "\r", "\x1b[A", "\x1b[Ia", "a" + focus, "\x1b[200~" + focus + "\x1b[201~"} {
		check("user input", data, false)
	}
	set("\x1b[?1004l\x1b[?1003h\x1b[?1006h")
	check("focus reporting is off", focus, false)
	for _, data := range []string{sgr, "\x1b[<0;1;1m", sgr + sgr, x10, "\x1b[M\xff\xa0\xa1"} {
		check("mouse tracking is on", data, true)
	}
	for _, data := range []string{"\x1b[<35;12M", "\x1b[<35;12;7", "\x1b[<;12;7M", "\x1b[<35;12;7x", "\x1b[M !", sgr + "a", "\x1b[<"} {
		check("not a complete mouse report", data, false)
	}
	set("\x1b[?1004h")
	check("both modes are on", focus+sgr+x10, true)
	set("\x1b[?1003l")
	check("mouse tracking is off again", sgr, false)
}
