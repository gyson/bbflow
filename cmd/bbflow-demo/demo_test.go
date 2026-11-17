package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"testing"

	"bbflow/internal/client"
	"bbflow/internal/history"
	"bbflow/internal/instance"
	"bbflow/internal/protocol"
)

// TestDemo seeds and cleans real servers with a built bbflow-demo. It finds a seed that
// no longer agrees with the server.
func TestDemo(t *testing.T) {
	if testing.Short() {
		t.Skip("builds two executables and starts real servers")
	}
	bin := t.TempDir()
	for name, pkg := range map[string]string{"bbflow": "bbflow/cmd/bbflow", "bbflow-demo": "."} {
		build := exec.Command("go", "build", "-o", filepath.Join(bin, name), pkg)
		build.Env = append(os.Environ(), "CGO_ENABLED=0")
		if output, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v\n%s", pkg, err, output)
		}
	}
	temporary := t.TempDir()
	demo := filepath.Join(temporary, "demo")
	other := filepath.Join(temporary, "other")
	execute := func(name, dir string, args ...string) (string, error) {
		command := exec.Command(filepath.Join(bin, name), append([]string{"--dir", dir}, args...)...)
		// /bin/sh keeps the test independent of the shell settings of the user.
		command.Env = append(os.Environ(), "SHELL=/bin/sh", "BBFLOW_DIR=")
		output, err := command.CombinedOutput()
		return string(output), err
	}
	pass := func(name, dir string, args ...string) string {
		t.Helper()
		output, err := execute(name, dir, args...)
		if err != nil {
			t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, output)
		}
		return output
	}
	// This runs before t.TempDir removes the folders.
	t.Cleanup(func() {
		for _, dir := range []string{demo, other} {
			execute("bbflow", dir, "server", "stop")
		}
	})
	target := client.Target{Dir: demo}
	expect := func(sql, want string) {
		t.Helper()
		result, err := target.Call(protocol.Request{Operation: "query", SQL: sql})
		var query history.QueryResult
		if err == nil {
			err = json.Unmarshal(result, &query)
		}
		if err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
		if got := fmt.Sprint(query.Rows); got != want {
			t.Errorf("%s:\n got %s\nwant %s", sql, got, want)
		}
	}

	// seed needs a running server.
	if output, err := execute("bbflow-demo", demo, "seed"); err == nil || !strings.Contains(output, "server start") {
		t.Fatalf("seed without a server: %v\n%s", err, output)
	}

	// seed adds the projects, tools, and sessions.
	pass("bbflow", demo, "server", "start", "--no-menubar")
	if output := pass("bbflow-demo", demo, "seed"); !regexp.MustCompile(`Added the demo data to .*\nURL: http://127\.0\.0\.1:\d+/\n`).MatchString(output) {
		t.Fatalf("seed output: %s", output)
	}
	expect("SELECT name FROM projects ORDER BY name", "[[General] [Orbit API] [Tide Web]]")
	expect("SELECT archived, count(*) FROM sessions GROUP BY archived ORDER BY archived", "[[0 6] [1 1]]")
	expect("SELECT status, count(*) FROM runs GROUP BY status ORDER BY status", "[[exited 3] [running 3] [stopped 1]]")
	expect("SELECT branch, state FROM worktrees", "[[demo/refactor-orbit ready]]")
	expect("SELECT count(*) FROM events WHERE kind='draft' AND CAST(data AS TEXT)->>'pending'=1", "[[4]]")
	expect("SELECT count(*) FROM events WHERE kind='draft' AND CAST(data AS TEXT)->>'text'='List the changes since the last release.'", "[[1]]")
	expect("SELECT group_concat(value->>'name', ','), data->>'$.defaultTool'=data->>'$.tools[0].id', data->>'$.worktree' FROM settings, json_each(data, '$.tools')",
		"[[Demo agent,Busy agent,Claude,Codex 1 1]]")
	expect("SELECT s.title, CAST(p.data AS TEXT)->>'worktree' FROM preparations p JOIN sessions s ON s.id=p.session_id WHERE p.state='draft'",
		"[[Plan release notes 1]]")

	// A second seed adds nothing and prints each session.
	output := pass("bbflow-demo", demo, "seed")
	expect("SELECT count(*) FROM sessions", "[[7]]")
	for _, state := range []string{"running", "ended", "draft", "archived"} {
		if !strings.Contains(output, "\n  "+state+" ") {
			t.Errorf("seed output has no %s session:\n%s", state, output)
		}
	}

	// The regular restart keeps the demo data.
	pass("bbflow", demo, "server", "restart", "--no-menubar")
	expect("SELECT count(*) FROM sessions", "[[7]]")
	expect("SELECT count(*) FROM runs WHERE status='running'", "[[0]]")

	// seed and clean refuse an instance with other data.
	pass("bbflow", other, "server", "start", "--no-menubar")
	if _, err := (client.Target{Dir: other}).Call(protocol.Request{Operation: "project-draft", Project: "general"}); err != nil {
		t.Fatal(err)
	}
	if output, err := execute("bbflow-demo", other, "seed"); err == nil || !strings.Contains(output, "already has projects or sessions") {
		t.Errorf("seed of an instance with a session: %v\n%s", err, output)
	}
	if output, err := execute("bbflow-demo", other, "clean", "--force"); err == nil || !strings.Contains(output, "is not a demo instance") {
		t.Errorf("clean of an instance that was not seeded: %v\n%s", err, output)
	}
	if !exists(filepath.Join(other, "history.sqlite")) {
		t.Fatal("a refused clean removed files")
	}

	// clean keeps a worktree of a repository outside the demo instance, unless forced.
	outside := filepath.Join(temporary, "outside")
	worktree := filepath.Join(demo, "worktrees", "outside")
	for _, folder := range []string{outside, worktree} {
		if err := os.MkdirAll(folder, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(worktree, ".git"), []byte("gitdir: "+outside+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if output, err := execute("bbflow-demo", demo, "clean"); err == nil || !strings.Contains(output, "outside the demo instance") {
		t.Fatalf("clean with an outside worktree: %v\n%s", err, output)
	}
	server, err := instance.Read(demo)
	if err != nil {
		t.Fatal(err)
	}

	// clean stops the server and its sessions, then removes the instance directory.
	pass("bbflow-demo", demo, "clean", "--force")
	if exists(demo) {
		t.Fatal("clean --force kept the demo instance")
	}
	if err := syscall.Kill(server.PID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("the demo server (PID %d) runs after clean: %v", server.PID, err)
	}
}
