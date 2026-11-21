package desktop

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeCommands puts shell scripts first in PATH. Each script records its arguments in
// a file with its name and the suffix ".args".
func fakeCommands(t *testing.T, scripts map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range scripts {
		script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\n" + body + "\n"
		if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return dir
}

func opener(t *testing.T) string {
	t.Helper()
	switch runtime.GOOS {
	case "darwin":
		return "open"
	case "linux":
		return "xdg-open"
	}
	t.Skip("no opener on this operating system")
	return ""
}

func TestOpenTreatsAnInheritedPipeAsSuccess(t *testing.T) {
	name := opener(t)
	// The child keeps the output pipes open after the opener exits with success.
	fakeCommands(t, map[string]string{name: "sleep 5 &\nexit 0"})
	start := time.Now()
	if err := Open(context.Background(), "https://example.invalid/"); err != nil {
		t.Fatalf("a successful opener with an inherited pipe failed: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 4*time.Second {
		t.Fatalf("the wait for the inherited pipe took %v", elapsed)
	}
}

func TestOpenReportsFailureAndCancellation(t *testing.T) {
	name := opener(t)
	fakeCommands(t, map[string]string{name: "echo 'no handler' >&2\nexit 1"})
	err := Open(context.Background(), "https://example.invalid/")
	if err == nil || !strings.Contains(err.Error(), "exit status 1") || !strings.Contains(err.Error(), "no handler") {
		t.Fatalf("failed opener: %v", err)
	}
	if err := Open(context.Background(), "-a"); err == nil {
		t.Fatal("a target that starts with - was accepted")
	}
	fakeCommands(t, map[string]string{name: "exec sleep 5"})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := Open(ctx, "https://example.invalid/"); err == nil {
		t.Fatal("a canceled opener reported success")
	}
}

func TestOpenInBrowserUsesTheDefaultBrowser(t *testing.T) {
	if runtime.GOOS != "darwin" {
		if err := OpenInBrowser(context.Background(), "/tmp/report.html"); !errors.Is(err, ErrUnsupported) {
			t.Fatalf("OpenInBrowser on %s: %v", runtime.GOOS, err)
		}
		return
	}
	dir := fakeCommands(t, map[string]string{
		"osascript": "echo '/Applications/Fake Browser.app'",
		"open":      "exit 0",
	})
	if err := OpenInBrowser(context.Background(), "/work/reports/report.html"); err != nil {
		t.Fatal(err)
	}
	args, err := os.ReadFile(filepath.Join(dir, "open.args"))
	if err != nil || string(args) != "-a\n/Applications/Fake Browser.app\n/work/reports/report.html\n" {
		t.Fatalf("open arguments %q, %v", args, err)
	}
	if err := OpenInBrowser(context.Background(), "reports/report.html"); err == nil {
		t.Fatal("a relative path was accepted")
	}

	// Without a default browser, or when the lookup fails, open does not run.
	for _, script := range []string{"echo ''", "echo 'not an app'", "echo 'script error' >&2\nexit 1"} {
		dir = fakeCommands(t, map[string]string{"osascript": script, "open": "exit 0"})
		if err := OpenInBrowser(context.Background(), "/work/report.html"); err == nil {
			t.Fatalf("lookup %q: no error", script)
		}
		if _, err := os.Stat(filepath.Join(dir, "open.args")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("lookup %q: open ran", script)
		}
	}
}
