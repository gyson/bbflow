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
	"sync"
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
		// The servers of this test do not add native menus.
		build := exec.Command("go", "build", "-ldflags=-X main.menuBar=off", "-o", filepath.Join(bin, name), pkg)
		build.Env = append(os.Environ(), "CGO_ENABLED=0")
		if output, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v\n%s", pkg, err, output)
		}
	}
	temporary := t.TempDir()
	demo := filepath.Join(temporary, "demo")
	other := filepath.Join(temporary, "other")
	crashed := filepath.Join(temporary, "crashed")
	executeWith := func(env []string, name, dir string, args ...string) (string, error) {
		command := exec.Command(filepath.Join(bin, name), append([]string{"--dir", dir}, args...)...)
		// /bin/sh keeps the test independent of the shell settings of the user.
		command.Env = append(append(os.Environ(), "SHELL=/bin/sh", "BBFLOW_DIR="), env...)
		output, err := command.CombinedOutput()
		return string(output), err
	}
	execute := func(name, dir string, args ...string) (string, error) {
		return executeWith(nil, name, dir, args...)
	}
	refused := func(want, name, dir string, args ...string) {
		t.Helper()
		if output, err := execute(name, dir, args...); err == nil || !strings.Contains(output, want) {
			t.Fatalf("%s %s: want a refusal with %q: %v\n%s", name, strings.Join(args, " "), want, err, output)
		}
	}
	// git runs Git without the Git variables and configuration of the user.
	git := func(folder string, args ...string) string {
		t.Helper()
		command := exec.Command("git", append([]string{"-C", folder}, args...)...)
		for _, variable := range os.Environ() {
			if !strings.HasPrefix(variable, "GIT_") {
				command.Env = append(command.Env, variable)
			}
		}
		command.Env = append(command.Env, "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
		}
		return strings.TrimSpace(string(output))
	}
	write := func(path, text string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
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
		for _, dir := range []string{demo, other, crashed} {
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

	// seed adds the projects, tools, and sessions. GIT_DIR and GIT_WORK_TREE select an
	// unrelated repository, which the seed must not change. Of several seeds at the same
	// time, only one adds data. An empty demo folder from a seed that stopped before its
	// marker does not prevent a new seed.
	fixture := filepath.Join(temporary, "fixture")
	write(filepath.Join(fixture, "README.md"), "fixture\n")
	git(temporary, "init", "--quiet", fixture)
	git(fixture, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "--allow-empty", "--message", "fixture")
	write(filepath.Join(fixture, "edit.txt"), "uncommitted\n")
	pass("bbflow", demo, "server", "start")
	if err := os.Mkdir(filepath.Join(demo, "demo"), 0o755); err != nil {
		t.Fatal(err)
	}
	outputs, errs := make([]string, 8), make([]error, 8)
	var seeds sync.WaitGroup
	for i := range outputs {
		seeds.Go(func() {
			outputs[i], errs[i] = executeWith([]string{"GIT_DIR=" + filepath.Join(fixture, ".git"), "GIT_WORK_TREE=" + fixture}, "bbflow-demo", demo, "seed")
		})
	}
	seeds.Wait()
	added := 0
	for i, output := range outputs {
		switch {
		case errs[i] == nil && regexp.MustCompile(`Added the demo data to .*\nURL: http://127\.0\.0\.1:\d+/\n`).MatchString(output):
			added++
		case errs[i] == nil && strings.Contains(output, "already has the demo data"):
		case errs[i] != nil && strings.Contains(output, "another seed or clean of"):
		default:
			t.Errorf("concurrent seed: %v\n%s", errs[i], output)
		}
	}
	if added != 1 {
		t.Fatalf("%d concurrent seeds added data:\n%s", added, strings.Join(outputs, "\n---\n"))
	}
	if count, config, status := git(fixture, "rev-list", "--count", "HEAD"), git(fixture, "config", "--local", "--list"), git(fixture, "status", "--porcelain"); count != "1" || strings.Contains(config, "user.") || !strings.Contains(status, "edit.txt") {
		t.Fatalf("seed changed the repository of GIT_DIR: commits %s, status %q, config:\n%s", count, status, config)
	}
	// The Changes and Files views show a long path in a deep folder.
	if status := git(filepath.Join(demo, "demo", "projects", "orbit-api"), "status", "--porcelain"); !strings.Contains(status, " M "+controller) {
		t.Fatalf("seed did not change %s:\n%s", controller, status)
	}
	expect("SELECT name FROM projects ORDER BY name", "[[General] [Orbit API] [Tide Web]]")
	expect("SELECT archived, count(*) FROM sessions GROUP BY archived ORDER BY archived", "[[0 7] [1 1]]")
	// The reviewer draft is a sub-session of the worktree session. Its base is the branch
	// of its parent.
	expect("SELECT s.title, p.title, CAST(r.data AS TEXT)->>'base' FROM sessions s JOIN sessions p ON p.id=s.parent_id JOIN preparations r ON r.session_id=s.id",
		"[[Review the refactor Refactor orbit in a worktree demo/refactor-orbit]]")
	expect("SELECT status, count(*) FROM runs GROUP BY status ORDER BY status", "[[exited 3] [running 3] [stopped 1]]")
	expect("SELECT branch, state FROM worktrees", "[[demo/refactor-orbit ready]]")
	// The worktree has three commits after its base and an uncommitted file, for each
	// option of Compare with.
	worktrees, err := filepath.Glob(filepath.Join(demo, "worktrees", "*"))
	if err != nil || len(worktrees) != 1 {
		t.Fatalf("worktrees: %v, %v", worktrees, err)
	}
	if log := git(worktrees[0], "log", "--format=%s", "main..HEAD"); log != "Explain kepler.go in the design note\nAdd a Minutes helper\nMove the period math to kepler.go" {
		t.Fatalf("worktree commits:\n%s", log)
	}
	if status := git(worktrees[0], "status", "--porcelain"); status != "?? demo-agent-notes.md" {
		t.Fatalf("worktree status: %q", status)
	}
	expect("SELECT count(*) FROM events WHERE kind='draft' AND CAST(data AS TEXT)->>'pending'=1", "[[4]]")
	expect("SELECT count(*) FROM events WHERE kind='draft' AND CAST(data AS TEXT)->>'text'='List the changes since the last release.'", "[[1]]")
	expect("SELECT group_concat(value->>'name', ','), data->>'$.defaultTool'=data->>'$.tools[0].id', data->>'$.worktree' FROM settings, json_each(data, '$.tools')",
		"[[Demo agent,Busy agent,Claude,Codex 1 1]]")
	// The seed calls no model, so it selects no title tool.
	expect("SELECT data->>'$.titleTool' FROM settings", "[[none]]")
	expect(`SELECT count(*) FROM events AS input
		JOIN events AS start ON start.run_id=input.run_id AND start.kind='start'
		WHERE input.kind='input' AND CAST(start.data AS TEXT)->>'continues' IS NOT NULL`, "[[1]]")
	expect("SELECT s.title, CAST(p.data AS TEXT)->>'worktree' FROM preparations p JOIN sessions s ON s.id=p.session_id WHERE p.state='draft' ORDER BY s.title",
		"[[Plan release notes 1] [Review the refactor 1]]")

	// A second seed adds nothing and prints each session.
	output := pass("bbflow-demo", demo, "seed")
	expect("SELECT count(*) FROM sessions", "[[8]]")
	for _, state := range []string{"running", "ended", "draft", "archived"} {
		if !strings.Contains(output, "\n  "+state+" ") {
			t.Errorf("seed output has no %s session:\n%s", state, output)
		}
	}

	// The regular restart keeps the demo data.
	pass("bbflow", demo, "server", "restart")
	expect("SELECT count(*) FROM sessions", "[[8]]")
	expect("SELECT count(*) FROM runs WHERE status='running'", "[[0]]")

	// seed refuses an instance with other files or data, and writes no marker. clean
	// refuses an instance without the marker.
	pass("bbflow", other, "server", "start")
	notes := filepath.Join(other, "notes.txt")
	write(notes, "keep\n")
	refused("files that a new server does not create: notes.txt", "bbflow-demo", other, "seed")
	if err := os.Remove(notes); err != nil {
		t.Fatal(err)
	}
	pass("bbflow", other, "tool", "add", "Saved", "saved-tool")
	refused("saved settings", "bbflow-demo", other, "seed")
	if exists(filepath.Join(other, "demo")) {
		t.Fatal("a refused seed wrote demo files")
	}
	if tools := pass("bbflow", other, "tool", "list"); !strings.Contains(tools, "saved-tool") || strings.Contains(tools, "Demo agent") {
		t.Fatalf("a refused seed changed the tools: %s", tools)
	}
	refused("is not a demo instance", "bbflow-demo", other, "clean", "--force")
	if !exists(filepath.Join(other, "history.sqlite")) {
		t.Fatal("a refused clean removed files")
	}

	// A marker without the seed record comes from a seed that stopped. seed refuses to
	// continue it, and clean removes it.
	pass("bbflow", crashed, "server", "start")
	write(filepath.Join(crashed, "demo", "DEMO"), "")
	refused("an earlier seed", "bbflow-demo", crashed, "seed")
	pass("bbflow-demo", crashed, "clean")
	if exists(crashed) {
		t.Fatal("clean kept the instance of a seed that stopped")
	}

	// A seed that runs holds the lock of the instance directory. Then seed and clean
	// stop at once.
	held, err := os.Open(demo)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(held.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	refused("another seed or clean", "bbflow-demo", demo, "clean")
	refused("another seed or clean", "bbflow-demo", demo, "seed")
	held.Close()
	if !exists(filepath.Join(demo, "demo", "seeded")) {
		t.Fatal("a refused clean removed files")
	}

	// clean refuses a symbolic link to the demo instance.
	link := filepath.Join(temporary, "link")
	if err := os.Symlink(demo, link); err != nil {
		t.Fatal(err)
	}
	refused("is a symbolic link", "bbflow-demo", link, "clean")

	// clean keeps a worktree of a repository outside the demo instance, unless forced.
	// Git can write the repository path relative to the worktree folder.
	outside := filepath.Join(temporary, "outside")
	worktree := filepath.Join(demo, "worktrees", "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(worktree, ".git"), "gitdir: ../../../outside\n")
	refused("outside the demo instance", "bbflow-demo", demo, "clean")
	// A repository path that does not resolve is not known, so clean keeps it too.
	write(filepath.Join(worktree, ".git"), "gitdir: ../missing\n")
	refused("unknown repositories", "bbflow-demo", demo, "clean")
	// A folder with files but no .git entry can be a worktree whose pointer moved.
	if err := os.Remove(filepath.Join(worktree, ".git")); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(worktree, "edit.txt"), "uncommitted\n")
	refused("unknown repositories", "bbflow-demo", demo, "clean")
	// An empty folder holds no files, so clean can remove it.
	if err := os.MkdirAll(filepath.Join(demo, "worktrees", "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	server, err := instance.Read(demo)
	if err != nil {
		t.Fatal(err)
	}

	// A relative path to a repository of the demo is not foreign. Then clean stops the
	// server and its sessions, and removes the instance directory without --force.
	write(filepath.Join(worktree, ".git"), "gitdir: ../../demo/projects/orbit-api/.git\n")
	pass("bbflow-demo", demo, "clean")
	if exists(demo) {
		t.Fatal("clean kept the demo instance")
	}
	if err := syscall.Kill(server.PID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("the demo server (PID %d) runs after clean: %v", server.PID, err)
	}
}
