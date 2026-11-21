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
