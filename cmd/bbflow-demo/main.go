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
	if exists(d.seeded) {
		fmt.Printf("%s already has the demo data.\n", d.dir)
		d.sessions(info.Port)
		return
	}
	if exists(d.marker) {
		fail("the seed of %s is not complete; run \"clean\", then start the server and seed again", d.dir)
	}
	// Refuse an instance with other data, so that the seed and clean cannot reach
	// real history.
	projects := call[[]history.Project](d.target, protocol.Request{Operation: "project-list"})
	active := call[[]protocol.SessionInfo](d.target, protocol.Request{Operation: "session-list", Limit: 1})
	archived := call[[]protocol.SessionInfo](d.target, protocol.Request{Operation: "session-list", Limit: 1, Archived: true})
	if len(projects) > 1 || len(active)+len(archived) > 0 {
		fail("%s already has projects or sessions; seed only a new instance", d.dir)
	}
	check(os.MkdirAll(filepath.Dir(d.marker), 0o755))
	check(os.WriteFile(d.marker, []byte("bbflow demo instance. \"bbflow-demo clean\" removes this instance directory.\n"), 0o644))
	d.addData()
	check(os.WriteFile(d.seeded, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644))
	fmt.Printf("Added the demo data to %s.\n", d.dir)
	d.sessions(info.Port)
}

// sessions prints the URL of each session.
func (d *demo) sessions(port int) {
	address := fmt.Sprintf("http://127.0.0.1:%d", port)
	fmt.Printf("URL: %s/\n", address)
	sessions := call[[]protocol.SessionInfo](d.target, protocol.Request{Operation: "session-list", Limit: 100})
	sessions = append(sessions, call[[]protocol.SessionInfo](d.target, protocol.Request{Operation: "session-list", Limit: 100, Archived: true})...)
	for _, session := range sessions {
		state := session.Status
		if session.Archived {
			state = "archived"
		}
		fmt.Printf("  %-9s%-32s%s/sessions/%s\n", state, session.Title, address, url.PathEscape(session.ID))
	}
}

// outsideWorktrees returns the managed worktrees of repositories outside the instance
// directory. A managed worktree is a folder with a .git file that points into its
// repository.
func (d *demo) outsideWorktrees() []string {
	folder := filepath.Join(d.dir, "worktrees")
	entries, err := os.ReadDir(folder)
	if err != nil {
		return nil
	}
	inside, err := filepath.EvalSymlinks(d.dir)
	check(err)
	var outside []string
	for _, entry := range entries {
		path := filepath.Join(folder, entry.Name())
		pointer, err := os.ReadFile(filepath.Join(path, ".git"))
		if err != nil {
			continue
		}
		gitDir, err := filepath.EvalSymlinks(strings.TrimSpace(strings.TrimPrefix(string(pointer), "gitdir: ")))
		if err == nil && !strings.HasPrefix(gitDir, inside+string(filepath.Separator)) {
			outside = append(outside, path)
		}
	}
	return outside
}

func (d *demo) clean(force bool) {
	if !exists(d.dir) {
		fmt.Printf("No demo instance in %s.\n", d.dir)
		return
	}
	if !exists(d.marker) {
		fail("%s is not a demo instance; bbflow-demo removes only an instance that it seeded", d.dir)
	}
	outside := d.outsideWorktrees()
	if len(outside) > 0 && !force {
		fail("these worktrees belong to repositories outside the demo instance:\n  %s\nRemove each worktree in the UI, or run \"clean --force\" to discard their files",
			strings.Join(outside, "\n  "))
	}
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
	check(os.RemoveAll(d.dir))
	fmt.Printf("Removed %s.\n", d.dir)
	if len(outside) > 0 {
		fmt.Println(`Run "git worktree prune" in each repository that had a worktree in the demo instance.`)
	}
}
