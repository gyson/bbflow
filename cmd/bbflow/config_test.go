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
	// own returns the tools that the user added, without the built-in tools.
	own := func(settings history.Settings) []history.Tool {
		var tools []history.Tool
		for _, tool := range settings.Tools {
			if !tool.Builtin {
				tools = append(tools, tool)
			}
		}
		return tools
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
	if tools := own(settings); len(tools) != 2 || tools[0].Name != "Agent" || tools[1].Command != "other" || settings.DefaultTool != tools[0].ID {
		t.Fatalf("tools after add: %+v", settings)
	}
	agent := own(settings)[0].ID
	if output := cli("tool", "add", "Agent", "agent --slow"); !strings.Contains(output, `Updated tool "Agent"`) {
		t.Fatal(output)
	}
	if settings = saved(); own(settings)[0].ID != agent || own(settings)[0].Command != "agent --slow" {
		t.Fatalf("tools after update: %+v", settings)
	}
	// The list is text with one tool on each line. Tabs divide the name, the command, and
	// on or off. The built-in tools come first in a new instance. The test server finds no
	// CLI, so they are off.
	builtins := "Codex\tcodex --no-alt-screen\toff\nClaude Code\tclaude\toff\nAntigravity\tagy\toff\nCode Puppy\tcode-puppy\toff\n"
	if output := cli("tool", "list"); output != builtins+"Agent\tagent --slow\ton\nOther\tother\ton\n" {
		t.Fatalf("tool list: %q", output)
	}
	// A built-in tool turns on and off, and remove does not remove it. A tool that is off
	// cannot be the default tool, so disable selects Shell.
	fails("is a built-in tool", "tool", "remove", "Codex")
	fails("bbflow keeps its command", "tool", "add", "Codex", "codex --search")
	fails("is off", "settings", "set", "default-tool", "Codex")
	cli("tool", "enable", "Codex")
	cli("settings", "set", "default-tool", "Codex")
	if output := cli("tool", "disable", "Codex"); output != "Turned off tool \"Codex\".\nShell is now the default tool.\n" {
		t.Fatalf("disable the default tool: %q", output)
	}
	// Shell turns off with the settings key shell. Shell that is off cannot be the default
	// tool, so the first tool that is on becomes the default.
	cli("settings", "set", "default-tool", "")
	if output := cli("settings", "set", "shell", "false"); output != "Saved shell: false.\n" {
		t.Fatalf("set shell: %q", output)
	}
	if output := cli("settings", "get", "default-tool"); output != "Agent\n" {
		t.Fatalf("default after Shell turned off: %q", output)
	}
	fails("Shell is off", "settings", "set", "default-tool", "")
	cli("settings", "set", "shell", "true")
	cli("settings", "set", "default-tool", "Agent")
	// A tool that the user added turns off too. It stays saved, and add keeps it off.
	cli("tool", "disable", "Agent")
	cli("tool", "add", "Agent", "agent --slow")
	if output := cli("tool", "list"); !strings.Contains(output, "Agent\tagent --slow\toff\n") {
		t.Fatalf("tool list after disable: %q", output)
	}
	// The default tool must be on, so --default turns the tool on.
	cli("tool", "add", "--default", "Agent", "agent --slow")
	if output := cli("tool", "list"); !strings.Contains(output, "Agent\tagent --slow\ton\n") {
		t.Fatalf("tool list after add --default: %q", output)
	}
	// The flag package reads an option only before NAME.
	fails("put --default before NAME", "tool", "add", "Agent", "agent --slow", "--default")
	fails("put --default before NAME", "tool", "add", "Agent", "--default")
	// After the option terminator, --default is a name.
	if output := cli("tool", "add", "--", "--default", "true"); !strings.Contains(output, `Added tool "--default"`) {
		t.Fatal(output)
	}
	if output := cli("tool", "add", "--default", "--", "--default", "false"); !strings.Contains(output, `Updated tool "--default"`) {
		t.Fatal(output)
	}
	if settings = saved(); own(settings)[2].Command != "false" || settings.DefaultTool != own(settings)[2].ID {
		t.Fatalf("tool with the name of the option: %+v", settings)
	}
	cli("tool", "remove", "--", "--default")
	cli("settings", "set", "default-tool", "Agent")

	// Each set prints the saved value. A get of one key prints it in the form of set.
	if output := cli("settings", "set", "appearance", "dark"); output != "Saved appearance: dark.\n" {
		t.Fatalf("set appearance: %q", output)
	}
	cli("settings", "set", "worktree", "true")
	cli("settings", "set", "base", "main")
	if output := cli("settings", "set", "default-tool", "Other"); output != "Saved default-tool: Other.\n" {
		t.Fatalf("set default-tool: %q", output)
	}
	for key, want := range map[string]string{"appearance": "dark", "worktree": "true", "base": "main", "default-tool": "Other", "update-check": "true", "port": "0", "remote": "false"} {
		if output := cli("settings", "get", key); output != want+"\n" {
			t.Fatalf("get %s: %q", key, output)
		}
	}
	// The server replaces an empty base by HEAD, and the command prints the saved value.
	if output := cli("settings", "set", "base", ""); output != "Saved base: HEAD.\n" {
		t.Fatalf("set empty base: %q", output)
	}
	cli("settings", "set", "base", "main")
	// The restart note prints only when the port changes.
	if output := cli("settings", "set", "port", "0"); output != "Saved port: 0, the automatic port.\n" {
		t.Fatalf("set the same port: %q", output)
	}
	if settings := saved(); settings.TitleTool != "none" || !settings.UpdateCheck {
		t.Fatal("automatic titles are on or the update check is off by default", settings)
	}
	cli("settings", "set", "update-check", "false")
	settings = saved()
	if settings.Appearance != "dark" || !settings.Worktree || settings.Base != "main" || settings.DefaultTool != own(settings)[1].ID || settings.TitleTool != "none" || settings.UpdateCheck {
		t.Fatalf("settings after set: %+v", settings)
	}

	// The server validation applies to the CLI too.
	fails("appearance must be", "settings", "set", "appearance", "blue")
	fails("tool command is required", "tool", "add", "Other", " ")
	fails("worktree must be true or false", "settings", "set", "worktree", "maybe")
	fails("worktree must be true or false", "settings", "set", "worktree", "1")
	fails("update-check must be true or false", "settings", "set", "update-check", "daily")
	fails("remote must be true or false", "settings", "set", "remote", "on")
	fails("port must be from 1024 to 65535", "settings", "set", "port", "80")
	fails("port must be from 1024 to 65535", "settings", "set", "port", "auto")
	fails("remote host must be a DNS name", "settings", "set", "remote-host", "localhost")
	fails("Tailscale login must be", "settings", "set", "remote-login", "two words")
	fails("unknown settings key", "settings", "set", "theme", "dark")
	fails("unknown settings key", "settings", "get", "theme")
	fails("settings get takes at most one key", "settings", "get", "base", "port")
	// bbflow title-tool selects the title tool.
	fails("use bbflow title-tool set TOOL", "settings", "set", "title-tool", "codex")
	fails("use bbflow title-tool show", "settings", "get", "title-tool")
	fails(`tool "Absent" does not exist`, "tool", "remove", "Absent")
	fails(`tool "Absent" does not exist`, "settings", "set", "default-tool", "Absent")
	if after := saved(); after.Revision != settings.Revision {
		t.Fatal("a rejected change saved settings")
	}

	// Removal of the default tool selects Shell.
	cli("tool", "remove", "Other")
	settings = saved()
	if len(own(settings)) != 1 || settings.DefaultTool != "" {
		t.Fatalf("settings after remove: %+v", settings)
	}

	// A tool can have the name Shell. Only an empty value selects the built-in Shell.
	cli("tool", "add", "shell", "bash -l")
	cli("settings", "set", "default-tool", "shell")
	if settings = saved(); settings.DefaultTool != own(settings)[1].ID {
		t.Fatalf("named shell tool is not the default: %+v", settings)
	}
	if output := cli("settings", "set", "default-tool", ""); output != "Saved default-tool: the built-in Shell.\n" {
		t.Fatalf("set the built-in Shell: %q", output)
	}
	if settings = saved(); settings.DefaultTool != "" {
		t.Fatalf("empty value did not select Shell: %+v", settings)
	}
	// The built-in Shell is the empty value, as in set.
	if output := cli("settings", "get", "default-tool"); output != "\n" {
		t.Fatalf("get the built-in Shell: %q", output)
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
	// settings set cannot select the default tool by a name that two tools have, so get
	// does not print that name.
	settings = saved()
	settings.DefaultTool = "copy"
	if _, err := (client.Target{Dir: directory}).Call(protocol.Request{Operation: "settings-save", Settings: &settings}); err != nil {
		t.Fatal(err)
	}
	fails("more than one tool has the name", "settings", "get", "default-tool")
	cli("settings", "set", "default-tool", "")

	// A save without the tools that the user added keeps the built-in tools.
	settings = saved()
	settings.Tools = nil
	if _, err := (client.Target{Dir: directory}).Call(protocol.Request{Operation: "settings-save", Settings: &settings}); err != nil {
		t.Fatal(err)
	}
	if output := cli("tool", "list"); output != builtins {
		t.Fatalf("tool list with only the built-in tools: %q", output)
	}
}

func TestChangeSettingsAppliesTheChangeAgainAfterAConflict(t *testing.T) {
	directory := t.TempDir()
	startTestServer(t, directory)
	target := client.Target{Dir: directory}
	conflict := true
	saved, err := changeSettings(target, func(settings *history.Settings) error {
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
	if err != nil || settings.Appearance != "light" || settings.Base != "main" || saved.Revision != settings.Revision {
		t.Fatalf("change after conflict: %+v %+v %v", settings, saved, err)
	}
}
