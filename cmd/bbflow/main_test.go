package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bbflow/internal/history"
	"bbflow/internal/server"
)

func TestInstanceDirectorySelection(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	original := instanceDirName
	t.Cleanup(func() { instanceDirName = original })
	sessions := make(map[string]string)
	ports := make(map[string]string)
	for _, name := range []string{".bbflow-dev", ".bbflow"} {
		directory := filepath.Join(home, name)
		store, err := history.Open(filepath.Join(directory, "history.sqlite"))
		if err != nil {
			t.Fatal(err)
		}
		session, err := store.CreateSession(name, home, "")
		store.Close()
		if err != nil {
			t.Fatal(err)
		}
		sessions[name] = session.ID
		ports[name] = startTestServer(t, directory)
	}
	if ports[".bbflow-dev"] == ports[".bbflow"] {
		t.Fatal("instances share a port")
	}
	for _, name := range []string{".bbflow-dev", ".bbflow"} {
		t.Run(name, func(t *testing.T) {
			instanceDirName = name
			t.Setenv("BBFLOW_DIR", "")
			directory := filepath.Join(home, name)
			if defaultInstanceDir() != directory {
				t.Fatal("wrong build default")
			}
			// The subprocess is a development binary. Select the release directory explicitly
			// for checks of both live archives.
			t.Setenv("BBFLOW_DIR", directory)
			result := queryCLI(t)
			if len(result.Rows) != 1 || result.Rows[0][0] != sessions[name] {
				t.Fatalf("wrong history: %+v", result)
			}
			other := ".bbflow"
			if name == other {
				other = ".bbflow-dev"
			}
			t.Setenv("BBFLOW_DIR", filepath.Join(home, other))
			result = queryCLI(t)
			if len(result.Rows) != 1 || result.Rows[0][0] != sessions[other] {
				t.Fatalf("environment override: %+v", result)
			}
			result = queryCLI(t, "--dir", directory)
			if len(result.Rows) != 1 || result.Rows[0][0] != sessions[name] {
				t.Fatalf("flag override: %+v", result)
			}
		})
	}
}

func TestRemovedConnectionFlags(t *testing.T) {
	for _, args := range [][]string{
		{"--port", "7331", "ui"},
		{"server", "start", "--port", "7331"},
		{"server", "start", "--data-dir", t.TempDir()},
		{"ui", "--port", "7331"},
		{"query", "--port", "7331", "SELECT 1"},
	} {
		if err := run(args); err == nil {
			t.Fatalf("accepted removed flag: %v", args)
		}
	}
}

func TestVersion(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "absent")
	cmd := testCommand("--dir", directory, "--version")
	output, err := cmd.CombinedOutput()
	if err != nil || string(output) != "bbflow dev\n" {
		t.Fatalf("version: %q %v", output, err)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("version accessed the instance: %v", err)
	}
	if err := run([]string{"--version", "server", "start"}); err == nil {
		t.Fatal("version accepted a command")
	}
}

func TestMain(m *testing.M) {
	if os.Getenv("BBFLOW_MENUBAR_CHILD") == "1" && os.Getenv("BBFLOW_TEST_MENU_HELPER") != "" {
		menuBarFixture()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--fixture-agent" {
		fixtureAgent()
		return
	}
	// Test the management CLI in a subprocess.
	if os.Getenv("BBFLOW_TEST_CLI") == "1" {
		// Update fixtures act as release builds.
		if v := os.Getenv("BBFLOW_TEST_VERSION"); v != "" {
			version = v
		}
		// Runtime tests do not add native menus. The menu tests use a fixture companion.
		if os.Getenv("BBFLOW_TEST_MENU_HELPER") == "" {
			menuBar = "off"
		}
		// The built-in tools stay off, whatever CLIs this computer has.
		server.InstalledTools = func(context.Context, map[string]string) (map[string]bool, error) { return map[string]bool{}, nil }
		if path := os.Getenv("BBFLOW_TEST_EXECUTABLE"); path != "" {
			executablePath = func() (string, error) { return path, nil }
		}
		main()
		return
	}
	os.Setenv("SHELL", "/bin/sh")
	os.Setenv("ENV", "")
	os.Setenv("PS1", "BBFLOW_SHELL_PROMPT> ")
	os.Exit(m.Run())
}

func queryCLI(t *testing.T, global ...string) history.QueryResult {
	t.Helper()
	output, err := testCommand(append(global, "query", "SELECT id FROM sessions")...).CombinedOutput()
	var result history.QueryResult
	if err != nil || json.Unmarshal(output, &result) != nil {
		t.Fatalf("query: %s %v", output, err)
	}
	return result
}

func TestSessionCommandsRemoved(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "absent")
	for _, action := range []string{"new", "list", "resume", "stop"} {
		err := run([]string{"--dir", directory, "session", action})
		if err == nil || !strings.Contains(err.Error(), `unknown command "session"`) {
			t.Fatalf("session %s: %v", action, err)
		}
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatal("removed commands accessed the instance", err)
	}
}
