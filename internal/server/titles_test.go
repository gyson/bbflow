package server

import (
	"context"
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
		{"Fix login redirect\n", "Fix login redirect"},
		{"\n\n  Title: \"Fix login redirect.\"\n", "Fix login redirect"},
		{"## **Refactor the parser**", "Refactor the parser"},
		{"`Add tests`", "Add tests"},
		{"「修复登录」。", "修复登录"},
		{"Tabs\tand   spaces", "Tabs and spaces"},
		{strings.Repeat("é", 300), strings.Repeat("é", 200)},
		{"bbflow-title: Fix login redirect", "Fix login redirect"},
		{"**BBFLOW-TITLE:** Fix login redirect.", "Fix login redirect"},
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
		// An error message with exit status 0 must not become a title.
		{"🎯 Using model: small\nExecuting prompt: Write a short title\nError executing prompt: usage limit\n", "no line starts with bbflow-title:"},
	} {
		if got, err := parseTitle(test.output); err == nil || !strings.Contains(err.Error(), test.want) {
			t.Errorf("parseTitle(%q) = %q, %v, want error %q", test.output, got, err, test.want)
		}
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
	command, dir := writeTitleScript(t, `printf '\n"Title: Fix the login page."\n'`)
	message := "Fix the login page; $(touch injected) `rm -rf /` 'quote"
	title, err := runTitleCommand(context.Background(), command, message)
	if err != nil || title != "Fix the login page" {
		t.Fatalf("title %q, %v", title, err)
	}
	input, err := os.ReadFile(filepath.Join(dir, "input"))
	if err != nil || !strings.Contains(string(input), message) {
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

func TestFirstEditorMessageSetsDerivedTitle(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	command, dir := writeTitleScript(t, "echo Fix login redirect")
	s, session := titleServer(t, command)
	// An autosave is not a send.
	state, err := s.composer(session.ID, &protocol.Draft{Text: "Draft only"})
	if err != nil {
		t.Fatal(err)
	}
	s.jobs.Wait()
	if _, err = os.Stat(filepath.Join(dir, "input")); !os.IsNotExist(err) {
		t.Fatal("an autosave ran the title command")
	}
	state, err = s.composer(session.ID, &protocol.Draft{Revision: state.Draft.Revision, Text: "Fix the login redirect", Pending: true})
	if err != nil {
		t.Fatal(err)
	}
	s.jobs.Wait()
	got, err := s.store.Session(session.ID)
	if err != nil || got.Title != "" || got.AutoTitle != "Fix login redirect" || got.DisplayTitle() != "Fix login redirect" {
		t.Fatalf("session after first message: %+v, %v", got, err)
	}
	if s.titles.Load() != 1 {
		t.Fatal("title change was not counted", s.titles.Load())
	}
	// Later messages keep the first summary.
	os.Remove(filepath.Join(dir, "input"))
	state, err = s.composer(session.ID, &protocol.Draft{Revision: state.Draft.Revision, Attachments: []int64{}})
	if err == nil {
		_, err = s.composer(session.ID, &protocol.Draft{Revision: state.Draft.Revision, Text: "Now add tests", Pending: true})
	}
	if err != nil {
		t.Fatal(err)
	}
	s.jobs.Wait()
	if _, err = os.Stat(filepath.Join(dir, "input")); !os.IsNotExist(err) {
		t.Fatal("a later message ran the title command")
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

func TestUserTitleSkipsTitleCommand(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	command, dir := writeTitleScript(t, "echo Generated")
	s, session := titleServer(t, command)
	if err := s.store.RenameSession(session.ID, "Named by user"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.composer(session.ID, &protocol.Draft{Text: "Fix it", Pending: true}); err != nil {
		t.Fatal(err)
	}
	s.jobs.Wait()
	if _, err := os.Stat(filepath.Join(dir, "input")); !os.IsNotExist(err) {
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
	if _, err := s.composer(session.ID, &protocol.Draft{Text: "Fix it", Pending: true}); err != nil {
		t.Fatal(err)
	}
	s.jobs.Wait()
	if got, _ := s.store.Session(session.ID); got.DisplayTitle() != "Shell · fixture" || s.titles.Load() != 0 {
		t.Fatalf("session: %+v", got)
	}
}
