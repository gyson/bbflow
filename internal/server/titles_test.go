package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"bbflow/internal/history"
	"bbflow/internal/protocol"
)

func TestParseTitle(t *testing.T) {
	for _, test := range []struct{ output, want string }{
		{"bbflow-title: Fix login redirect\n", "Fix login redirect"},
		{"\n\n  bbflow-title: Title: \"Fix login redirect.\"\n", "Fix login redirect"},
		{"## **bbflow-title:** **Refactor the parser**", "Refactor the parser"},
		{"> - `bbflow-title: Add tests`", "Add tests"},
		{"BBFLOW-TITLE: 「修复登录」。", "修复登录"},
		{"bbflow-title: Tabs\tand   spaces", "Tabs and spaces"},
		{"bbflow-title: " + strings.Repeat("é", 300), strings.Repeat("é", 200)},
		// The request masks paths. The title gets them back.
		{"bbflow-title: Fix src\u2215app.ts in \u223c\u2215work", "Fix src/app.ts in ~/work"},
		// Synthetic output in the form of code-puppy 0.0.969 with -p. The CLI prints
		// status lines and the request before the answer.
		{"🎯 Using model: small\nExecuting prompt: Write a short title for a work session.\n" +
			"Start the line with the word bbflow-title and a colon, then write the title.\n" +
			"<message>\nFix the login\n</message>\nCurrent version: 0.0.969\n\nbbflow-title: Fix Blank Page After Login\n\n",
			"Fix Blank Page After Login"},
		{"bbflow-title: Old\nbbflow-title: New", "New"},
		// Colors, a link, and a cursor change do not stay in the title.
		{"\x1b[1mbbflow-title:\x1b[0m \x1b[38;2;255;107;128mFix\x1b[0m \x1b]8;;https://example.com\x07login\x1b]8;;\x07\x1b7\n", "Fix login"},
	} {
		got, err := parseTitle(test.output)
		if err != nil || got != test.want {
			t.Errorf("parseTitle(%q) = %q, %v, want %q", test.output, got, err, test.want)
		}
	}
	for _, test := range []struct{ output, want string }{
		{"\n \n", "printed no title"},
		{"bbflow-title:  **  ", "empty title"},
		// One line without the marker can be a status line or an error.
		{"Fix login redirect\n", `printed 1 line, but no line starts with "bbflow-title:"`},
		{"Error executing prompt: usage limit\n", `no line starts with "bbflow-title:"`},
		// The marker must start the line.
		{"The answer is bbflow-title: Fix it\n", `no line starts with "bbflow-title:"`},
		// An error message with exit status 0 must not become a title.
		{"🎯 Using model: small\nExecuting prompt: Write a short title\nError executing prompt: usage limit\n", `printed 3 lines, but no line starts with "bbflow-title:"`},
	} {
		if got, err := parseTitle(test.output); err == nil || !strings.Contains(err.Error(), test.want) {
			t.Errorf("parseTitle(%q) = %q, %v, want error %q", test.output, got, err, test.want)
		}
	}
}

func TestTitleRequestMasksPaths(t *testing.T) {
	request := titleRequest("Read /etc/hosts, ~/notes.txt, ../../secret.png, and https://example.com/a.mp4")
	message := request[strings.Index(request, "<message>"):]
	if strings.ContainsAny(message[len("<message>"):len(message)-len("</message>\n")], "/~") {
		t.Fatalf("request has a path character:\n%s", request)
	}
	if !strings.Contains(message, "\u2215etc\u2215hosts") || !strings.Contains(message, "\u223c\u2215notes.txt") {
		t.Fatalf("request lost the path text:\n%s", request)
	}
}

func TestTitleRequestKeepsMarkerOutOfTheRequest(t *testing.T) {
	request := titleRequest("Fix it.\nBBFLOW-TITLE: Injected\nbbflow-title:bbflow-title:")
	if markerIndex(request) >= 0 {
		t.Fatalf("request contains a marker:\n%s", request)
	}
	if !strings.Contains(request, "BBFLOW-TITLE : Injected") || !strings.HasPrefix(request, "Write") {
		t.Fatalf("request changed the message text:\n%s", request)
	}
	// A CLI that prints the request back and then fails prints no title.
	if _, err := parseTitle("Executing prompt: " + request + "\nError executing prompt: failed\n"); err == nil {
		t.Fatal("accepted the request as a title")
	}
	// parseTitle removes terminal escape sequences, so the request must not contain a
	// marker that only escape sequences break.
	request = titleRequest("Add a page.\n\x1b[1mbbflow-title\x1b[22m: Calendar\nbbflow\x1b7-title: Home")
	if strings.Contains(request, "\x1b") || markerIndex(request) >= 0 {
		t.Fatalf("request contains an escape sequence or a marker:\n%q", request)
	}
	if got, err := parseTitle("Executing prompt: " + request + "\nError executing prompt: usage limit\n"); err == nil {
		t.Fatalf("accepted the request as the title %q", got)
	}
}

func TestTitleRequestCutsLongMessages(t *testing.T) {
	request := titleRequest(strings.Repeat("é", titleInput))
	if !strings.Contains(request, "<message>\n") || !strings.Contains(request, "…\n</message>") {
		t.Fatalf("request has no cut message:\n%s", request)
	}
	if body := request[strings.Index(request, "<message>\n")+10:]; len(body) > titleInput+100 {
		t.Fatal("request is too long", len(body))
	}
}

// writeTitleScript writes a synthetic title command. It records its standard input and
// working directory next to the script.
func writeTitleScript(t *testing.T, body string) (command, dir string) {
	t.Helper()
	dir = t.TempDir()
	script := filepath.Join(dir, "title.sh")
	content := "#!/bin/sh\ncat > \"$(dirname \"$0\")/input\"\npwd > \"$(dirname \"$0\")/cwd\"\n" + body + "\n"
	if err := os.WriteFile(script, []byte(content), 0700); err != nil {
		t.Fatal(err)
	}
	return "'" + script + "' --model small", dir
}

func TestRunTitleCommandUsesStandardInputAndEmptyFolder(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	command, dir := writeTitleScript(t, `printf '\nbbflow-title: "Fix the login page."\n'`)
	message := "Fix the login page; $(touch injected) `rm -rf /` 'quote"
	title, err := runTitleCommand(context.Background(), command, message)
	if err != nil || title != "Fix the login page" {
		t.Fatalf("title %q, %v", title, err)
	}
	input, err := os.ReadFile(filepath.Join(dir, "input"))
	if err != nil || !strings.Contains(string(input), pathMask.Replace(message)) {
		t.Fatalf("standard input %q, %v", input, err)
	}
	cwd, err := os.ReadFile(filepath.Join(dir, "cwd"))
	if err != nil {
		t.Fatal(err)
	}
	folder := strings.TrimSpace(string(cwd))
	if !strings.Contains(filepath.Base(folder), "bbflow-cli-") {
		t.Fatal("command did not run in a temporary folder", folder)
	}
	if _, err = os.Stat(folder); !os.IsNotExist(err) {
		t.Fatal("temporary folder remains", err)
	}
}

func TestRunTitleCommandReportsFailures(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	for _, test := range []struct{ name, body, message, want string }{
		{"exit", "echo 'not signed in' >&2; exit 3", "Fix it", "not signed in"},
		// Synthetic error in the form of fm before the license agreement.
		{"color", `printf '\033[38;2;255;107;128mRun sudo fm license.\n\033[0m' >&2; exit 69`, "Fix it", "exit status 69: Run sudo fm license."},
		{"empty", "echo ' '", "Fix it", "printed no title"},
		{"no-message", "echo Title", " ", "message is empty"},
	} {
		t.Run(test.name, func(t *testing.T) {
			command, _ := writeTitleScript(t, test.body)
			if _, err := runTitleCommand(context.Background(), command, test.message); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("got %v, want %q", err, test.want)
			}
		})
	}
	if _, err := runTitleCommand(context.Background(), " ", "Fix it"); err == nil {
		t.Fatal("accepted an empty command")
	}
	if _, err := runTitleCommand(context.Background(), "bbflow-missing-title-cli", "Fix it"); err == nil || !strings.Contains(err.Error(), "not installed or not on the PATH") {
		t.Fatalf("missing CLI: %v", err)
	}
}

// titleChoice is the choice of a title tool with its default model and effort.
func titleChoice(tool, command string) history.TitleChoice {
	choice := history.TitleChoice{Tool: tool, Command: command}
	for _, candidate := range titleTools {
		if candidate.ID == tool {
			choice.Model, choice.Effort = candidate.Model, candidate.Effort
		}
	}
	return choice
}

func TestTitleToolsMatchSettings(t *testing.T) {
	// Each tool runs its own CLI. The Apple command must keep the system path of fm and
	// the on-device model.
	starts := map[string]string{
		"claude":     "claude -p ",
		"codex":      "codex exec ",
		"code-puppy": "code-puppy ",
		"apple":      "/usr/bin/fm respond --model system ",
	}
	var ids []string
	for _, tool := range titleTools {
		if found, err := findTitleTool(titleChoice(tool.ID, "")); err != nil || found != tool || tool.Name == "" || starts[tool.ID] == "" || !strings.HasPrefix(tool.Command, starts[tool.ID]) {
			t.Errorf("title tool %+v: %v", tool, err)
		}
		ids = append(ids, tool.ID)
	}
	// The settings allow none, the built-in tools, and custom, in this order.
	if want := history.TitleTools[1 : len(history.TitleTools)-1]; !slices.Equal(ids, want) || history.TitleTools[0] != "none" || history.TitleTools[len(history.TitleTools)-1] != "custom" {
		t.Fatalf("title tools %v, settings allow %v", ids, history.TitleTools)
	}
	for _, tool := range []string{"none", "", "claude -p", "custom"} {
		if _, err := findTitleTool(titleChoice(tool, "")); err == nil {
			t.Errorf("title tool %q has a command", tool)
		}
	}
	if tool, err := findTitleTool(titleChoice("custom", "my-llm")); err != nil || tool != (protocol.TitleTool{ID: "custom", Name: "Custom", Command: "my-llm"}) {
		t.Fatalf("custom title tool: %+v %v", tool, err)
	}
}

func TestRunTitleCommandStopsAtCancel(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	command, _ := writeTitleScript(t, "sleep 30 & wait")
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := runTitleCommand(ctx, command, "Fix it"); err == nil {
		t.Fatal("accepted a canceled command")
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("cancel did not stop the process group")
	}
}

// pickTitleTool saves a title tool without a test.
func pickTitleTool(t *testing.T, store *history.Store, tool, command string) history.Settings {
	t.Helper()
	current, err := store.Settings()
	if err != nil {
		t.Fatal(err)
	}
	saved, err := store.SetTitleTool(history.TitleChoice{Tool: tool, Command: command}, current.Choice())
	if err != nil {
		t.Fatal(err)
	}
	return saved
}

func titleServer(t *testing.T, command string) (*Server, history.Session) {
	t.Helper()
	dir := t.TempDir()
	store, err := history.Open(filepath.Join(dir, "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{ctx: ctx, store: store, info: protocol.ServerInfo{DataDir: dir}}
	t.Cleanup(func() { cancel(); s.jobs.Wait(); store.Close() })
	saved := titleTools
	titleTools = []protocol.TitleTool{{ID: "claude", Name: "Claude", Command: command}}
	t.Cleanup(func() { titleTools = saved })
	pickTitleTool(t, store, "claude", "")
	session, err := store.CreateSession("", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	if err = store.SetLaunchWorkspace(session.ID, "Shell · fixture", session.Workspace); err != nil {
		t.Fatal(err)
	}
	return s, session
}

// editorInput returns the bytes that the message editor writes for text in a bracketed
// paste.
func editorInput(text string) []byte {
	bracketed, _ := editorBytes(text, nil)
	return []byte(bracketed)
}

// submit saves a send as the message editor does: a pending revision, then, after an
// input receipt, an empty revision. receipt false leaves the send without a receipt.
func submit(t *testing.T, s *Server, sid, text string, receipt bool) int64 {
	t.Helper()
	pending, err := s.composer(sid, &protocol.Draft{Revision: mustLatest(t, s, sid), Text: text, Attachments: []int64{}, Pending: true})
	if err != nil {
		t.Fatal(err)
	}
	if receipt {
		s.titleAfterReceipt(sid, fmt.Sprintf("draft-%d", pending.Draft.Revision), editorInput(text))
		if _, err = s.composer(sid, &protocol.Draft{Revision: pending.Draft.Revision, Attachments: []int64{}}); err != nil {
			t.Fatal(err)
		}
	}
	return pending.Draft.Revision
}

// ranTitle returns the standard input of the last title command, and removes it.
func ranTitle(t *testing.T, s *Server, dir string) string {
	t.Helper()
	s.jobs.Wait()
	input, err := os.ReadFile(filepath.Join(dir, "input"))
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(dir, "input"))
	return string(input)
}

func TestInputReceiptSetsDerivedTitle(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	command, dir := writeTitleScript(t, "echo bbflow-title: Fix login redirect")
	s, session := titleServer(t, command)
	// An autosave is not a send.
	if _, err := s.composer(session.ID, &protocol.Draft{Text: "Draft only"}); err != nil {
		t.Fatal(err)
	}
	// The terminal did not accept this send. The editor kept the text.
	lost := submit(t, s, session.ID, "Lost message", false)
	if _, err := s.composer(session.ID, &protocol.Draft{Revision: lost, Text: "Lost message", Attachments: []int64{}}); err != nil {
		t.Fatal(err)
	}
	// A receipt that names no pending revision of the session does nothing.
	s.titleAfterReceipt(session.ID, fmt.Sprintf("draft-%d", mustLatest(t, s, session.ID)), editorInput("Lost message"))
	s.titleAfterReceipt(session.ID, "other-input", editorInput("Lost message"))
	// A receipt for the pending revision, but with other bytes, does nothing too.
	s.titleAfterReceipt(session.ID, fmt.Sprintf("draft-%d", lost), editorInput("Other text"))
	if input := ranTitle(t, s, dir); input != "" {
		t.Fatalf("a send without a receipt ran the title command: %q", input)
	}
	submit(t, s, session.ID, "Fix the login redirect", true)
	if input := ranTitle(t, s, dir); !strings.Contains(input, "Fix the login redirect") || strings.Contains(input, "Lost message") {
		t.Fatalf("the receipt did not run the title command with its own text: %q", input)
	}
	got, err := s.store.Session(session.ID)
	if err != nil || got.Title != "" || got.AutoTitle != "Fix login redirect" || got.DisplayTitle() != "Fix login redirect" {
		t.Fatalf("session after the receipt: %+v, %v", got, err)
	}
	if s.titles.Load() != 1 {
		t.Fatal("title change was not counted", s.titles.Load())
	}
	// Later sends keep the first summary.
	submit(t, s, session.ID, "Now add tests", true)
	if ranTitle(t, s, dir) != "" {
		t.Fatal("a later send ran the title command")
	}
	// A user title has priority. Removing it shows the derived title again.
	if err = s.store.RenameSession(session.ID, "My name"); err != nil {
		t.Fatal(err)
	}
	if got, _ = s.store.Session(session.ID); got.DisplayTitle() != "My name" || got.AutoTitle != "Fix login redirect" {
		t.Fatalf("rename: %+v", got)
	}
	if err = s.store.RenameSession(session.ID, "  "); err != nil {
		t.Fatal(err)
	}
	if got, _ = s.store.Session(session.ID); got.Title != "" || got.DisplayTitle() != "Fix login redirect" {
		t.Fatalf("clear rename: %+v", got)
	}
}

// After a failed send, the user can unlock the draft and empty it before the autosave.
// That saves one empty revision that is not pending, with no receipt. The discarded
// text must never go to the title command. The next accepted send gets the title.
func TestUnlockedAndEmptiedDraftSendsNoText(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	command, dir := writeTitleScript(t, "echo bbflow-title: Generated")
	s, session := titleServer(t, command)
	discarded := submit(t, s, session.ID, "Discarded message", false)
	if _, err := s.composer(session.ID, &protocol.Draft{Revision: discarded, Attachments: []int64{}}); err != nil {
		t.Fatal(err)
	}
	if input := ranTitle(t, s, dir); input != "" {
		t.Fatalf("an emptied draft ran the title command: %q", input)
	}
	submit(t, s, session.ID, "Real message", true)
	if input := ranTitle(t, s, dir); !strings.Contains(input, "Real message") || strings.Contains(input, "Discarded message") {
		t.Fatalf("the title command did not get only the accepted text: %q", input)
	}
}

// The title event in the archive keeps the request once-only. A lost receipt in the
// browser leaves the draft pending, and a restart clears the server memory.
func TestTitleRequestStaysOnceAfterRestart(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	command, dir := writeTitleScript(t, "echo bbflow-title: First title")
	s, session := titleServer(t, command)
	// The server accepted the input, but the browser lost the receipt. The draft stays
	// pending, with no empty revision after it.
	first, err := s.composer(session.ID, &protocol.Draft{Revision: mustLatest(t, s, session.ID), Text: "First message", Attachments: []int64{}, Pending: true})
	if err != nil {
		t.Fatal(err)
	}
	s.titleAfterReceipt(session.ID, fmt.Sprintf("draft-%d", first.Draft.Revision), editorInput("First message"))
	if input := ranTitle(t, s, dir); !strings.Contains(input, "First message") {
		t.Fatalf("first request: %q", input)
	}
	if err = s.store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := history.Open(s.store.Path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	s.store = store
	// The user unlocks the draft and sends a second message after the restart.
	if _, err = s.composer(session.ID, &protocol.Draft{Revision: first.Draft.Revision, Text: "Second message", Attachments: []int64{}}); err != nil {
		t.Fatal(err)
	}
	submit(t, s, session.ID, "Second message", true)
	if input := ranTitle(t, s, dir); input != "" {
		t.Fatalf("a second request ran after the restart: %q", input)
	}
	got, err := store.Session(session.ID)
	if err != nil || got.AutoTitle != "First title" {
		t.Fatalf("session: %+v, %v", got, err)
	}
	result, err := store.Query(context.Background(), "SELECT count(*), data->>'$.tool' FROM events WHERE kind='title'")
	if err != nil || fmt.Sprint(result.Rows) != "[[1 claude]]" {
		t.Fatalf("title events: %+v, %v", result, err)
	}
}

func TestEditorBytesFollowComposeInput(t *testing.T) {
	bracketed, plain := editorBytes("Fix it", nil)
	if bracketed != "\x1b[200~Fix it\x1b[201~\r" || plain != "Fix it\r" {
		t.Fatalf("one line: %q %q", bracketed, plain)
	}
	bracketed, _ = editorBytes("Line one\r\nLine two", []string{"/data/a.png", "/data/it's.txt"})
	if want := "\x1b[200~Line one\rLine two\r\r'/data/a.png'\r'/data/it'\\''s.txt'\x1b[201~\r"; bracketed != want {
		t.Fatalf("lines and files:\n got %q\nwant %q", bracketed, want)
	}
}

// The server accepts a receipt only for the exact bytes of the named revision. Text
// inside another submission, or only in the attachment part, starts nothing.
func TestReceiptNeedsTheExactEditorInput(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	command, dir := writeTitleScript(t, "echo bbflow-title: Generated")
	s, session := titleServer(t, command)
	file, err := s.upload(session.ID, &protocol.Upload{Name: "Fix it.txt", MediaType: "text/plain", Data: []byte("x")})
	if err != nil {
		t.Fatal(err)
	}
	pending, err := s.composer(session.ID, &protocol.Draft{Revision: mustLatest(t, s, session.ID), Text: "Fix it", Attachments: []int64{file.ID}, Pending: true})
	if err != nil {
		t.Fatal(err)
	}
	id := fmt.Sprintf("draft-%d", pending.Draft.Revision)
	quoted := "'" + file.Path + "'"
	for _, input := range []string{
		"\x1b[200~Please Fix it now\r\r" + quoted + "\x1b[201~\r", // Overlapping text.
		"\x1b[200~Other\r\r" + quoted + "\x1b[201~\r",             // The text is only in the file name.
		"\x1b[200~Fix it\x1b[201~\r",                              // The attachment is missing.
		"\x1b[200~Fix it\r\r" + quoted + "\x1b[201~",              // No final Enter.
	} {
		s.titleAfterReceipt(session.ID, id, []byte(input))
		if got := ranTitle(t, s, dir); got != "" {
			t.Fatalf("input %q ran the title command: %q", input, got)
		}
	}
	bracketed, _ := editorBytes("Fix it", []string{file.Path})
	s.titleAfterReceipt(session.ID, id, []byte(bracketed))
	if got := ranTitle(t, s, dir); !strings.Contains(got, "Fix it") {
		t.Fatalf("the exact input did not run the title command: %q", got)
	}
}

func TestMultilineReceiptRunsTheTitleCommand(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	command, dir := writeTitleScript(t, "echo bbflow-title: Generated")
	s, session := titleServer(t, command)
	pending, err := s.composer(session.ID, &protocol.Draft{Revision: mustLatest(t, s, session.ID), Text: "First line\nSecond line", Attachments: []int64{}, Pending: true})
	if err != nil {
		t.Fatal(err)
	}
	bracketed, _ := editorBytes("First line\nSecond line", nil)
	s.titleAfterReceipt(session.ID, fmt.Sprintf("draft-%d", pending.Draft.Revision), []byte(bracketed))
	if got := ranTitle(t, s, dir); !strings.Contains(got, "First line\nSecond line") {
		t.Fatalf("multiline input: %q", got)
	}
}

// The first verified send decides, also when it starts no request. A title tool that the
// user selects later does not make the second send the first message.
func TestFirstSendCountsWhileTitlesAreOff(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	command, dir := writeTitleScript(t, "echo bbflow-title: Generated")
	s, session := titleServer(t, command)
	pickTitleTool(t, s.store, "none", "")
	submit(t, s, session.ID, "First message", true)
	pickTitleTool(t, s.store, "claude", "")
	submit(t, s, session.ID, "Second message", true)
	if got := ranTitle(t, s, dir); got != "" {
		t.Fatalf("a later send became the first message: %q", got)
	}
	result, err := s.store.Query(context.Background(), "SELECT CAST(data AS TEXT) FROM events WHERE kind='title'")
	if err != nil || len(result.Rows) != 1 || !strings.Contains(fmt.Sprint(result.Rows[0][0]), `"tool":"none","requested":false`) {
		t.Fatalf("title events: %+v, %v", result, err)
	}
}

// A session from before the upgrade keeps its title and has no derived title. After the
// user clears its title and selects a tool, a send still starts no request: the archive
// cannot show that the send is the first of the session.
func TestSessionFromBeforeUpgradeGetsNoTitle(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	command, dir := writeTitleScript(t, "echo bbflow-title: Generated")
	s, _ := titleServer(t, command)
	old, err := s.store.CreateSession("Saved title", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.store.RenameSession(old.ID, ""); err != nil {
		t.Fatal(err)
	}
	submit(t, s, old.ID, "A later message", true)
	if got := ranTitle(t, s, dir); got != "" {
		t.Fatalf("a session from before the upgrade ran the title command: %q", got)
	}
	got, err := s.store.Session(old.ID)
	if err != nil || got.Title != "" || got.AutoTitle != "" {
		t.Fatalf("session: %+v, %v", got, err)
	}
}

func mustLatest(t *testing.T, s *Server, sid string) int64 {
	t.Helper()
	state, err := s.composer(sid, nil)
	if err != nil {
		t.Fatal(err)
	}
	return state.Draft.Revision
}

func TestUserTitleSkipsTitleCommand(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	command, dir := writeTitleScript(t, "echo bbflow-title: Generated")
	s, session := titleServer(t, command)
	if err := s.store.RenameSession(session.ID, "Named by user"); err != nil {
		t.Fatal(err)
	}
	submit(t, s, session.ID, "Fix it", true)
	if ranTitle(t, s, dir) != "" {
		t.Fatal("a session with a user title ran the title command")
	}
	if got, _ := s.store.Session(session.ID); got.DisplayTitle() != "Named by user" || got.AutoTitle != "Shell · fixture" {
		t.Fatalf("session: %+v", got)
	}
}

func TestFailedTitleCommandKeepsDefaultTitle(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	command, _ := writeTitleScript(t, "exit 1")
	s, session := titleServer(t, command)
	submit(t, s, session.ID, "Fix it", true)
	s.jobs.Wait()
	if got, _ := s.store.Session(session.ID); got.DisplayTitle() != "Shell · fixture" || s.titles.Load() != 0 {
		t.Fatalf("session: %+v", got)
	}
}

// A title tool saves only after it passes its test with the sample message. A failed
// test, a canceled test, and an unknown tool save nothing. None saves without a test.
func TestTitleToolSavesOnlyAfterItsTest(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	failing, _ := writeTitleScript(t, "echo 'not signed in' >&2; exit 1")
	s, _ := titleServer(t, failing)
	before := pickTitleTool(t, s.store, "none", "")
	unchanged := func() {
		t.Helper()
		if after, err := s.store.Settings(); err != nil || after.Revision != before.Revision || after.TitleTool != "none" {
			t.Fatalf("settings changed: %+v %v", after, err)
		}
	}

	_, err := s.setTitleTool(context.Background(), titleChoice("claude", ""))
	if err == nil || !strings.Contains(err.Error(), "Claude is not configured. The title tool is still None. The test failed: ") || !strings.Contains(err.Error(), "not signed in") {
		t.Fatalf("failed test: %v", err)
	}
	unchanged()
	if _, err = s.setTitleTool(context.Background(), titleChoice("claude -p", "")); err == nil || !strings.Contains(err.Error(), "title tool must be one of none, claude") {
		t.Fatalf("unknown tool: %v", err)
	}
	// Only the ID none turns automatic titles off. An empty ID is an error.
	if _, err = s.setTitleTool(context.Background(), titleChoice("", "")); err == nil || !strings.Contains(err.Error(), "choose a title tool") {
		t.Fatalf("empty tool: %v", err)
	}
	unchanged()
	for _, tool := range []string{"claude", "none"} {
		if _, err = s.setTitleTool(context.Background(), titleChoice(tool, "my-llm")); err == nil || !strings.Contains(err.Error(), "only the custom title tool takes a command") {
			t.Fatalf("%s with a command: %v", tool, err)
		}
	}
	unchanged()
	slow, _ := writeTitleScript(t, "sleep 30 & wait")
	titleTools[0].Command = slow
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if _, err = s.setTitleTool(ctx, titleChoice("claude", "")); err == nil {
		t.Fatal("a canceled test saved the tool")
	}
	unchanged()

	passing, dir := writeTitleScript(t, "echo bbflow-title: Fix login redirect")
	titleTools[0].Command = passing
	// A test alone saves nothing.
	if test, err := s.testTitleTool(context.Background(), titleChoice("claude", "")); err != nil || test.Title != "Fix login redirect" {
		t.Fatalf("test: %+v %v", test, err)
	}
	unchanged()
	result, err := s.setTitleTool(context.Background(), titleChoice("claude", ""))
	if err != nil || result.Title != "Fix login redirect" || result.Settings.TitleTool != "claude" || result.Settings.Revision != before.Revision+1 {
		t.Fatalf("passed test: %+v %v", result, err)
	}
	input, err := os.ReadFile(filepath.Join(dir, "input"))
	if err != nil || !strings.Contains(string(input), titleSample) {
		t.Fatalf("test input %q, %v", input, err)
	}

	// None has no test.
	if err = os.Remove(filepath.Join(dir, "input")); err != nil {
		t.Fatal(err)
	}
	if result, err = s.setTitleTool(context.Background(), titleChoice("none", "")); err != nil || result.Title != "" || result.Settings.TitleTool != "none" {
		t.Fatalf("none: %+v %v", result, err)
	}
	if _, err = os.Stat(filepath.Join(dir, "input")); !os.IsNotExist(err) {
		t.Fatal("none ran the title command", err)
	}
}

// The custom title tool saves its command only after the command passes its test. The
// command stays saved when another tool is selected. Custom needs the command in each
// request, so the test runs the command that the client shows. The first send of a
// session runs the saved custom command.
func TestCustomTitleToolSavesItsCommandAfterItsTest(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	builtin, _ := writeTitleScript(t, "echo bbflow-title: Built-in title")
	s, session := titleServer(t, builtin)
	pickTitleTool(t, s.store, "none", "")
	if _, err := s.setTitleTool(context.Background(), titleChoice("custom", "")); err == nil || !strings.Contains(err.Error(), "enter a command for the custom title tool") {
		t.Fatalf("custom without a command: %v", err)
	}
	failing, _ := writeTitleScript(t, "echo 'model not found' >&2; exit 2")
	if _, err := s.setTitleTool(context.Background(), titleChoice("custom", failing)); err == nil || !strings.Contains(err.Error(), "Custom is not configured. The title tool is still None. The test failed: ") || !strings.Contains(err.Error(), "model not found") {
		t.Fatalf("failed custom test: %v", err)
	}
	if saved, err := s.store.Settings(); err != nil || saved.TitleTool != "none" || saved.TitleCommand != "" {
		t.Fatalf("a failed custom test saved settings: %+v %v", saved, err)
	}

	custom, dir := writeTitleScript(t, "echo bbflow-title: Custom title")
	result, err := s.setTitleTool(context.Background(), titleChoice("custom", custom))
	if err != nil || result.Title != "Custom title" || result.Settings.TitleTool != "custom" || result.Settings.TitleCommand != custom {
		t.Fatalf("custom set: %+v %v", result, err)
	}
	if input := ranTitle(t, s, dir); !strings.Contains(input, titleSample) {
		t.Fatalf("custom test input: %q", input)
	}
	// A failed new custom command keeps the working one, and the error tells so.
	if _, err = s.setTitleTool(context.Background(), titleChoice("custom", failing)); err == nil || !strings.Contains(err.Error(), "Custom is not configured with the new command. The title tool is still Custom, with its saved command. The test failed: ") {
		t.Fatalf("failed new custom command: %v", err)
	}
	// Another tool keeps the custom command. A test and a change of Custom without a
	// command are errors, also with a saved command.
	if result, err = s.setTitleTool(context.Background(), titleChoice("claude", "")); err != nil || result.Settings.TitleCommand != custom {
		t.Fatalf("switch to claude: %+v %v", result, err)
	}
	if _, err = s.testTitleTool(context.Background(), titleChoice("custom", "")); err == nil || !strings.Contains(err.Error(), "enter a command for the custom title tool") {
		t.Fatalf("test of custom without a command: %v", err)
	}
	if test, err := s.testTitleTool(context.Background(), titleChoice("custom", custom)); err != nil || test.Title != "Custom title" {
		t.Fatalf("test of the custom command: %+v %v", test, err)
	}
	if result, err = s.setTitleTool(context.Background(), titleChoice("custom", custom)); err != nil || result.Title != "Custom title" || result.Settings.TitleTool != "custom" {
		t.Fatalf("custom with the saved command: %+v %v", result, err)
	}
	ranTitle(t, s, dir)
	submit(t, s, session.ID, "Fix the login redirect", true)
	if input := ranTitle(t, s, dir); !strings.Contains(input, "Fix the login redirect") {
		t.Fatalf("the first send did not run the custom command: %q", input)
	}
	if got, err := s.store.Session(session.ID); err != nil || got.AutoTitle != "Custom title" {
		t.Fatalf("session: %+v %v", got, err)
	}
}

// heldTitleScript writes a title command that waits until release runs. started tells
// that the command reads its request.
func heldTitleScript(t *testing.T, answer string) (command string, started func() bool, release func()) {
	t.Helper()
	command, dir := writeTitleScript(t, "while [ ! -f \"$(dirname \"$0\")/release\" ]; do sleep 0.05; done\n"+answer)
	started = func() bool {
		_, err := os.Stat(filepath.Join(dir, "cwd"))
		return err == nil
	}
	release = func() {
		if err := os.WriteFile(filepath.Join(dir, "release"), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return command, started, release
}

// setDuringTest starts a change of the title tool with a held command, runs during while
// the command waits, and returns the result of the change.
func setDuringTest(t *testing.T, s *Server, tool, command string, started func() bool, release func(), during func()) error {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		_, err := s.setTitleTool(context.Background(), titleChoice(tool, command))
		done <- err
	}()
	for deadline := time.Now().Add(10 * time.Second); !started(); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the title command did not start")
		}
	}
	during()
	release()
	return <-done
}

// A test that ends after a later title tool change does not undo that change. Its error
// names the tool that is saved now. A change of another setting during the test does
// not block the save.
func TestLateTitleTestKeepsALaterChange(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	s, _ := titleServer(t, "true")
	pickTitleTool(t, s.store, "claude", "")

	passing, started, release := heldTitleScript(t, "echo bbflow-title: Late title")
	err := setDuringTest(t, s, "custom", passing, started, release, func() {
		if _, err := s.setTitleTool(context.Background(), titleChoice("none", "")); err != nil {
			t.Fatal(err)
		}
	})
	if err == nil || !strings.Contains(err.Error(), "Custom did not save, because another change selected None during the test") {
		t.Fatalf("late passed test: %v", err)
	}
	if saved, err := s.store.Settings(); err != nil || saved.TitleTool != "none" || saved.TitleCommand != "" {
		t.Fatalf("a late test undid a later change: %+v %v", saved, err)
	}

	// The error of a late failed test names the tool that is saved after the test.
	pickTitleTool(t, s.store, "claude", "")
	failing, started, release := heldTitleScript(t, "echo 'model not found' >&2; exit 2")
	err = setDuringTest(t, s, "custom", failing, started, release, func() { pickTitleTool(t, s.store, "none", "") })
	if err == nil || !strings.Contains(err.Error(), "Custom is not configured. The title tool is still None. The test failed: ") {
		t.Fatalf("late failed test: %v", err)
	}

	// A change of another setting during the test does not block the save.
	passing, started, release = heldTitleScript(t, "echo bbflow-title: Late title")
	err = setDuringTest(t, s, "custom", passing, started, release, func() {
		settings, err := s.store.Settings()
		if err == nil {
			settings.Appearance = "dark"
			_, err = s.store.SaveSettings(settings)
		}
		if err != nil {
			t.Fatal(err)
		}
	})
	if saved, readErr := s.store.Settings(); err != nil || readErr != nil || saved.TitleTool != "custom" || saved.TitleCommand != passing || saved.Appearance != "dark" {
		t.Fatalf("test during another save: %+v %v %v", saved, err, readErr)
	}

	// A failed test of the saved tool tells that the tool stays selected.
	titleTools[0].Command = "exit 3"
	pickTitleTool(t, s.store, "claude", "")
	if _, err = s.setTitleTool(context.Background(), titleChoice("claude", "")); err == nil || !strings.Contains(err.Error(), "Claude is still the title tool, but its test failed: ") {
		t.Fatalf("failed test of the saved tool: %v", err)
	}
}

func TestTitleCommandsTakeTheChosenModel(t *testing.T) {
	// The defaults give the commands of earlier releases.
	for id, want := range map[string]string{
		"claude":     `claude -p --model haiku --restricted --tools "" --strict-mcp-config`,
		"code-puppy": `code-puppy --no-tools --model codex-gpt-6-luna -p "$(cat)"`,
	} {
		if tool, err := findTitleTool(titleChoice(id, "")); err != nil || tool.Command != want {
			t.Errorf("%s: %q %v", id, tool.Command, err)
		}
	}
	codex, err := findTitleTool(history.TitleChoice{Tool: "codex", Model: "gpt-6-sol", Effort: "medium"})
	if err != nil || !strings.HasSuffix(codex.Command, " -c web_search=disabled --model gpt-6-sol -c model_reasoning_effort=medium -") {
		t.Fatalf("codex: %q %v", codex.Command, err)
	}
	// An empty model adds no option, so the CLI uses its own default.
	if claude, err := findTitleTool(history.TitleChoice{Tool: "claude"}); err != nil || strings.Contains(claude.Command, "--model") {
		t.Fatalf("claude without a model: %q %v", claude.Command, err)
	}
	for _, choice := range []history.TitleChoice{
		{Tool: "apple", Model: "system"},
		{Tool: "custom", Command: "my-llm", Model: "x"},
		{Tool: "code-puppy", Model: "codex-gpt-6-luna", Effort: "low"},
		{Tool: "claude", Model: "opus; id"},
	} {
		if _, err := findTitleTool(choice); err == nil {
			t.Errorf("accepted %+v", choice)
		}
	}
}

func TestTitleToolChangeSavesTheModel(t *testing.T) {
	passing, _ := writeTitleScript(t, "echo 'bbflow-title: Fix login redirect'")
	s, _ := titleServer(t, passing)
	pickTitleTool(t, s.store, "none", "")
	result, err := s.setTitleTool(context.Background(), history.TitleChoice{Tool: "claude", Model: "sonnet", Effort: "low"})
	if err != nil || result.Settings.TitleModel != "sonnet" || result.Settings.TitleEffort != "low" {
		t.Fatalf("model did not save: %+v %v", result.Settings, err)
	}
	// A settings save keeps the title model.
	saved, err := s.store.SaveSettings(result.Settings)
	if err != nil || saved.TitleModel != "sonnet" {
		t.Fatalf("settings save changed the title model: %+v %v", saved, err)
	}
	// A change that started from another model saves nothing.
	if _, err = s.store.SetTitleTool(history.TitleChoice{Tool: "claude", Model: "opus"}, history.TitleChoice{Tool: "claude", Model: "haiku"}); !errors.Is(err, history.ErrTitleChanged) {
		t.Fatalf("a stale change saved: %v", err)
	}
}
