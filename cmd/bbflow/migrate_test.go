package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
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

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	output, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %s %v", args, output, err)
	}
	return strings.TrimSpace(string(output))
}

// bonbonWorktree adds a managed worktree and a session that uses it to a stopped BonBon
// instance. It returns the worktree path.
func bonbonWorktree(t *testing.T, directory, repository, name string) string {
	t.Helper()
	directory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "worktrees", name)
	runGit(t, repository, "worktree", "add", "-q", "-b", "bbflow/"+name, path)
	store, err := history.Open(filepath.Join(directory, "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	session, err := store.CreateSession("worktree "+name, path, history.GeneralProjectID)
	if err != nil {
		t.Fatal(err)
	}
	commit := runGit(t, repository, "rev-parse", "HEAD")
	if err = store.SaveWorktree(session.ID, history.Worktree{Path: path, Repository: repository,
		Base: "main", Commit: commit, Branch: "bbflow/" + name, State: "ready"}); err != nil {
		t.Fatal(err)
	}
	return path
}

func gitRepository(t *testing.T) string {
	t.Helper()
	repository, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"config", "user.name", "Fixture"},
		{"config", "user.email", "fixture@example.invalid"}, {"commit", "-q", "--allow-empty", "-m", "fixture"}} {
		runGit(t, repository, args...)
	}
	return repository
}

// workspaces returns the workspace of each session and the path of each ready worktree.
func workspaces(t *testing.T, database string) map[string]string {
	t.Helper()
	store, err := history.Open(database)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	sessions, err := store.ListSessions(history.SessionFilter{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	result := map[string]string{}
	for _, session := range sessions {
		result[session.Title] = session.Workspace
		if session.Worktree != nil {
			result[session.Title+" worktree"] = session.Worktree.Path
		}
	}
	return result
}

func TestMigrateMovesBonBonWorktrees(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	source, target := filepath.Join(root, "bonbon"), filepath.Join(root, "bbflow")
	repository := gitRepository(t)
	bonbonInstance(t, source)
	saved := bonbonWorktree(t, source, repository, "20261005-101046-0c0b60ea")
	if err = os.WriteFile(filepath.Join(saved, "notes.txt"), []byte("uncommitted"), 0600); err != nil {
		t.Fatal(err)
	}
	locked := bonbonWorktree(t, source, repository, "20261028-080958-c1626088")
	runGit(t, repository, "worktree", "lock", locked)
	before := sha256.Sum256(must(os.ReadFile(filepath.Join(source, "history.sqlite"))))

	output, err := testCommand("--dir", target, "migrate", "--from", source).CombinedOutput()
	if err != nil {
		t.Fatalf("migrate: %s %v", output, err)
	}
	moved := filepath.Join(target, "worktrees", filepath.Base(saved))
	for _, text := range []string{"Copied BonBon history", "Moved these worktrees", saved + " -> " + moved,
		"Did not move these worktrees", locked + ": ", "still use these folders"} {
		if !strings.Contains(string(output), text) {
			t.Fatalf("migrate output has no %q:\n%s", text, output)
		}
	}
	if sha256.Sum256(must(os.ReadFile(filepath.Join(source, "history.sqlite")))) != before {
		t.Fatal("changed the BonBon database")
	}
	if _, err = os.Stat(saved); !os.IsNotExist(err) {
		t.Fatal("the old worktree folder remains", err)
	}
	if data, err := os.ReadFile(filepath.Join(moved, "notes.txt")); err != nil || string(data) != "uncommitted" {
		t.Fatal("lost an uncommitted file", err)
	}
	if top := runGit(t, moved, "rev-parse", "--show-toplevel"); top != moved {
		t.Fatalf("git sees the moved worktree at %s", top)
	}
	if list := runGit(t, repository, "worktree", "list", "--porcelain"); !strings.Contains(list, "worktree "+moved+"\n") || strings.Contains(list, saved+"\n") {
		t.Fatalf("git worktree list:\n%s", list)
	}
	want := map[string]string{
		"BonBon session":                             filepath.Join(source, "workspaces", "general"),
		"worktree 20261005-101046-0c0b60ea":          moved,
		"worktree 20261005-101046-0c0b60ea worktree": moved,
		"worktree 20261028-080958-c1626088":          locked,
		"worktree 20261028-080958-c1626088 worktree": locked,
	}
	if got := workspaces(t, filepath.Join(target, "history.sqlite")); !reflect.DeepEqual(got, want) {
		t.Fatalf("workspaces:\n%v\nwant\n%v", got, want)
	}
}

// Releases before 0.0.9 copied the history but left the worktrees in the BonBon
// directory. A later migrate moves them and does not copy the history again.
func TestMigrateAfterEarlierCopyMovesWorktrees(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	source, target := filepath.Join(root, "bonbon"), filepath.Join(root, "bbflow")
	repository := gitRepository(t)
	bonbonInstance(t, source)
	saved := bonbonWorktree(t, source, repository, "20261115-224357-7c19da17")
	if _, err = history.CopyFrom(filepath.Join(source, "history.sqlite"), filepath.Join(target, "history.sqlite")); err != nil {
		t.Fatal(err)
	}
	// bbflow ran on the copy before this release.
	for _, action := range []string{"start", "stop"} {
		if output, err := testCommand("--dir", target, "server", action).CombinedOutput(); err != nil {
			t.Fatalf("server %s: %s %v", action, output, err)
		}
	}
	// The user can remove the BonBon database after the copy.
	if err = os.Remove(filepath.Join(source, "history.sqlite")); err != nil {
		t.Fatal(err)
	}

	output, err := testCommand("--dir", target, "migrate", "--from", source).CombinedOutput()
	if err != nil {
		t.Fatalf("migrate: %s %v", output, err)
	}
	moved := filepath.Join(target, "worktrees", filepath.Base(saved))
	for _, text := range []string{"was not copied again", saved + " -> " + moved} {
		if !strings.Contains(string(output), text) {
			t.Fatalf("migrate output has no %q:\n%s", text, output)
		}
	}
	if strings.Contains(string(output), "Copied BonBon history") {
		t.Fatalf("copied the history again:\n%s", output)
	}
	got := workspaces(t, filepath.Join(target, "history.sqlite"))
	if got["worktree 20261115-224357-7c19da17"] != moved || got["worktree 20261115-224357-7c19da17 worktree"] != moved {
		t.Fatalf("workspaces: %v", got)
	}

	output, err = testCommand("--dir", target, "migrate", "--from", source).CombinedOutput()
	if err != nil || !strings.Contains(string(output), "No BonBon worktrees to move") {
		t.Fatalf("second migrate: %s %v", output, err)
	}
}

func must[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}
