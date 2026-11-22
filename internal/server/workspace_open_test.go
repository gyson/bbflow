package server

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"bbflow/internal/protocol"
)

func TestWorkspaceOpenOpensOnlyRegularHTMLFiles(t *testing.T) {
	s := diffServer(t)
	var opened []string
	s.open = func(ctx context.Context, path string) error {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("the opener has no time limit")
		}
		opened = append(opened, path)
		return nil
	}
	workspace := t.TempDir()
	outside := t.TempDir()
	writeFiles(t, workspace, map[string]string{
		"reports/coverage.html": "<p>coverage</p>\n",
		"reports/weekly.HTM":    "<p>weekly</p>\n",
		"notes.md":              "# Notes\n",
		"run.command":           "#!/bin/sh\n",
	})
	writeFiles(t, outside, map[string]string{"outside.html": "<p>outside</p>\n"})
	for link, target := range map[string]string{"link.html": "run.command", "linked": "reports", "escape": outside} {
		if err := os.Symlink(target, filepath.Join(workspace, link)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(workspace, "folder.html"), 0700); err != nil {
		t.Fatal(err)
	}
	id := diffSession(t, s, workspace)
	ctx := context.Background()
	for _, path := range []string{"reports/coverage.html", "reports/weekly.HTM"} {
		if err := s.workspaceOpen(ctx, id, &protocol.DiffRequest{Path: path}); err != nil {
			t.Fatalf("open %s: %v", path, err)
		}
	}
	// The opener gets the canonical path. On macOS, the temporary folder is a symlink.
	canonical, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(canonical, "reports/coverage.html"), filepath.Join(canonical, "reports/weekly.HTM")}
	if !slices.Equal(opened, want) {
		t.Fatalf("opened %q, want %q", opened, want)
	}

	rejected := map[string]string{
		"notes.md":                             "only an HTML file",
		"run.command":                          "only an HTML file",
		"link.html":                            "symbolic link",
		"linked/coverage.html":                 "symbolic link",
		"escape/outside.html":                  "symbolic link",
		"folder.html":                          "not a regular file",
		"missing.html":                         "not in the session workspace now",
		"../outside.html":                      "must name a file",
		"a/../coverage.html":                   "must name a file",
		filepath.Join(outside, "outside.html"): "must name a file",
		"":                                     "must name a file",
	}
	for path, message := range rejected {
		err := s.workspaceOpen(ctx, id, &protocol.DiffRequest{Path: path})
		if err == nil || !strings.Contains(err.Error(), message) {
			t.Errorf("open %q: %v, want an error with %q", path, err, message)
		}
	}
	if err := s.workspaceOpen(ctx, id, nil); err == nil {
		t.Error("a request without a path was accepted")
	}
	if err := s.workspaceOpen(ctx, "missing", &protocol.DiffRequest{Path: "reports/coverage.html"}); err == nil {
		t.Error("an unknown session was accepted")
	}
	if len(opened) != 2 {
		t.Fatalf("a rejected request reached the opener: %q", opened)
	}

	s.open = func(context.Context, string) error { return errors.New("no browser") }
	if err := s.workspaceOpen(ctx, id, &protocol.DiffRequest{Path: "reports/coverage.html"}); err == nil || !strings.Contains(err.Error(), "no browser") {
		t.Fatalf("opener failure: %v", err)
	}
	s.open = nil
	if err := s.workspaceOpen(ctx, id, &protocol.DiffRequest{Path: "reports/coverage.html"}); err == nil {
		t.Fatal("a server without an opener opened a file")
	}
}

func TestWorkspaceOpenOverWebSocket(t *testing.T) {
	s := diffServer(t)
	var opened []string
	s.open = func(_ context.Context, path string) error { opened = append(opened, path); return nil }
	workspace := t.TempDir()
	writeFiles(t, workspace, map[string]string{"report.html": "<p>report</p>\n"})
	id := diffSession(t, s, workspace)
	var result map[string]bool
	requestResult(t, s, protocol.Request{Operation: "workspace-open", Session: id, Diff: &protocol.DiffRequest{Path: "report.html"}}, &result)
	if !result["opened"] || len(opened) != 1 || filepath.Base(opened[0]) != "report.html" {
		t.Fatalf("result %v, opened %q", result, opened)
	}
}

func TestWorkspaceRevealShowsEntriesOfTheWorkspace(t *testing.T) {
	s := diffServer(t)
	var revealed []string
	s.reveal = func(ctx context.Context, path string) error {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("the opener has no time limit")
		}
		revealed = append(revealed, path)
		return nil
	}
	workspace := t.TempDir()
	outside := t.TempDir()
	writeFiles(t, workspace, map[string]string{"docs/notes.md": "# Notes\n", "run.command": "#!/bin/sh\n"})
	writeFiles(t, outside, map[string]string{"outside.md": "# Outside\n"})
	for link, target := range map[string]string{"link.md": "docs/notes.md", "linked": "docs", "escape": outside} {
		if err := os.Symlink(target, filepath.Join(workspace, link)); err != nil {
			t.Fatal(err)
		}
	}
	id := diffSession(t, s, workspace)
	ctx := context.Background()
	// Any type of entry can show. Finder selects it and does not open it.
	for _, path := range []string{"docs/notes.md", "run.command", "docs"} {
		if err := s.workspaceReveal(ctx, id, &protocol.DiffRequest{Path: path}); err != nil {
			t.Fatalf("reveal %s: %v", path, err)
		}
	}
	canonical, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(canonical, "docs/notes.md"), filepath.Join(canonical, "run.command"), filepath.Join(canonical, "docs")}
	if !slices.Equal(revealed, want) {
		t.Fatalf("revealed %q, want %q", revealed, want)
	}

	rejected := map[string]string{
		"link.md":                            "symbolic link",
		"linked/notes.md":                    "symbolic link",
		"escape/outside.md":                  "symbolic link",
		"missing.md":                         "not in the session workspace now",
		"../outside.md":                      "must name a file",
		filepath.Join(outside, "outside.md"): "must name a file",
		"":                                   "must name a file",
	}
	for path, message := range rejected {
		err := s.workspaceReveal(ctx, id, &protocol.DiffRequest{Path: path})
		if err == nil || !strings.Contains(err.Error(), message) {
			t.Errorf("reveal %q: %v, want an error with %q", path, err, message)
		}
	}
	if err := s.workspaceReveal(ctx, id, nil); err == nil {
		t.Error("a request without a path was accepted")
	}
	if err := s.workspaceReveal(ctx, "missing", &protocol.DiffRequest{Path: "docs/notes.md"}); err == nil {
		t.Error("an unknown session was accepted")
	}
	if len(revealed) != 3 {
		t.Fatalf("a rejected request reached the opener: %q", revealed)
	}

	s.reveal = func(context.Context, string) error { return errors.New("no Finder") }
	if err := s.workspaceReveal(ctx, id, &protocol.DiffRequest{Path: "docs/notes.md"}); err == nil || !strings.Contains(err.Error(), "no Finder") {
		t.Fatalf("opener failure: %v", err)
	}
	s.reveal = nil
	if err := s.workspaceReveal(ctx, id, &protocol.DiffRequest{Path: "docs/notes.md"}); err == nil {
		t.Fatal("a server without an opener showed a file")
	}
}

func TestWorkspaceRevealOverWebSocket(t *testing.T) {
	s := diffServer(t)
	var revealed []string
	s.reveal = func(_ context.Context, path string) error { revealed = append(revealed, path); return nil }
	workspace := t.TempDir()
	writeFiles(t, workspace, map[string]string{"notes.md": "# Notes\n"})
	id := diffSession(t, s, workspace)
	var result map[string]bool
	requestResult(t, s, protocol.Request{Operation: "workspace-reveal", Session: id, Diff: &protocol.DiffRequest{Path: "notes.md"}}, &result)
	if !result["revealed"] || len(revealed) != 1 || filepath.Base(revealed[0]) != "notes.md" {
		t.Fatalf("result %v, revealed %q", result, revealed)
	}
}
