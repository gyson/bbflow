package server

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"bbflow/internal/models"
	"bbflow/internal/usage"
)

// usageServer returns a server whose built-in tools of the types are on, and the others
// off. The checks run the scripts of commands, by type.
func usageServer(t *testing.T, commands map[string]usage.Check, on ...string) *Server {
	t.Helper()
	s, _ := composerServer(t)
	settings, err := s.store.Settings()
	if err != nil {
		t.Fatal(err)
	}
	for i := range settings.Tools {
		if settings.Tools[i].Builtin {
			settings.Tools[i].Enabled = false
			for _, kind := range on {
				if settings.Tools[i].Type == kind {
					settings.Tools[i].Enabled = true
				}
			}
		}
	}
	if _, err := s.store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	original := usageCheck
	usageCheck = func(kind, program string) usage.Check { return commands[kind] }
	t.Cleanup(func() { usageCheck = original })
	return s
}

// usageScript writes an executable shell script and returns its path.
func usageScript(t *testing.T, name, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

// runCount returns the number of runs that a script recorded in a file.
func runCount(path string) int {
	data, _ := os.ReadFile(path)
	return strings.Count(string(data), "run")
}

const agyUsage = `{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.75,"reset_time":"2026-11-25T15:30:20Z"}]}]}}}`

func TestToolUsageReusesARecentCheckUntilARefresh(t *testing.T) {
	count := filepath.Join(t.TempDir(), "count")
	agy := usageScript(t, "agy", "echo run >> '"+count+"'\nsleep 0.2\necho '"+agyUsage+"'\n")
	s := usageServer(t, map[string]usage.Check{models.Agy: {Command: agy}}, models.Agy)
	ctx := context.Background()
	for range 2 {
		reply, err := s.toolUsage(ctx, models.Agy, false)
		if err != nil || reply.Type != models.Agy || reply.Checked == "" || reply.Error != "" || len(reply.Groups) != 1 || reply.Groups[0].Windows[0].Used != 25 {
			t.Fatalf("got %+v %v", reply, err)
		}
	}
	if runCount(count) != 1 {
		t.Fatalf("the check ran %d times without a refresh", runCount(count))
	}
	if _, err := s.toolUsage(ctx, models.Agy, true); err != nil || runCount(count) != 2 {
		t.Fatalf("a refresh did not check again: %d %v", runCount(count), err)
	}
	// Requests that wait for the same check get its result. Only one check runs.
	var wg sync.WaitGroup
	for range 3 {
		wg.Go(func() {
			if _, err := s.toolUsage(ctx, models.Agy, true); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if runCount(count) != 3 {
		t.Fatalf("waiting requests ran %d checks", runCount(count)-2)
	}
	// An old check runs again without a refresh.
	entry := s.usage.entry(models.Agy)
	entry.tried = entry.tried.Add(-usageFresh)
	s.usage.save(models.Agy, entry)
	if _, err := s.toolUsage(ctx, models.Agy, false); err != nil || runCount(count) != 4 {
		t.Fatalf("an old check was reused: %d %v", runCount(count), err)
	}
	// A change of the CLI path forgets the last check.
	settings, err := s.store.Settings()
	if err != nil {
		t.Fatal(err)
	}
	for i := range settings.Tools {
		if settings.Tools[i].Builtin && settings.Tools[i].Type == models.Agy {
			settings.Tools[i].Path = "/opt/agy"
		}
	}
	if _, err := s.store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	if _, err := s.toolUsage(ctx, models.Agy, false); err != nil || runCount(count) != 5 {
		t.Fatalf("a new program reused the old check: %d %v", runCount(count), err)
	}
}

func TestToolUsageKeepsTheLastReportAfterAFailure(t *testing.T) {
	fail := filepath.Join(t.TempDir(), "fail")
	claude := usageScript(t, "claude", "if [ -e '"+fail+"' ]; then echo 'Not logged in' >&2; exit 1; fi\necho 'Current session: 40% used · resets 4pm (America/Los_Angeles)'\n")
	s := usageServer(t, map[string]usage.Check{models.Claude: {Command: claude}}, models.Claude)
	ctx := context.Background()
	first, err := s.toolUsage(ctx, models.Claude, false)
	if err != nil || first.Error != "" || first.Groups[0].Windows[0].Used != 40 {
		t.Fatalf("got %+v %v", first, err)
	}
	if err := os.WriteFile(fail, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	failed, err := s.toolUsage(ctx, models.Claude, true)
	if err != nil || !strings.Contains(failed.Error, "Not logged in") || !strings.Contains(failed.Error, claude) || failed.Checked != first.Checked || len(failed.Groups) != 1 {
		t.Fatalf("a failure did not keep the last report: %+v %v", failed, err)
	}
	// A failure counts as a check, so a request without refresh does not run it again.
	if again, err := s.toolUsage(ctx, models.Claude, false); err != nil || again.Error != failed.Error {
		t.Fatalf("got %+v %v", again, err)
	}
	// Without a report, the reply has only the error and an empty list.
	s.usage = usageReports{}
	only, err := s.toolUsage(ctx, models.Claude, false)
	if err != nil || only.Error == "" || only.Checked != "" || only.Groups == nil || len(only.Groups) != 0 {
		t.Fatalf("got %+v %v", only, err)
	}
	// A disconnect stops the check and saves nothing.
	s.usage = usageReports{}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := s.toolUsage(canceled, models.Claude, false); err == nil || !s.usage.entry(models.Claude).tried.IsZero() {
		t.Fatalf("a canceled check saved a result: %v", err)
	}
}

func TestToolUsageNeedsABuiltinToolThatIsOn(t *testing.T) {
	s := usageServer(t, nil, models.Claude)
	for kind, message := range map[string]string{
		models.Codex:     "Codex is off",
		models.Agy:       "Antigravity is off",
		models.CodePuppy: "Code Puppy has no usage check",
		models.Custom:    "Custom has no usage check",
		"":               "has no usage check",
	} {
		if _, err := s.toolUsage(context.Background(), kind, false); err == nil || !strings.Contains(err.Error(), message) {
			t.Fatalf("%q: got %v, want %q", kind, err, message)
		}
	}
}

// fakeCodex acts like codex app-server. It answers the rate limit request a little
// later, and it exits at the end of its input without the answer of a pending request.
const fakeCodex = `while IFS= read -r line; do
  case "$line" in
    *'"id":0'*) echo '{"id":0,"result":{"userAgent":"fake"}}' ;;
    *'"id":1'*) (sleep 0.3; echo '{"method":"account/updated","params":{}}'; echo '{"id":1,"result":{"rateLimits":{"primary":{"usedPercent":100,"windowDurationMins":300,"resetsAt":1795617124},"planType":"pro"}}}') & ;;
  esac
done
kill $! 2>/dev/null
exit 0
`

func TestToolUsageKeepsTheInputOfCodexOpenUntilTheAnswer(t *testing.T) {
	codex := usageScript(t, "codex", fakeCodex)
	check := usage.Command(models.Codex, codex)
	s := usageServer(t, map[string]usage.Check{models.Codex: check}, models.Codex)
	reply, err := s.toolUsage(context.Background(), models.Codex, false)
	if err != nil || reply.Error != "" || reply.Plan != "pro" || reply.Groups[0].Windows[0].Used != 100 {
		t.Fatalf("got %+v %v", reply, err)
	}
	// With its input closed at once, the fake drops the request, like Codex.
	if output, err := runCLI(context.Background(), check.Command, check.Input, 5*time.Second, 1<<20); err != nil || strings.Contains(output, `"id":1`) {
		t.Fatalf("the fake answered without an open input: %q %v", output, err)
	}
}

func TestRunUntilStopsACommandWithoutAnAnswer(t *testing.T) {
	done := func(line []byte) bool { return string(line) == "answer" }
	ctx := context.Background()
	start := time.Now()
	if _, err := runUntil(ctx, "sleep 30", "", done, 300*time.Millisecond, 1<<10); err == nil || !strings.Contains(err.Error(), "did not finish") {
		t.Fatalf("got %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("the command ran after its time limit")
	}
	for command, message := range map[string]string{
		"echo other":                  "ended without an answer",
		"echo 'no auth' >&2; exit 2":  "no auth",
		"command-that-does-not-exist": "not installed",
	} {
		if _, err := runUntil(ctx, command, "", done, 5*time.Second, 1<<10); err == nil || !strings.Contains(err.Error(), message) {
			t.Fatalf("%q: got %v, want %q", command, err, message)
		}
	}
	// A canceled request does not start the command.
	ran := filepath.Join(t.TempDir(), "ran")
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := runUntil(canceled, "touch '"+ran+"'; echo answer", "", done, 5*time.Second, 1<<10); err == nil {
		t.Fatal("a canceled request ran")
	}
	if _, err := os.Stat(ran); !os.IsNotExist(err) {
		t.Fatalf("a canceled request started the command: %v", err)
	}
	// A command that keeps running after its answer stops when its input closes, or
	// after a short wait.
	start = time.Now()
	if line, err := runUntil(ctx, "echo answer; sleep 30", "", done, 20*time.Second, 1<<10); err != nil || line != "answer" {
		t.Fatalf("got %q %v", line, err)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatal("the command ran long after its answer")
	}
}

func TestLineWatchFindsALineAcrossWrites(t *testing.T) {
	w := &lineWatch{limit: 8, done: func(line []byte) bool { return string(line) == `{"id":1}` }, found: make(chan struct{})}
	for _, part := range []string{"too long line\n{\"id\"", ":1", "}\nafter\n"} {
		w.Write([]byte(part))
	}
	line, ok := w.answer()
	if !ok || line != `{"id":1}` {
		t.Fatalf("got %q %v", line, ok)
	}
	// A line over the limit cannot be the answer.
	long := &lineWatch{limit: 4, done: func(line []byte) bool { return strings.HasSuffix(string(line), "yes") }, found: make(chan struct{})}
	long.Write([]byte("abc"))
	long.Write([]byte("d yes\nyes\n"))
	if line, ok := long.answer(); !ok || line != "yes" {
		t.Fatalf("got %q %v", line, ok)
	}
}
