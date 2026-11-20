package main

import (
	"encoding/json"
	"strings"
	"testing"

	"bbflow/internal/client"
	"bbflow/internal/history"
	"bbflow/internal/protocol"
)

func TestToolAndSettingsCommandsEditSavedSettings(t *testing.T) {
	directory := t.TempDir()
	startTestServer(t, directory)
	cli := func(args ...string) string {
		t.Helper()
		output, err := testCommand(args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %s %v", args, output, err)
		}
		return string(output)
	}
	fails := func(want string, args ...string) {
		t.Helper()
		output, err := testCommand(args...).CombinedOutput()
		if err == nil || !strings.Contains(string(output), want) {
			t.Fatalf("%v: want error %q, got %s %v", args, want, output, err)
		}
	}
	saved := func() history.Settings {
		t.Helper()
		var settings history.Settings
		if err := json.Unmarshal([]byte(cli("settings", "get")), &settings); err != nil {
			t.Fatal(err)
		}
		return settings
	}

	// A setup script can run again. The second add updates the same tool.
	for range 2 {
		cli("tool", "add", "--default", "Agent", "agent --fast")
		cli("tool", "add", "Other", "other")
	}
	settings := saved()
	if len(settings.Tools) != 2 || settings.Tools[0].Name != "Agent" || settings.Tools[1].Command != "other" || settings.DefaultTool != settings.Tools[0].ID {
		t.Fatalf("tools after add: %+v", settings)
	}
	agent := settings.Tools[0].ID
	if output := cli("tool", "add", "Agent", "agent --slow"); !strings.Contains(output, `Updated tool "Agent"`) {
		t.Fatal(output)
	}
	var tools []history.Tool
	if err := json.Unmarshal([]byte(cli("tool", "list")), &tools); err != nil || tools[0].ID != agent || tools[0].Command != "agent --slow" {
		t.Fatalf("tool list: %+v %v", tools, err)
	}

	cli("settings", "set", "appearance", "dark")
	cli("settings", "set", "worktree", "true")
	cli("settings", "set", "base", "main")
	cli("settings", "set", "default-tool", "Other")
	if settings := saved(); settings.TitleTool != "none" || !settings.UpdateCheck {
		t.Fatal("automatic titles are on or the update check is off by default", settings)
	}
	cli("settings", "set", "title-tool", "code-puppy")
	cli("settings", "set", "update-check", "false")
	settings = saved()
	if settings.Appearance != "dark" || !settings.Worktree || settings.Base != "main" || settings.DefaultTool != settings.Tools[1].ID || settings.TitleTool != "code-puppy" || settings.UpdateCheck {
		t.Fatalf("settings after set: %+v", settings)
	}

	// The server validation applies to the CLI too.
	fails("appearance must be", "settings", "set", "appearance", "blue")
	fails("tool command is required", "tool", "add", "Other", " ")
	fails("worktree must be true or false", "settings", "set", "worktree", "maybe")
	fails("update-check must be true or false", "settings", "set", "update-check", "daily")
	fails("port must be from 1024 to 65535", "settings", "set", "port", "80")
	fails("port must be from 1024 to 65535", "settings", "set", "port", "auto")
	fails("unknown settings key", "settings", "set", "theme", "dark")
	fails("title tool must be one of none, claude, codex, code-puppy", "settings", "set", "title-tool", "claude -p")
	fails(`tool "Absent" does not exist`, "tool", "remove", "Absent")
	fails(`tool "Absent" does not exist`, "settings", "set", "default-tool", "Absent")
	if after := saved(); after.Revision != settings.Revision {
		t.Fatal("a rejected change saved settings")
	}

	// Removal of the default tool selects Shell.
	cli("tool", "remove", "Other")
	settings = saved()
	if len(settings.Tools) != 1 || settings.DefaultTool != "" {
		t.Fatalf("settings after remove: %+v", settings)
	}

	// A tool can have the name Shell. Only an empty value selects the built-in Shell.
	cli("tool", "add", "shell", "bash -l")
	cli("settings", "set", "default-tool", "shell")
	if settings = saved(); settings.DefaultTool != settings.Tools[1].ID {
		t.Fatalf("named shell tool is not the default: %+v", settings)
	}
	cli("settings", "set", "default-tool", "")
	if settings = saved(); settings.DefaultTool != "" {
		t.Fatalf("empty value did not select Shell: %+v", settings)
	}
	fails(`use "" for the built-in Shell`, "settings", "set", "default-tool", "Shell")
	cli("tool", "remove", "shell")
	settings = saved()

	// The CLI cannot choose between tools with the same name.
	settings.Tools = append(settings.Tools, history.Tool{ID: "copy", Name: "Agent", Command: "agent"})
	if _, err := (client.Target{Dir: directory}).Call(protocol.Request{Operation: "settings-save", Settings: &settings}); err != nil {
		t.Fatal(err)
	}
	fails("more than one tool has the name", "tool", "add", "Agent", "agent")
	fails("more than one tool has the name", "tool", "remove", "Agent")
}

func TestChangeSettingsAppliesTheChangeAgainAfterAConflict(t *testing.T) {
	directory := t.TempDir()
	startTestServer(t, directory)
	target := client.Target{Dir: directory}
	conflict := true
	err := changeSettings(target, func(settings *history.Settings) error {
		if conflict {
			// Another client saves after this client read the settings.
			conflict = false
			other := *settings
			other.Appearance = "light"
			if _, err := target.Call(protocol.Request{Operation: "settings-save", Settings: &other}); err != nil {
				return err
			}
		}
		settings.Base = "main"
		return nil
	})
	settings, _ := loadSettings(target)
	if err != nil || settings.Appearance != "light" || settings.Base != "main" {
		t.Fatalf("change after conflict: %+v %v", settings, err)
	}
}
