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
		cli("tool", "add", "--continue", "other {prompt}", "Other", "other")
	}
	settings := saved()
	if len(settings.Tools) != 2 || settings.Tools[0].Name != "Agent" || settings.Tools[1].ContinueCommand != "other {prompt}" || settings.DefaultTool != settings.Tools[0].ID {
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
	settings = saved()
	if settings.Appearance != "dark" || !settings.Worktree || settings.Base != "main" || settings.DefaultTool != settings.Tools[1].ID {
		t.Fatalf("settings after set: %+v", settings)
	}

	// The server validation applies to the CLI too.
	fails("appearance must be", "settings", "set", "appearance", "blue")
	fails("must contain {prompt} once", "tool", "add", "--continue", "other", "Other", "other")
	fails("worktree must be true or false", "settings", "set", "worktree", "maybe")
	fails("unknown settings key", "settings", "set", "theme", "dark")
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
