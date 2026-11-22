package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bbflow/internal/history"
)

func TestTitleToolCommandTestsBeforeItSaves(t *testing.T) {
	directory := t.TempDir()
	// Synthetic title CLIs on the PATH of the server. Code Puppy passes the title test,
	// Codex fails it, and my-llm is a custom command that reads standard input.
	bin := t.TempDir()
	for name, script := range map[string]string{
		"code-puppy": "echo 'bbflow-title: Fix login redirect'",
		"codex":      "cat >/dev/null; echo 'not signed in' >&2; exit 1",
		"my-llm":     "grep -q 'login page' && echo 'bbflow-title: Custom login title'",
	} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+script+"\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	startTestServer(t, directory)
	run := func(args ...string) (stdout, stderr string, err error) {
		t.Helper()
		var out, errors bytes.Buffer
		cmd := testCommand(append([]string{"title-tool"}, args...)...)
		cmd.Stdout, cmd.Stderr = &out, &errors
		err = cmd.Run()
		return out.String(), errors.String(), err
	}
	passes := func(args ...string) (stdout, stderr string) {
		t.Helper()
		stdout, stderr, err := run(args...)
		if err != nil {
			t.Fatalf("%v: %v\n%s%s", args, err, stdout, stderr)
		}
		return stdout, stderr
	}
	fails := func(want string, args ...string) {
		t.Helper()
		if stdout, stderr, err := run(args...); err == nil || !strings.Contains(stderr, want) {
			t.Fatalf("%v: want error %q, got %v\n%s%s", args, want, err, stdout, stderr)
		}
	}
	saved := func() history.Settings {
		t.Helper()
		output, err := testCommand("settings", "get").Output()
		var settings history.Settings
		if err == nil {
			err = json.Unmarshal(output, &settings)
		}
		if err != nil {
			t.Fatal(err)
		}
		return settings
	}

	// list prints the exact command of each built-in tool.
	if stdout, _ := passes("list"); !strings.Contains(stdout, "code-puppy  code-puppy --no-tools --model codex-gpt-6-luna -p \"$(cat)\"\n") ||
		!strings.Contains(stdout, "apple       /usr/bin/fm respond --model system ") || strings.Contains(stdout, "custom") {
		t.Fatal(stdout)
	}
	if stdout, _ := passes("show"); stdout != "Title tool: None. Automatic titles are off.\n" {
		t.Fatal(stdout)
	}

	stdout, stderr := passes("set", "code-puppy")
	if !strings.Contains(stderr, "Testing Code Puppy with this command:\n  code-puppy --no-tools --model codex-gpt-6-luna -p \"$(cat)\"\nThis can take up to 90 seconds.\n") ||
		stdout != "Code Puppy is configured. Its test made the title \"Fix login redirect\" from a sample message.\n" {
		t.Fatalf("set code-puppy:\n%s%s", stdout, stderr)
	}
	if stdout, _ = passes("show"); !strings.HasPrefix(stdout, "Title tool: Code Puppy (built-in)\nCommand: code-puppy --no-tools ") ||
		!strings.Contains(stdout, "bbflow supplies this command. A later release can change it.") {
		t.Fatal(stdout)
	}
	before := saved()
	if before.TitleTool != "code-puppy" {
		t.Fatalf("saved: %+v", before)
	}

	// A failed test, a wrong argument, and an unknown tool save nothing.
	fails("bbflow: Codex is not configured. The title tool is still Code Puppy. The test failed: the command ended with exit status 1: not signed in", "set", "codex")
	fails("only the custom title tool takes a command", "set", "codex", "codex exec -")
	fails("enter a command for the custom title tool", "set", "custom")
	fails("title tool must be one of none, claude, codex, code-puppy, apple, custom", "set", "claude -p")
	fails("provide one title tool", "set")
	fails("title-tool list takes no arguments", "list", "all")
	fails("unknown title-tool command", "use", "codex")
	if after := saved(); after.Revision != before.Revision || after.TitleTool != "code-puppy" {
		t.Fatalf("a rejected change saved settings: %+v", after)
	}

	// Custom saves its command after its test. test runs the saved tool and saves nothing.
	stdout, stderr = passes("set", "custom", "my-llm --fast")
	if !strings.Contains(stderr, "Testing Custom with this command:\n  my-llm --fast\n") ||
		stdout != "Custom is configured. Its test made the title \"Custom login title\" from a sample message.\n" {
		t.Fatalf("set custom:\n%s%s", stdout, stderr)
	}
	if stdout, _ = passes("show"); stdout != "Title tool: Custom\nCommand: my-llm --fast\nThis is your own command. bbflow does not limit what it can do.\n" {
		t.Fatal(stdout)
	}
	custom := saved()
	if stdout, _ = passes("test"); stdout != "Test passed. Custom made the title \"Custom login title\" from a sample message.\n" {
		t.Fatal(stdout)
	}
	if after := saved(); after.Revision != custom.Revision || after.TitleTool != "custom" || after.TitleCommand != "my-llm --fast" {
		t.Fatalf("test changed settings: %+v", after)
	}

	// None saves without a test and keeps the custom command. Custom without a command
	// then tests the saved command again.
	if stdout, stderr = passes("set", "none"); stdout != "Automatic titles are off.\n" || stderr != "" {
		t.Fatalf("set none:\n%s%s", stdout, stderr)
	}
	if stdout, _ = passes("show"); stdout != "Title tool: None. Automatic titles are off.\nSaved custom command: my-llm --fast\n" {
		t.Fatal(stdout)
	}
	fails("the title tool is None, so there is nothing to test", "test")
	if stdout, _ = passes("set", "custom"); !strings.HasPrefix(stdout, "Custom is configured.") || saved().TitleTool != "custom" {
		t.Fatal(stdout)
	}
}
