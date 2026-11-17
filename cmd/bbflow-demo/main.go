// Command bbflow-demo adds simulated projects, tools, and sessions to a new bbflow
// instance, and removes that demo instance after use. The regular bbflow commands
// start, restart, and stop its server. It is a developer tool for the demo-instance
// project skill. It is not a bbflow command and is not released.
//
// See .agents/skills/demo-instance/SKILL.md for the procedure.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"bbflow/internal/client"
	"bbflow/internal/history"
	"bbflow/internal/protocol"
)

const usage = `Usage: bbflow-demo [--dir DIR] seed|clean [--force]

  seed   Add the demo data to the running server of a new instance.
  clean  Stop the server and remove the demo instance directory.

DIR is the instance directory, as in "bbflow --dir DIR". The default is .bbflow-demo
next to the bin folder of this executable. BBFLOW_DIR has no effect.`

// failure carries an error from a helper up to run. Each step of a command stops the
// command at its first error, so the helpers do not return errors.
type failure struct{ err error }

func check(err error) {
	if err != nil {
		panic(failure{err})
	}
}

func fail(format string, args ...any) {
	panic(failure{fmt.Errorf(format, args...)})
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "bbflow-demo: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) (err error) {
	defer func() {
		if r := recover(); r != nil {
			f, ok := r.(failure)
			if !ok {
				panic(r)
			}
			err = f.err
		}
	}()
	dir := ""
	if len(args) >= 2 && args[0] == "--dir" {
		dir, args = args[1], args[2:]
	}
	command := ""
	if len(args) > 0 {
		command = args[0]
	}
	switch {
	case command == "-h" || command == "--help" || command == "help":
		fmt.Println(usage)
	case len(args) == 1 && command == "seed":
		locate(dir).seed()
	case command == "clean" && (len(args) == 1 || len(args) == 2 && args[1] == "--force"):
		locate(dir).clean(len(args) == 2)
	default:
		return errors.New(usage)
	}
	return nil
}

// demo holds the paths of one demo instance. The demo files are in the demo folder of
// the instance directory.
type demo struct {
	dir      string // The instance directory.
	projects string // The simulated repositories.
	agent    string // The copy of the simulated agent tool.
	marker   string // Shows that this tool owns the instance directory.
	seeded   string // Shows that the seed is complete.
	binary   string // The bbflow executable next to this executable.
	target   client.Target
	locked   *os.File // The open instance directory that holds the lock.
}

// lock takes an exclusive lock on the instance directory for the rest of the process.
// seed and clean take it, so that only one of them runs at a time. The system releases
// it when the process ends, also after a crash or a kill.
func (d *demo) lock() {
	dir, err := os.Open(d.dir)
	check(err)
	if err = syscall.Flock(int(dir.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); errors.Is(err, syscall.EWOULDBLOCK) {
		dir.Close()
		fail("another seed or clean of %s runs now; wait for it to end, then try again", d.dir)
	}
	check(err)
	// Keep the file open. Its finalizer would close it and release the lock.
	d.locked = dir
}

// locate does not read BBFLOW_DIR. Inside a bbflow session, it selects the instance
// that owns the session, which holds real history.
func locate(dir string) *demo {
	executable, err := os.Executable()
	check(err)
	executable, err = filepath.EvalSymlinks(executable)
	check(err)
	bin := filepath.Dir(executable)
	if dir == "" {
		dir = filepath.Join(filepath.Dir(bin), ".bbflow-demo")
	}
	dir, err = filepath.Abs(dir)
	check(err)
	// bbflow resolves a symbolic link to its target, but os.RemoveAll removes only the
	// link. Refuse it, so that each step uses the same directory.
	if info, err := os.Lstat(dir); err == nil && info.Mode()&os.ModeSymlink != 0 {
		fail("%s is a symbolic link; use the path of its target directory", dir)
	}
	files := filepath.Join(dir, "demo")
	return &demo{
		dir:      dir,
		projects: filepath.Join(files, "projects"),
		agent:    filepath.Join(files, "demo-agent.sh"),
		marker:   filepath.Join(files, "DEMO"),
		seeded:   filepath.Join(files, "seeded"),
		binary:   filepath.Join(bin, "bbflow"),
		target:   client.Target{Dir: dir},
	}
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// call sends one request to the demo server and decodes its result.
func call[T any](target client.Target, request protocol.Request) T {
	result, err := target.Call(request)
	if err != nil {
		fail("%s: %w", request.Operation, err)
	}
	var value T
	check(json.Unmarshal(result, &value))
	return value
}

func (d *demo) seed() {
	info, err := d.target.Health()
	if err != nil {
		fail("no bbflow server runs in %s: %w\nStart it first:\n  DISABLE_AUTO_UPDATE=true %s --dir %s server start", d.dir, err, d.binary, d.dir)
	}
	d.lock()
	if exists(d.seeded) {
		fmt.Printf("%s already has the demo data.\n", d.dir)
		d.sessions(info.Port)
		return
	}
	// With the lock, no other seed runs. A marker without the seed record comes from a
	// seed that stopped. clean can remove that instance.
	if exists(d.marker) {
		fail("an earlier seed of %s stopped before it completed; run \"clean\", start the server, and seed again", d.dir)
	}
	d.requireNew()
	// The marker comes before each change, so that clean can remove the result of a seed
	// that stops after this point.
	check(os.MkdirAll(filepath.Dir(d.marker), 0o755))
	check(os.WriteFile(d.marker, []byte("bbflow demo instance. \"bbflow-demo clean\" removes this instance directory.\n"), 0o644))
	d.addData()
	check(os.WriteFile(d.seeded, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644))
	fmt.Printf("Added the demo data to %s.\n", d.dir)
	d.sessions(info.Port)
}

// newInstanceFiles are the entries of an instance directory after the first server
// start. The General folder is empty.
var newInstanceFiles = map[string]bool{
	"history.sqlite": true, "history.sqlite-shm": true, "history.sqlite-wal": true,
	"server.json": true, "server.log": true, "server.lock": true, "server-control.lock": true,
	"workspaces": true,
}

// requireNew refuses an instance with data that a new server did not create. The
// marker lets clean remove the directory, so it must go only on a new instance.
func (d *demo) requireNew() {
	const sql = "SELECT (SELECT count(*) FROM projects WHERE id<>'general'), (SELECT count(*) FROM sessions), (SELECT count(*) FROM events), (SELECT revision FROM settings WHERE id=1)"
	if rows := call[history.QueryResult](d.target, protocol.Request{Operation: "query", SQL: sql}).Rows; fmt.Sprint(rows) != "[[0 0 0 0]]" {
		fail("%s already has projects, sessions, events, or saved settings; seed only a new instance", d.dir)
	}
	entries, err := os.ReadDir(d.dir)
	check(err)
	var other []string
	for _, entry := range entries {
		// An empty demo folder comes from a seed that stopped before the marker.
		if entry.Name() == "demo" && entry.IsDir() {
			if files, err := os.ReadDir(filepath.Join(d.dir, "demo")); err == nil && len(files) == 0 {
				continue
			}
		}
		if !newInstanceFiles[entry.Name()] {
			other = append(other, entry.Name())
		}
	}
	workspaces, err := os.ReadDir(filepath.Join(d.dir, "workspaces"))
	check(err)
	for _, entry := range workspaces {
		if entry.Name() != "general" {
			other = append(other, filepath.Join("workspaces", entry.Name()))
		}
	}
	general, err := os.ReadDir(filepath.Join(d.dir, "workspaces", "general"))
	check(err)
	for _, entry := range general {
		other = append(other, filepath.Join("workspaces", "general", entry.Name()))
	}
	if len(other) > 0 {
		fail("%s has files that a new server does not create: %s; seed only a new instance", d.dir, strings.Join(other, ", "))
	}
}

// sessions prints the URL of each session.
func (d *demo) sessions(port int) {
	address := fmt.Sprintf("http://127.0.0.1:%d", port)
	fmt.Printf("URL: %s/\n", address)
	// One request lists 100 sessions at most, so each group gets its own request.
	groups := []string{""}
	for _, project := range call[[]history.Project](d.target, protocol.Request{Operation: "project-list"}) {
		groups = append(groups, project.ID)
	}
	var sessions []protocol.SessionInfo
	for _, archived := range []bool{false, true} {
		for _, group := range groups {
			request := protocol.Request{Operation: "session-list", Limit: history.MaxSessionLimit, Groups: []string{group}, Archived: archived}
			sessions = append(sessions, call[protocol.SessionPage](d.target, request).Sessions...)
		}
	}
	for _, session := range sessions {
		state := session.Status
		if session.Archived {
			state = "archived"
		}
		fmt.Printf("  %-9s%-32s%s/sessions/%s\n", state, session.Title, address, url.PathEscape(session.ID))
	}
}

// foreignWorktrees returns the managed worktrees whose repository is outside the
// instance directory or is not known. A managed worktree is a folder with a .git file
// that holds the path of its repository. Git can write this path relative to the
// folder.
func (d *demo) foreignWorktrees() []string {
	folder := filepath.Join(d.dir, "worktrees")
	entries, err := os.ReadDir(folder)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	check(err)
	inside, err := filepath.EvalSymlinks(d.dir)
	check(err)
	var foreign []string
	for _, entry := range entries {
		// Removal of a symbolic link or a file does not change its target.
		path := filepath.Join(folder, entry.Name())
		if entry.IsDir() && !ownedRepository(path, inside) {
			foreign = append(foreign, path)
		}
	}
	return foreign
}

// ownedRepository reports whether the files of a folder belong to a repository inside
// the directory inside. A folder with files but no .git entry can be a worktree whose
// pointer moved, so its repository is not known. An empty folder holds no files.
func ownedRepository(path, inside string) bool {
	info, err := os.Lstat(filepath.Join(path, ".git"))
	if errors.Is(err, os.ErrNotExist) {
		entries, err := os.ReadDir(path)
		return err == nil && len(entries) == 0
	}
	if err != nil || info.IsDir() {
		// A .git folder holds its own repository, inside the instance directory.
		return err == nil
	}
	pointer, err := os.ReadFile(filepath.Join(path, ".git"))
	if err != nil || !strings.HasPrefix(string(pointer), "gitdir: ") {
		return false
	}
	gitDir := strings.TrimSpace(strings.TrimPrefix(string(pointer), "gitdir: "))
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(path, gitDir)
	}
	gitDir, err = filepath.EvalSymlinks(gitDir)
	return err == nil && strings.HasPrefix(gitDir, inside+string(filepath.Separator))
}

func (d *demo) clean(force bool) {
	if !exists(d.dir) {
		fmt.Printf("No demo instance in %s.\n", d.dir)
		return
	}
	d.lock()
	requireMarker := func() {
		if !exists(d.marker) {
			fail("%s is not a demo instance; bbflow-demo removes only an instance that it seeded", d.dir)
		}
	}
	requireMarker()
	refuse := func(foreign []string) {
		if len(foreign) > 0 && !force {
			fail("these worktrees belong to repositories outside the demo instance, or to unknown repositories:\n  %s\nRemove each worktree in the UI, or run \"clean --force\" to discard their files",
				strings.Join(foreign, "\n  "))
		}
	}
	refuse(d.foreignWorktrees())
	if !exists(d.binary) {
		fail("%s does not exist; run \"make build\" first, so that clean can stop the server", d.binary)
	}
	// The regular stop command ends the sessions and waits for the server to release
	// the archive.
	stop := exec.Command(d.binary, "--dir", d.dir, "server", "stop")
	stop.Stdout, stop.Stderr = os.Stdout, os.Stderr
	if err := stop.Run(); err != nil {
		fail("stop the demo server: %w; stop it with Quit bbflow in the menu bar, then run \"clean\" again", err)
	}
	// The server can create a worktree before it stops. Examine the directory again
	// just before the removal.
	outside := d.foreignWorktrees()
	refuse(outside)
	requireMarker()
	check(os.RemoveAll(d.dir))
	fmt.Printf("Removed %s.\n", d.dir)
	if len(outside) > 0 {
		fmt.Println(`Run "git worktree prune" in each repository that had a worktree in the demo instance.`)
	}
}
