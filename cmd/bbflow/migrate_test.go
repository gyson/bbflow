package main

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"syscall"
	"testing"

	"bbflow/internal/client"
	"bbflow/internal/history"
)

// bonbonInstance writes a stopped BonBon instance with one session.
func bonbonInstance(t *testing.T, directory string) {
	t.Helper()
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	// The server records canonical workspace paths.
	directory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	store, err := history.Open(filepath.Join(directory, "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if err = store.EnsureGeneral(filepath.Join(directory, "workspaces", "general")); err != nil {
		t.Fatal(err)
	}
	if _, err = store.CreateSession("BonBon session", filepath.Join(directory, "workspaces", "general"), history.GeneralProjectID); err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"server.lock", "server-control.lock"} {
		if err = os.WriteFile(filepath.Join(directory, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

// directoryState returns the content of each file. bbflow server commands create lock
// files in their own directory, so the state omits lock files.
func directoryState(t *testing.T, directory string) map[string]string {
	t.Helper()
	state := map[string]string{}
	err := filepath.WalkDir(directory, func(path string, entry os.DirEntry, err error) error {
		if os.IsNotExist(err) && path == directory {
			return nil
		}
		if err != nil || entry.IsDir() || filepath.Ext(path) == ".lock" {
			return err
		}
		data, err := os.ReadFile(path)
		state[path] = string(data)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func holdLock(t *testing.T, path string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { file.Close() })
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateCopiesBonBonHistory(t *testing.T) {
	root := t.TempDir()
	source, target := filepath.Join(root, "bonbon"), filepath.Join(root, "bbflow")
	bonbonInstance(t, source)
	before := directoryState(t, source)
	output, err := testCommand("--dir", target, "migrate", "--from", source).CombinedOutput()
	if err != nil {
		t.Fatalf("migrate: %s %v", output, err)
	}
	for _, text := range []string{"Copied BonBon history", "1 sessions", "was not changed", filepath.Join("workspaces", "general")} {
		if !strings.Contains(string(output), text) {
			t.Fatalf("migrate output has no %q:\n%s", text, output)
		}
	}
	if after := directoryState(t, source); !reflect.DeepEqual(before, after) {
		t.Fatalf("migrate changed the BonBon directory:\n%v\n%v", keys(before), keys(after))
	}
	startTestServer(t, target)
	if result := queryCLI(t, "--dir", target); len(result.Rows) != 1 {
		t.Fatalf("bbflow has %d sessions after migrate", len(result.Rows))
	}
	output, err = testCommand("--dir", target, "migrate", "--from", source).CombinedOutput()
	if err == nil {
		t.Fatalf("migrate ran again while bbflow runs: %s", output)
	}
}

func TestMigrateRefusesWithoutChanges(t *testing.T) {
	cases := []struct {
		name    string
		setup   func(t *testing.T, source, target string)
		message string
	}{
		{"BonBon running", func(t *testing.T, source, target string) {
			holdLock(t, filepath.Join(source, "server.lock"))
		}, "bonbon server stop"},
		{"bbflow running", func(t *testing.T, source, target string) {
			if err := os.MkdirAll(target, 0700); err != nil {
				t.Fatal(err)
			}
			holdLock(t, filepath.Join(target, "server.lock"))
		}, "bbflow server stop"},
		{"bbflow history exists", func(t *testing.T, source, target string) {
			bonbonInstance(t, target)
		}, "already exists"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			source, target := filepath.Join(root, "bonbon"), filepath.Join(root, "bbflow")
			bonbonInstance(t, source)
			tc.setup(t, source, target)
			before, beforeTarget := directoryState(t, source), directoryState(t, target)
			output, err := testCommand("--dir", target, "migrate", "--from", source).CombinedOutput()
			if err == nil || !strings.Contains(string(output), tc.message) {
				t.Fatalf("%s %v", output, err)
			}
			if after := directoryState(t, source); !reflect.DeepEqual(before, after) {
				t.Fatal("changed the BonBon directory")
			}
			if after := directoryState(t, target); !reflect.DeepEqual(beforeTarget, after) {
				t.Fatal("changed the bbflow directory")
			}
		})
	}
	t.Run("same directory", func(t *testing.T) {
		source := t.TempDir()
		bonbonInstance(t, source)
		output, err := testCommand("--dir", source, "migrate", "--from", source).CombinedOutput()
		if err == nil || !strings.Contains(string(output), "are the same") {
			t.Fatalf("%s %v", output, err)
		}
	})
}

func TestFirstStartRequiresMigrate(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("BBFLOW_DIR", "")
	bonbonInstance(t, filepath.Join(home, ".bonbon-dev"))
	output, err := testCommand("server", "start").CombinedOutput()
	if err == nil || !strings.Contains(string(output), "Run bbflow migrate") {
		t.Fatalf("started over BonBon history: %s %v", output, err)
	}
	if _, err = os.Stat(filepath.Join(home, ".bbflow-dev", "history.sqlite")); !os.IsNotExist(err) {
		t.Fatal("created bbflow history", err)
	}
	// Another directory starts without the BonBon history.
	other := filepath.Join(home, "other")
	if err = checkBonBonHistory(clientTarget(t, other)); err != nil {
		t.Fatal(err)
	}
	output, err = testCommand("migrate").CombinedOutput()
	if err != nil {
		t.Fatalf("migrate: %s %v", output, err)
	}
	if err = checkBonBonHistory(clientTarget(t, filepath.Join(home, ".bbflow-dev"))); err != nil {
		t.Fatal("still refused after migrate:", err)
	}
}

func clientTarget(t *testing.T, directory string) client.Target {
	t.Helper()
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	path, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	return client.Target{Dir: path}
}

func keys(state map[string]string) []string {
	var names []string
	for name, data := range state {
		names = append(names, fmt.Sprintf("%s (%d bytes)", filepath.Base(name), len(data)))
	}
	sort.Strings(names)
	return names
}
