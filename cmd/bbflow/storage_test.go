package main

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"bbflow/internal/history"
)

func TestStorageCLIPrintsReportAndRedactsNames(t *testing.T) {
	directory := t.TempDir()
	startTestServer(t, directory)
	store := archive(t, directory)
	project, err := store.CreateProject("Private Orbit", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession("Secret | plan", t.TempDir(), project.ID)
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.NewRun(session.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range []struct{ kind, data string }{{"start", `{"tool":"Codex"}`}, {"output", "SECRET-OUTPUT-BYTES"}, {"input", "k"}} {
		if _, err = store.Append(session.ID, run.ID, event.kind, []byte(event.data), ""); err != nil {
			t.Fatal(err)
		}
	}

	output, err := testCommand("storage").Output()
	text := string(output)
	if err != nil {
		t.Fatalf("storage: %v\n%s", err, text)
	}
	for _, want := range []string{"# bbflow storage report", "## Used space by events column", "## Top 10 sessions",
		"| `" + session.ID[:8] + "` | Secret \\| plan", "Private Orbit", "Codex", "## Growth by day (UTC)", "## Method"} {
		if !strings.Contains(text, want) {
			t.Fatalf("report has no %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "SECRET-OUTPUT-BYTES") {
		t.Fatalf("report shows terminal content:\n%s", text)
	}

	output, err = testCommand("storage", "--redact").Output()
	text = string(output)
	if err != nil || strings.Contains(text, "Secret") || strings.Contains(text, "Private Orbit") ||
		!strings.Contains(text, "session "+session.ID[:8]) || !strings.Contains(text, "project "+project.ID[:8]) {
		t.Fatalf("redacted report: %v\n%s", err, text)
	}
	if output, err = testCommand("storage", "extra").CombinedOutput(); err == nil {
		t.Fatalf("accepted an argument: %s", output)
	}
}

func TestStorageReportFormatsEmptyArchiveAndNumbers(t *testing.T) {
	var output bytes.Buffer
	writeStorageReport(&output, history.StorageReport{Format: 10, PageSize: 4096, Pages: 3}, time.Unix(0, 0).UTC())
	if !strings.Contains(output.String(), "No events.") || !strings.Contains(output.String(), "1970-01-01 00:00 UTC") {
		t.Fatalf("empty report:\n%s", output.String())
	}
	for n, want := range map[int64]string{0: "0", 999: "999", 1000: "1,000", 1234567: "1,234,567"} {
		if got := count(n); got != want {
			t.Fatalf("count(%d) = %q, want %q", n, got, want)
		}
	}
	for n, want := range map[int64]string{512: "512 B", 2048: "2.0 KB", 5 << 20: "5.0 MB", 3 << 30: "3.00 GB"} {
		if got := size(n); got != want {
			t.Fatalf("size(%d) = %q, want %q", n, got, want)
		}
	}
}
