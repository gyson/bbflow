package history

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestSettingsPersistAndRejectStaleEdits(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.sqlite")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	settings, err := store.Settings()
	// A new database selects Use worktree, the update check, and the automatic port.
	// Upgrades keep the saved worktree choice.
	if err != nil || len(settings.Tools) != 0 || !settings.Worktree || settings.Base != "HEAD" || settings.Appearance != "system" || !settings.UpdateCheck || settings.Port != 0 {
		t.Fatal(settings, err)
	}
	settings.Tools = []Tool{{ID: "astra", Name: "Codex 6 Astra", Command: "codex --model=gpt-6-astra"}, {ID: "default", Name: "Codex", Command: "codex"}}
	settings.DefaultTool = "astra"
	settings.Worktree = false
	settings.UpdateCheck = false
	settings.Appearance = "invalid"
	if _, err := store.SaveSettings(settings); err == nil {
		t.Fatal("accepted invalid appearance")
	}
	settings.Appearance = "dark"
	for _, port := range []int{-1, 1, MinPort - 1, 65536, 6000, 10080} {
		settings.Port = port
		if _, err := store.SaveSettings(settings); err == nil {
			t.Fatal("accepted invalid port", port)
		}
	}
	// Browsers open the neighbors of a blocked port.
	settings.Port = 6001
	saved, err := store.SaveSettings(settings)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.SaveSettings(settings); err == nil {
		t.Fatal("overwrote settings")
	}
	project, err := store.CreateProject("Project", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.CreatePreparation("Prepared", project.Workspace, project.ID, Preparation{Command: "echo saved", ToolName: "Fixture"})
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	got, err := store.Settings()
	if err != nil || got.Revision != saved.Revision || got.Tools[0].Command != "codex --model=gpt-6-astra" || got.Worktree || got.Appearance != "dark" || got.UpdateCheck || got.Port != 6001 {
		t.Fatal(got, err)
	}
	restored, err := store.Session(session.ID)
	if err != nil || restored.Preparation == nil || restored.Preparation.Command != "echo saved" || restored.Preparation.State != "draft" || restored.Run != nil {
		t.Fatal("preparation changed on reopen", restored, err)
	}
	got.Tools = got.Tools[1:]
	if _, err = store.SaveSettings(got); err == nil {
		t.Fatal("accepted absent default tool")
	}
	for _, command := range []string{"echo hi\rwhoami", "echo\x00bad", "echo hi\nexit"} {
		if ValidateCommand(command) == nil {
			t.Fatal("accepted control character")
		}
	}
}

func TestRemoteAccessSettings(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	settings, err := store.Settings()
	if err != nil || settings.RemoteHost != "" || settings.RemoteLogin != "" || settings.RemoteAccess() {
		t.Fatal("a new database turned remote access on", settings, err)
	}
	for _, host := range []string{"localhost", "my-mac", "127.0.0.1", "100.64.0.1:443", "my-mac.localhost", "my-mac.example.ts.net:0", "my-mac.example.ts.net:65536", "my-mac.example.ts.net:08", "my-mac.example.ts.net:", "https://my-mac.example.ts.net", "my-mac.example.ts.net/", "my mac.example.ts.net", "-mac.example.ts.net", "my-mac..ts.net", "*.ts.net", strings.Repeat("a", 64) + ".ts.net", strings.Repeat("a.", 127) + "net"} {
		settings.RemoteHost = host
		if _, err := store.SaveSettings(settings); err == nil || !strings.Contains(err.Error(), "remote host must be a DNS name") {
			t.Fatal("accepted invalid remote host", host, err)
		}
	}
	settings.RemoteHost = ""
	for _, login := range []string{"two words@example.com", "café@example.com", "line\nbreak", strings.Repeat("a", 255)} {
		settings.RemoteLogin = login
		if _, err := store.SaveSettings(settings); err == nil || !strings.Contains(err.Error(), "Tailscale login must be") {
			t.Fatal("accepted invalid Tailscale login", login, err)
		}
	}
	// One value alone saves, and remote access stays off.
	settings.RemoteHost, settings.RemoteLogin = "  My-Mac.Example.ts.net ", ""
	if settings, err = store.SaveSettings(settings); err != nil || settings.RemoteHost != "my-mac.example.ts.net" || settings.RemoteAccess() {
		t.Fatal(settings, err)
	}
	settings.RemoteHost, settings.RemoteLogin = "my-mac.example.ts.net:8443", " User@Example.com "
	if settings, err = store.SaveSettings(settings); err != nil || settings.RemoteHost != "my-mac.example.ts.net:8443" || settings.RemoteLogin != "User@Example.com" || !settings.RemoteAccess() {
		t.Fatal(settings, err)
	}
	if saved, err := store.Settings(); err != nil || saved.RemoteHost != settings.RemoteHost || saved.RemoteLogin != settings.RemoteLogin {
		t.Fatal(saved, err)
	}
	// A title tool change keeps remote access.
	if settings, err = store.SetTitleTool(TitleChoice{Tool: "codex"}, settings.Choice()); err != nil || !settings.RemoteAccess() {
		t.Fatal(settings, err)
	}
}

func TestRunsListEachTerminalOfASessionInOrder(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	session, err := store.CreateSession("Runs", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	if runs, err := store.Runs(session.ID); err != nil || len(runs) != 0 {
		t.Fatal(runs, err)
	}
	var ids []string
	var last int64
	for i := range 3 {
		run, err := store.NewRun(session.ID)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, run.ID)
		if i == 2 {
			break // A run that never started has no events.
		}
		if _, err = store.Append(session.ID, run.ID, "start", []byte(`{"tool":"Fixture"}`), ""); err != nil {
			t.Fatal(err)
		}
		event, err := store.Append(session.ID, run.ID, "output", []byte("out"), "out")
		if err != nil {
			t.Fatal(err)
		}
		last = event.Seq
	}
	runs, err := store.Runs(session.ID)
	if err != nil || len(runs) != 3 {
		t.Fatal(runs, err)
	}
	for i, run := range runs {
		if run.ID != ids[i] {
			t.Fatalf("run %d is %s, expected %s", i, run.ID, ids[i])
		}
	}
	if runs[1].Last != last || runs[1].First != last-1 || string(runs[1].Start) != `{"tool":"Fixture"}` || runs[2].First != 0 || len(runs[2].Start) != 0 {
		t.Fatalf("%+v", runs)
	}
}

// RunStarts lists only the runs of one session. Each run keeps its first start event.
func TestRunStartsAndSessionRunStayInOneSession(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	session, err := store.CreateSession("Runs", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	other, err := store.CreateSession("Other", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	if runs, err := store.RunStarts(session.ID); err != nil || len(runs) != 0 {
		t.Fatal(runs, err)
	}
	record := func(sid string, events ...string) Run {
		t.Helper()
		run, err := store.NewRun(sid)
		if err != nil {
			t.Fatal(err)
		}
		for _, data := range events {
			kind := "output"
			if strings.HasPrefix(data, "{") {
				kind = "start"
			}
			if _, err = store.Append(sid, run.ID, kind, []byte(data), ""); err != nil {
				t.Fatal(err)
			}
		}
		return *run
	}
	first := record(session.ID, `{}`, "first output")
	foreign := record(other.ID, `{"tool":"Other"}`)
	second := record(session.ID, `{"tool":"Agent"}`, "second output", `{"tool":"Later"}`)
	third := record(session.ID) // A run that never started has no events.
	runs, err := store.RunStarts(session.ID)
	if err != nil || len(runs) != 3 {
		t.Fatal(runs, err)
	}
	for i, want := range []struct {
		id, start string
	}{{first.ID, `{}`}, {second.ID, `{"tool":"Agent"}`}, {third.ID, ""}} {
		if runs[i].ID != want.id || runs[i].SessionID != session.ID || string(runs[i].Start) != want.start {
			t.Fatalf("run %d: %+v", i, runs[i])
		}
	}
	if run, err := store.SessionRun(session.ID, second.ID); err != nil || run.ID != second.ID {
		t.Fatal(run, err)
	}
	for _, id := range []string{foreign.ID, "missing", ""} {
		if _, err := store.SessionRun(session.ID, id); !errors.Is(err, ErrRunNotFound) {
			t.Fatalf("run %q: %v", id, err)
		}
	}
}
