package server

import (
	"context"
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
		{"Fix login redirect\n", "no line starts with bbflow-title:"},
		{"Error executing prompt: usage limit\n", "no line starts with bbflow-title:"},
		// The marker must start the line.
		{"The answer is bbflow-title: Fix it\n", "no line starts with bbflow-title:"},
		// An error message with exit status 0 must not become a title.
		{"🎯 Using model: small\nExecuting prompt: Write a short title\nError executing prompt: usage limit\n", "no line starts with bbflow-title:"},
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
	if !strings.Contains(filepath.Base(folder), "bbflow-title-") {
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

func TestTitleToolsMatchSettings(t *testing.T) {
	var ids []string
	for _, tool := range titleTools {
		if _, err := titleCommand(tool.ID); err != nil || tool.Name == "" || !strings.Contains(tool.Command, tool.ID) {
			t.Errorf("title tool %+v: %v", tool, err)
		}
		ids = append(ids, tool.ID)
	}
	if want := history.TitleTools[1:]; !slices.Equal(ids, want) || history.TitleTools[0] != "none" {
		t.Fatalf("title tools %v, settings allow %v", ids, history.TitleTools)
	}
	for _, tool := range []string{"none", "", "claude -p"} {
		if _, err := titleCommand(tool); err == nil {
			t.Errorf("title tool %q has a command", tool)
		}
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
	settings, err := store.Settings()
	if err != nil {
		t.Fatal(err)
	}
	saved := titleTools
	titleTools = []protocol.TitleTool{{ID: "claude", Name: "Claude", Command: command}}
	t.Cleanup(func() { titleTools = saved })
	settings.TitleTool = "claude"
	if _, err = store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
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
	settings, err := s.store.Settings()
	if err != nil {
		t.Fatal(err)
	}
	settings.TitleTool = "none"
	if settings, err = s.store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	submit(t, s, session.ID, "First message", true)
	settings.TitleTool = "claude"
	if _, err = s.store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	submit(t, s, session.ID, "Second message", true)
	if got := ranTitle(t, s, dir); got != "" {
		t.Fatalf("a later send became the first message: %q", got)
	}
	result, err := s.store.Query(context.Background(), "SELECT CAST(data AS TEXT) FROM events WHERE kind='title'")
	if err != nil || len(result.Rows) != 1 || !strings.Contains(fmt.Sprint(result.Rows[0][0]), `"tool":"none","requested":false`) {
		t.Fatalf("title events: %+v, %v", result, err)
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
