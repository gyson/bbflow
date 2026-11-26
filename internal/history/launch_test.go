package history

import (
	"errors"
	"maps"
	"path/filepath"
	"slices"
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
	// Upgrades keep the saved worktree choice. It has the four built-in tools, off until
	// the tool check of the server.
	if err != nil || len(settings.Tools) != 4 || !settings.CheckTools || !settings.Worktree || settings.Base != "HEAD" || settings.Appearance != "system" || !settings.UpdateCheck || settings.Port != 0 {
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
	// A draft keeps the permission mode of its type. A mode of another type, or a mode
	// for Shell, does not save.
	codex := Preparation{ToolID: "builtin-codex", ToolName: "Codex", ToolType: "codex", Command: "codex --no-alt-screen", Permission: "approve-for-me"}
	agent, err := store.CreatePreparation("Codex draft", project.Workspace, project.ID, codex)
	if err != nil || agent.Preparation.Permission != "approve-for-me" {
		t.Fatal("lost the permission mode of a draft", agent.Preparation, err)
	}
	for _, p := range []Preparation{{ToolID: "builtin-codex", ToolType: "codex", Command: "codex", Permission: "plan"}, {Permission: "approve-for-me"}} {
		if _, err := store.CreatePreparation("Invalid", project.Workspace, project.ID, p); err == nil {
			t.Fatal("accepted a permission mode", p)
		}
		p.Revision = agent.Preparation.Revision
		if _, err := store.SavePreparation(agent.ID, "", p); err == nil {
			t.Fatal("saved a permission mode", p)
		}
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
	if err != nil || got.Revision != saved.Revision || got.Tools[4].Command != "codex --model=gpt-6-astra" || got.Worktree || got.Appearance != "dark" || got.UpdateCheck || got.Port != 6001 {
		t.Fatal(got, err)
	}
	restored, err := store.Session(session.ID)
	if err != nil || restored.Preparation == nil || restored.Preparation.Command != "echo saved" || restored.Preparation.State != "draft" || restored.Run != nil {
		t.Fatal("preparation changed on reopen", restored, err)
	}
	if restored, err = store.Session(agent.ID); err != nil || restored.Preparation.Permission != "approve-for-me" {
		t.Fatal("the permission mode of a draft changed on reopen", restored.Preparation, err)
	}
	// The default tool is the first tool after the four built-in tools.
	got.Tools = slices.Delete(slices.Clone(got.Tools), 4, 5)
	if _, err = store.SaveSettings(got); err == nil {
		t.Fatal("accepted absent default tool")
	}
	for _, command := range []string{"echo hi\rwhoami", "echo\x00bad", "echo hi\nexit"} {
		if ValidateCommand(command) == nil {
			t.Fatal("accepted control character")
		}
	}
}

// Saved prompts keep their order and their text. A save trims the name. It rejects a
// prompt list that a menu cannot show unambiguously, and text that Send would reject.
func TestPromptSettings(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	settings, err := store.Settings()
	if err != nil || settings.Prompts == nil || len(settings.Prompts) != 0 {
		t.Fatal("a new database has prompts", settings.Prompts, err)
	}
	text := "Use the review-loop skill as the reviewer for PR #"
	multiline := "Summarize the branch.\n\tList the risks. "
	settings.Prompts = []Prompt{{ID: "b", Name: "  Review PR ", Text: text}, {ID: "a", Name: "Summary", Text: multiline}}
	if settings, err = store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	want := []Prompt{{ID: "b", Name: "Review PR", Text: text}, {ID: "a", Name: "Summary", Text: multiline}}
	if saved, err := store.Settings(); err != nil || !slices.Equal(saved.Prompts, want) || !slices.Equal(settings.Prompts, want) {
		t.Fatal("the prompts changed", saved.Prompts, settings.Prompts, err)
	}
	// A save without the field removes all prompts, as for the tools.
	empty := settings
	empty.Prompts = nil
	if saved, err := store.SaveSettings(empty); err != nil || saved.Prompts == nil || len(saved.Prompts) != 0 {
		t.Fatal("a save without prompts kept them", saved.Prompts, err)
	} else {
		settings = saved
	}
	many := make([]Prompt, maxPrompts+1)
	for i := range many {
		many[i] = Prompt{ID: strings.Repeat("x", i+1), Name: "Prompt " + strings.Repeat("x", i+1), Text: "text"}
	}
	for _, test := range []struct {
		prompts []Prompt
		message string
	}{
		{many, "at most 100 prompts"},
		{[]Prompt{{ID: "", Name: "No ID", Text: "text"}}, "unique IDs"},
		{[]Prompt{{ID: strings.Repeat("x", 101), Name: "Long ID", Text: "text"}}, "unique IDs"},
		{[]Prompt{{ID: "a", Name: "One", Text: "text"}, {ID: "a", Name: "Two", Text: "text"}}, "unique IDs"},
		{[]Prompt{{ID: "a", Name: " ", Text: "text"}}, "use a name"},
		{[]Prompt{{ID: "a", Name: "Line\nbreak", Text: "text"}}, "use a name"},
		{[]Prompt{{ID: "a", Name: "Review PR", Text: "text"}, {ID: "b", Name: "review pr ", Text: "text"}}, "another prompt has the name"},
		{[]Prompt{{ID: "a", Name: "Blank", Text: " \n\t"}}, "has no text"},
		{[]Prompt{{ID: "a", Name: "Long", Text: strings.Repeat("x", maxPromptText+1)}}, "longer than 16 KiB"},
		{[]Prompt{{ID: "a", Name: "Return", Text: "one\r\ntwo"}}, "control characters"},
		{[]Prompt{{ID: "a", Name: "Escape", Text: "red \x1b[31m"}}, "control characters"},
		{[]Prompt{{ID: "a", Name: "Bytes", Text: "bad \xff"}}, "control characters"},
	} {
		next := settings
		next.Prompts = test.prompts
		if _, err := store.SaveSettings(next); err == nil || !strings.Contains(err.Error(), test.message) {
			t.Fatalf("accepted invalid prompts %.80q: %v", test.prompts, err)
		}
	}
	// The limits themselves save.
	settings.Prompts = slices.Clone(many[:maxPrompts])
	settings.Prompts[0].Text = strings.Repeat("é", maxPromptText/2)
	if saved, err := store.SaveSettings(settings); err != nil || len(saved.Prompts) != maxPrompts {
		t.Fatal("rejected prompts at the limits", err)
	}
}

// Prompt groups keep their order and their IDs. A save trims the names. A prompt names
// its group by ID, so a group rename keeps its prompts. A save rejects a group that a
// menu cannot show unambiguously, and a prompt in a group that does not exist.
func TestPromptGroupSettings(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	settings, err := store.Settings()
	if err != nil || settings.PromptGroups == nil || len(settings.PromptGroups) != 0 {
		t.Fatal("a new database has prompt groups", settings.PromptGroups, err)
	}
	settings.PromptGroups = []PromptGroup{{ID: "t", Name: " Tests "}, {ID: "g", Name: "Git"}}
	settings.Prompts = []Prompt{{ID: "a", Name: "Continue", Text: "Continue."}, {ID: "b", Name: "Commit", Text: "Commit.", Group: "g"}, {ID: "c", Name: "Run checks", Text: "Run make check.", Group: "t"}}
	if settings, err = store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	wantGroups := []PromptGroup{{ID: "t", Name: "Tests"}, {ID: "g", Name: "Git"}}
	if saved, err := store.Settings(); err != nil || !slices.Equal(saved.PromptGroups, wantGroups) || !slices.Equal(saved.Prompts, settings.Prompts) || saved.Prompts[1].Group != "g" {
		t.Fatal("the prompt groups changed", saved.PromptGroups, saved.Prompts, err)
	}
	// A rename changes only the group. Its prompts keep the group ID.
	settings.PromptGroups[1].Name = "Git and PRs"
	if saved, err := store.SaveSettings(settings); err != nil || saved.PromptGroups[1] != (PromptGroup{ID: "g", Name: "Git and PRs"}) || saved.Prompts[1].Group != "g" {
		t.Fatal("a rename lost the prompts of the group", saved, err)
	} else {
		settings = saved
	}
	many := make([]PromptGroup, maxPromptGroups+1)
	for i := range many {
		many[i] = PromptGroup{ID: strings.Repeat("x", i+1), Name: "Group " + strings.Repeat("x", i+1)}
	}
	for _, test := range []struct {
		groups  []PromptGroup
		prompts []Prompt
		message string
	}{
		{many, nil, "at most 50 prompt groups"},
		{[]PromptGroup{{ID: "", Name: "No ID"}}, nil, "unique IDs"},
		{[]PromptGroup{{ID: strings.Repeat("x", 101), Name: "Long ID"}}, nil, "unique IDs"},
		{[]PromptGroup{{ID: "a", Name: "One"}, {ID: "a", Name: "Two"}}, nil, "unique IDs"},
		{[]PromptGroup{{ID: "a", Name: " "}}, nil, "use a name"},
		{[]PromptGroup{{ID: "a", Name: "Tab\tname"}}, nil, "use a name"},
		{[]PromptGroup{{ID: "a", Name: "Tests"}, {ID: "b", Name: "tests "}}, nil, "another prompt group has the name"},
		{nil, []Prompt{{ID: "a", Name: "Lost", Text: "text", Group: "gone"}}, "the group of the prompt \"Lost\" does not exist"},
		{[]PromptGroup{{ID: "a", Name: "A"}}, []Prompt{{ID: "p", Name: "Review", Text: "text", Group: "a"}, {ID: "q", Name: "review", Text: "text"}}, "another prompt has the name"},
	} {
		next := settings
		next.PromptGroups, next.Prompts = test.groups, test.prompts
		if _, err := store.SaveSettings(next); err == nil || !strings.Contains(err.Error(), test.message) {
			t.Fatalf("accepted invalid prompt groups %.80v: %v", test.groups, err)
		}
	}
	// The limit itself saves, and a group can be empty.
	settings.PromptGroups = slices.Clone(many[:maxPromptGroups])
	settings.Prompts = []Prompt{{ID: "a", Name: "One", Text: "text", Group: many[0].ID}}
	if saved, err := store.SaveSettings(settings); err != nil || len(saved.PromptGroups) != maxPromptGroups {
		t.Fatal("rejected prompt groups at the limit", err)
	}
}

func TestRemoteAccessSettings(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	settings, err := store.Settings()
	if err != nil || settings.RemoteOn || settings.RemoteHost != "" || settings.RemoteLogin != "" || settings.RemoteAccess() {
		t.Fatal("a new database turned remote access on", settings, err)
	}
	// The switch saves without the two values, and remote access stays off.
	settings.RemoteOn = true
	if settings, err = store.SaveSettings(settings); err != nil || !settings.RemoteOn || settings.RemoteAccess() {
		t.Fatal("the switch alone turned remote access on", settings, err)
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
	if saved, err := store.Settings(); err != nil || saved.RemoteHost != settings.RemoteHost || saved.RemoteLogin != settings.RemoteLogin || !saved.RemoteOn {
		t.Fatal(saved, err)
	}
	// The switch turns remote access off and keeps the two values.
	settings.RemoteOn = false
	if settings, err = store.SaveSettings(settings); err != nil || settings.RemoteAccess() || settings.RemoteHost != "my-mac.example.ts.net:8443" || settings.RemoteLogin != "User@Example.com" {
		t.Fatal("the switch did not turn remote access off", settings, err)
	}
	// A save of both values does not turn the switch on.
	settings.RemoteHost = "other.example.ts.net"
	if settings, err = store.SaveSettings(settings); err != nil || settings.RemoteOn || settings.RemoteAccess() {
		t.Fatal("a save of the values turned remote access on", settings, err)
	}
	settings.RemoteOn = true
	if settings, err = store.SaveSettings(settings); err != nil || !settings.RemoteAccess() {
		t.Fatal(settings, err)
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

func TestToolTypesModelsAndEfforts(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	settings, err := store.Settings()
	if err != nil {
		t.Fatal(err)
	}
	// A tool that the user adds is a Custom tool, also when its command starts an agent.
	settings.Tools = append(settings.Tools, Tool{ID: "search", Name: "Codex search", Command: "codex --search"}, Tool{ID: "script", Name: "Script", Command: "./run.sh"})
	settings.Tools[1].Model, settings.Tools[1].Effort = "opus", "high"
	settings.Tools[0].Permission, settings.Tools[1].Permission = "approve-for-me", "accept-edits"
	if settings, err = store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	if got := []string{settings.Tools[0].Type, settings.Tools[1].Type, settings.Tools[4].Type, settings.Tools[5].Type}; !slices.Equal(got, []string{"codex", "claude", "custom", "custom"}) {
		t.Fatal("wrong types", got)
	}
	if settings.Tools[1].Model != "opus" || settings.Tools[1].Effort != "high" {
		t.Fatal("the built-in tool lost its model", settings.Tools[1])
	}
	if saved, err := store.Settings(); err != nil || saved.Tools[0].Permission != "approve-for-me" || saved.Tools[1].Permission != "accept-edits" || saved.Tools[2].Permission != "" {
		t.Fatal("the built-in tools lost their permission modes", saved.Tools, err)
	}
	for _, change := range []func(*Settings){
		func(s *Settings) { s.Tools[4].Type = "codex" },
		func(s *Settings) { s.Tools[4].Model = "gpt-6-luna" },
		func(s *Settings) { s.Tools[0].Model = "gpt 6" },
		func(s *Settings) { s.Tools[3].Effort = "high" },
		// A permission mode belongs to the type of the tool. A Custom tool has none.
		func(s *Settings) { s.Tools[0].Permission = "accept-edits" },
		func(s *Settings) { s.Tools[4].Permission = "approve-for-me" },
		func(s *Settings) { s.Tools[1].Permission = "bypassPermissions" },
	} {
		changed := settings
		changed.Tools = slices.Clone(settings.Tools)
		change(&changed)
		if _, err := store.SaveSettings(changed); err == nil {
			t.Fatal("accepted", changed.Tools)
		}
	}
}

func TestBuiltinToolsStayAndTurnOn(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	settings, err := store.Settings()
	if err != nil {
		t.Fatal(err)
	}
	// A save without the built-in tools keeps them, and they come first. A client cannot
	// make its own tool a built-in tool. A new tool starts on, also without the value.
	settings.Tools = []Tool{{ID: "mine", Name: "Mine", Command: "./mine.sh", Builtin: true}}
	settings, err = store.SaveSettings(settings)
	if err != nil || len(settings.Tools) != 5 || settings.Tools[4].ID != "mine" || settings.Tools[4].Builtin || !settings.Tools[4].Enabled || settings.Tools[0].ID != "builtin-codex" {
		t.Fatal("built-in tools did not stay", settings.Tools, err)
	}
	if !settings.CheckTools {
		t.Fatal("a save ended the tool check")
	}
	changed := settings
	changed.Tools = slices.Clone(settings.Tools)
	changed.Tools[0].Type = "claude"
	if _, err = store.SaveSettings(changed); err == nil {
		t.Fatal("changed the type of a built-in tool")
	}
	changed.Tools[0].Type = "codex"
	changed.DefaultTool = "builtin-codex"
	if _, err = store.SaveSettings(changed); err == nil || !strings.Contains(err.Error(), "is off") {
		t.Fatal("made a tool that is off the default tool", err)
	}
	// The check turns on the installed tools once. It turns no tool off.
	settings.Tools[1].Enabled = true
	if settings, err = store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	checked, err := store.FinishToolCheck(func(kind string) bool { return kind == "codex" })
	if err != nil || checked.CheckTools || checked.Revision != settings.Revision {
		t.Fatal("the check did not finish", checked, err)
	}
	on := map[string]bool{}
	for _, tool := range checked.Tools {
		on[tool.ID] = tool.Enabled
	}
	if want := map[string]bool{"mine": true, "builtin-codex": true, "builtin-claude": true, "builtin-agy": false, "builtin-code-puppy": false}; !maps.Equal(on, want) {
		t.Fatal("wrong tools after the check", on)
	}
	// A saved tool of the user turns off and on like a built-in tool.
	checked.Tools[4].Enabled = false
	if checked, err = store.SaveSettings(checked); err != nil || checked.Tools[4].Enabled {
		t.Fatal("a tool of the user did not turn off", checked.Tools, err)
	}
	// The name, the type, and the command of a built-in tool stay. The CLI path sets the
	// program of the command.
	changed = checked
	changed.Tools = slices.Clone(checked.Tools)
	changed.Tools[0].Name, changed.Tools[0].Command, changed.Tools[0].Path = "Renamed", "codex --search", "/opt/bin/codex"
	if changed, err = store.SaveSettings(changed); err != nil || changed.Tools[0].Name != "Codex" || changed.Tools[0].Command != "/opt/bin/codex --no-alt-screen" {
		t.Fatal("a save changed the name or the command of a built-in tool", changed.Tools[0], err)
	}
	changed.Tools[4].Path = "/opt/bin/mine"
	if _, err = store.SaveSettings(changed); err == nil || !strings.Contains(err.Error(), "only a built-in tool has a CLI path") {
		t.Fatal("a tool of the user got a CLI path", err)
	}
	again, err := store.FinishToolCheck(func(string) bool { return true })
	if err != nil || again.Revision != changed.Revision {
		t.Fatal("a second check changed the settings", again, err)
	}
}

func TestShellTurnsOffAndIsNoDefault(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	settings, _ := store.Settings()
	if settings.ShellOff || settings.DefaultTool != "" {
		t.Fatal("Shell is not the default of a new database", settings)
	}
	settings.ShellOff = true
	if _, err = store.SaveSettings(settings); err == nil || !strings.Contains(err.Error(), "Shell is off") {
		t.Fatal("Shell that is off stayed the default tool", err)
	}
	// The fallback skips Shell that is off, and a tool that is off.
	settings.Tools = append(settings.Tools, Tool{ID: "mine", Name: "Mine", Command: "./mine.sh", Enabled: true})
	if id, ok := FallbackTool(settings, ""); !ok || id != "mine" {
		t.Fatal("fallback", id, ok)
	}
	settings.DefaultTool = "mine"
	if settings, err = store.SaveSettings(settings); err != nil || !settings.ShellOff {
		t.Fatal(settings, err)
	}
	if _, ok := FallbackTool(settings, "mine"); ok {
		t.Fatal("found a fallback without a tool that is on")
	}
	settings.ShellOff = false
	if id, ok := FallbackTool(settings, "mine"); !ok || id != "" {
		t.Fatal("Shell is not the fallback", id, ok)
	}
}

func TestTitleSaveNeedsTheTestedCLIPath(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	settings, _ := store.Settings()
	for i := range settings.Tools {
		if settings.Tools[i].Type == "claude" {
			settings.Tools[i].Path = "/opt/a/claude"
		}
	}
	if settings, err = store.SaveSettings(settings); err != nil || settings.BuiltinPath("claude") != "/opt/a/claude" {
		t.Fatal(settings.BuiltinPath("claude"), err)
	}
	if _, err = store.SetTitleTool(TitleChoice{Tool: "claude", Model: "haiku"}, settings.Choice()); !errors.Is(err, ErrTitleChanged) {
		t.Fatal("saved a title tool that was tested with another CLI path", err)
	}
	if _, err = store.SetTitleTool(TitleChoice{Tool: "claude", Model: "haiku", Path: "/opt/a/claude"}, settings.Choice()); err != nil {
		t.Fatal(err)
	}
	// A title tool without an agent type has no CLI path.
	if _, err = store.SetTitleTool(TitleChoice{Tool: "apple"}, TitleChoice{Tool: "claude", Model: "haiku"}); err != nil {
		t.Fatal(err)
	}
}
