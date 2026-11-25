package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"bbflow/internal/history"
	"bbflow/internal/models"
	"bbflow/internal/protocol"
	"bbflow/internal/usage"
)

// A usage check asks the provider of the CLI, so it waits for the network. A request
// without refresh reuses a check that is less than usageFresh old.
const (
	usageTimeout = 20 * time.Second
	usageOutput  = 1 << 20
	usageFresh   = time.Minute
)

// usageCheck returns the usage check of a tool type with a program. Tests replace it.
var usageCheck = usage.Command

// usageReports keeps the last usage check of each tool type in memory. Each type has its
// own lock, so a slow check does not delay the check of another type.
type usageReports struct {
	mu      sync.Mutex
	locks   map[string]*sync.Mutex
	entries map[string]usageEntry
}

// usageEntry is the last check of a type. Report is the last report that a check read,
// from the time Checked. Failure is the error of the last check, or empty after a check
// that read a report. Tried is the time of the last check.
type usageEntry struct {
	program string
	report  *usage.Report
	checked time.Time
	failure string
	tried   time.Time
}

func (u *usageReports) lock(kind string) *sync.Mutex {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.locks == nil {
		u.locks, u.entries = map[string]*sync.Mutex{}, map[string]usageEntry{}
	}
	if u.locks[kind] == nil {
		u.locks[kind] = &sync.Mutex{}
	}
	return u.locks[kind]
}

func (u *usageReports) entry(kind string) usageEntry {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.entries[kind]
}

func (u *usageReports) save(kind string, entry usageEntry) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.entries[kind] = entry
}

func (e usageEntry) reply(kind string) protocol.ToolUsage {
	reply := protocol.ToolUsage{Type: kind, Report: usage.Report{Groups: []usage.Group{}}, Error: e.failure}
	if e.report != nil {
		reply.Report = *e.report
		reply.Checked = e.checked.UTC().Format(time.RFC3339)
	}
	return reply
}

// builtinTool returns the built-in tool of a type.
func builtinTool(settings history.Settings, kind string) (history.Tool, bool) {
	for _, tool := range settings.Tools {
		if tool.Builtin && tool.Type == kind {
			return tool, true
		}
	}
	return history.Tool{}, false
}

// toolUsage returns the usage of a tool type: Codex, Claude Code, or Antigravity. Its
// built-in tool must be on. The check runs the program of the tool. See toolPrograms.
//
// A request reuses the last check when it is less than usageFresh old, unless the
// request has refresh. A request that waited for the check of another request gets the
// result of that check. A failed check keeps the last report and returns it with the
// error. A change of the program forgets the last check. A disconnect stops the command
// and saves nothing.
func (s *Server) toolUsage(ctx context.Context, kind string, refresh bool) (protocol.ToolUsage, error) {
	if !usage.Checked(kind) {
		return protocol.ToolUsage{}, fmt.Errorf("%s has no usage check", models.Name(kind))
	}
	settings, err := s.store.Settings()
	if err != nil {
		return protocol.ToolUsage{}, err
	}
	if tool, ok := builtinTool(settings, kind); !ok || !tool.Enabled {
		return protocol.ToolUsage{}, fmt.Errorf("%s is off; turn it on in Settings", models.Name(kind))
	}
	program := toolPrograms(settings)[kind]
	asked := time.Now()
	lock := s.usage.lock(kind)
	lock.Lock()
	defer lock.Unlock()
	entry := s.usage.entry(kind)
	if entry.program != program {
		entry = usageEntry{program: program}
	}
	if !entry.tried.IsZero() && (entry.tried.After(asked) || !refresh && time.Since(entry.tried) < usageFresh) {
		return entry.reply(kind), nil
	}
	check := usageCheck(kind, program)
	var output string
	if check.Done != nil {
		output, err = runUntil(ctx, check.Command, check.Input, check.Done, usageTimeout, usageOutput)
	} else {
		output, err = runCLI(ctx, check.Command, check.Input, usageTimeout, usageOutput)
	}
	if ctx.Err() != nil {
		return protocol.ToolUsage{}, ctx.Err()
	}
	var report usage.Report
	if err == nil {
		report, err = usage.Parse(kind, []byte(output), time.Now())
	}
	entry.tried = time.Now()
	if err != nil {
		entry.failure = fmt.Sprintf("%s: %v", check.Command, err)
	} else {
		entry.report, entry.checked, entry.failure = &report, entry.tried, ""
	}
	s.usage.save(kind, entry)
	return entry.reply(kind), nil
}

// runUntil runs a command that answers while its standard input stays open, such as a
// JSON-RPC server. It writes input and keeps standard input open until done accepts a
// line of the standard output. Then it closes standard input, waits a short time for the
// exit, and stops the process group if it still runs. It returns the accepted line. Like
// runCLI, it runs the command in the shell of the server, in an empty temporary folder.
func runUntil(ctx context.Context, command, input string, done func([]byte) bool, timeout time.Duration, limit int) (string, error) {
	shell, env, err := serverShell()
	if err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp("", "bbflow-cli-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.Command(shell, "-c", command)
	cmd.Dir, cmd.Env = dir, env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return "", err
	}
	lines := &lineWatch{limit: limit, done: done, found: make(chan struct{})}
	stderr := &limitedBuffer{limit: 4 << 10}
	cmd.Stdout, cmd.Stderr = lines, stderr
	// Stop the whole process group. An agent CLI can start child processes.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Start(); err != nil {
		stdin.Close()
		return "", err
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	stop := func() {
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-exited
	}
	// A failed write means that the command ended. Its exit tells why.
	io.WriteString(stdin, input)
	select {
	case <-lines.found:
	case err := <-exited:
		// The answer and the exit can come together.
		if line, ok := lines.answer(); ok {
			return line, nil
		}
		if err == nil {
			return "", errors.New("the command ended without an answer")
		}
		return "", commandError(err, stderr)
	case <-ctx.Done():
		stop()
		return "", fmt.Errorf("the command did not finish in %s", timeout)
	}
	stdin.Close()
	select {
	case <-exited:
	case <-time.After(2 * time.Second):
		stop()
	}
	line, _ := lines.answer()
	return line, nil
}

// lineWatch reads the standard output of runUntil. It closes found at the first line
// that done accepts. It keeps at most limit bytes of a line, so a longer line cannot be
// the answer.
type lineWatch struct {
	mu      sync.Mutex
	limit   int
	done    func([]byte) bool
	found   chan struct{}
	partial []byte
	long    bool // The partial line passed the limit.
	line    []byte
	matched bool
}

func (w *lineWatch) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for rest := p; len(rest) > 0 && !w.matched; {
		end := bytes.IndexByte(rest, '\n')
		chunk := rest
		if end >= 0 {
			chunk, rest = rest[:end], rest[end+1:]
		} else {
			rest = nil
		}
		if len(w.partial)+len(chunk) > w.limit {
			w.partial, w.long = nil, true
		} else if !w.long {
			w.partial = append(w.partial, chunk...)
		}
		if end < 0 {
			break
		}
		if !w.long && w.done(w.partial) {
			w.line, w.matched = w.partial, true
			close(w.found)
		}
		w.partial, w.long = nil, false
	}
	return len(p), nil
}

func (w *lineWatch) answer() (string, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return string(w.line), w.matched
}
