package server

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"bonbon/internal/history"
	"bonbon/internal/protocol"
)

// diffServer makes a server with an empty archive.
func diffServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	store, err := history.Open(filepath.Join(dir, "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return &Server{store: store, info: protocol.ServerInfo{DataDir: dir}}
}

func diffSession(t *testing.T, s *Server, workspace string) string {
	t.Helper()
	session, err := s.store.CreateSession("Diff fixture", workspace, "")
	if err != nil {
		t.Fatal(err)
	}
	return session.ID
}

// fixtureGit runs Git without the user's global configuration.
func fixtureGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Env = append(gitEnv(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, text := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func diffRepository(t *testing.T, files map[string]string) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, dir, "init", "-q", "-b", "main")
	writeFiles(t, dir, files)
	if len(files) > 0 {
		fixtureGit(t, dir, "add", "-A")
		fixtureGit(t, dir, "commit", "-q", "-m", "initial")
	}
	return dir
}

func changesByPath(t *testing.T, changes protocol.WorkspaceChanges) map[string]protocol.ChangedFile {
	t.Helper()
	files := map[string]protocol.ChangedFile{}
	for _, file := range changes.Files {
		files[file.Path] = file
	}
	return files
}

func TestWorkspaceChangesListsEachStatusAgainstHead(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{
		"edit.txt": "one\ntwo\nthree\n", "delete.txt": "gone\n", "old name.txt": "same text for a rename\n",
		"image.bin": "\x00\x01\x02", "ignored.log": "",
	})
	writeFiles(t, repo, map[string]string{".gitignore": "*.log\n", "edit.txt": "one\n2\nthree\nfour\n", "image.bin": "\x00\x01\x03",
		"café ü.txt": "a\nb", "line\nbreak.txt": "x\n", "debug.log": "ignored\n"})
	os.Remove(filepath.Join(repo, "delete.txt"))
	fixtureGit(t, repo, "mv", "old name.txt", "new name.txt")
	changes, err := s.workspaceChanges(context.Background(), diffSession(t, s, repo), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !changes.Repository || changes.Base || changes.Baseline.Kind != "head" || changes.Truncated {
		t.Fatalf("changes: %+v", changes)
	}
	head := fixtureGit(t, repo, "rev-parse", "HEAD")
	if changes.Baseline.Commit != head || changes.Baseline.Label != "Uncommitted changes" {
		t.Fatalf("baseline: %+v", changes.Baseline)
	}
	files := changesByPath(t, changes)
	want := map[string]protocol.ChangedFile{
		"edit.txt":        {Path: "edit.txt", Status: "M", Added: 2, Removed: 1},
		"delete.txt":      {Path: "delete.txt", Status: "D", Added: 0, Removed: 1},
		"new name.txt":    {Path: "new name.txt", OldPath: "old name.txt", Status: "R", Added: 0, Removed: 0},
		"image.bin":       {Path: "image.bin", Status: "M", Added: -1, Removed: -1, Binary: true},
		".gitignore":      {Path: ".gitignore", Status: "A", Added: 1, Untracked: true},
		"café ü.txt":      {Path: "café ü.txt", Status: "A", Added: 2, Untracked: true},
		"line\nbreak.txt": {Path: "line\nbreak.txt", Status: "A", Added: 1, Untracked: true},
	}
	if !reflect.DeepEqual(files, want) {
		t.Fatalf("files:\n got %+v\nwant %+v", files, want)
	}
}

func TestWorkspaceFileReadsBothSides(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"edit.txt": "old\n", "delete.txt": "gone\n", "old.txt": "renamed\n", "large.txt": "small\n", "bytes.txt": "plain\n"})
	if err := os.Symlink("edit.txt", filepath.Join(repo, "link")); err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, repo, "add", "link")
	fixtureGit(t, repo, "commit", "-q", "-m", "link")
	writeFiles(t, repo, map[string]string{"edit.txt": "new\n", "added.txt": "fresh\n", "large.txt": strings.Repeat("x", maxFileSide+1), "bytes.txt": "\xff\xfe"})
	os.Remove(filepath.Join(repo, "delete.txt"))
	fixtureGit(t, repo, "mv", "old.txt", "new.txt")
	id := diffSession(t, s, repo)
	read := func(path, oldPath string) protocol.WorkspaceFile {
		t.Helper()
		file, err := s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Path: path, OldPath: oldPath})
		if err != nil {
			t.Fatal(err)
		}
		return file
	}
	text := func(value string) protocol.FileSide {
		return protocol.FileSide{State: "text", Text: value, Size: int64(len(value))}
	}
	cases := []struct {
		path, oldPath string
		old, new      protocol.FileSide
	}{
		{"edit.txt", "", text("old\n"), text("new\n")},
		{"delete.txt", "", text("gone\n"), protocol.FileSide{State: "missing"}},
		{"added.txt", "", protocol.FileSide{State: "missing"}, text("fresh\n")},
		{"new.txt", "old.txt", text("renamed\n"), text("renamed\n")},
		{"large.txt", "", text("small\n"), protocol.FileSide{State: "tooLarge", Size: maxFileSide + 1}},
		{"bytes.txt", "", text("plain\n"), protocol.FileSide{State: "binary", Size: 2}},
		{"link", "", protocol.FileSide{State: "text", Text: "edit.txt", Size: 8, Symlink: true}, protocol.FileSide{State: "text", Text: "edit.txt", Size: 8, Symlink: true}},
	}
	for _, c := range cases {
		file := read(c.path, c.oldPath)
		if file.Old != c.old || file.New != c.new || file.Path != c.path || file.Baseline.Kind != "head" {
			t.Errorf("%s:\n got old %+v new %+v\nwant old %+v new %+v", c.path, file.Old, file.New, c.old, c.new)
		}
	}
	writeFiles(t, repo, map[string]string{"folder/inside.txt": "inside\n"})
	fixtureGit(t, repo, "add", "folder")
	fixtureGit(t, repo, "commit", "-q", "-m", "folder")
	if file := read("folder", ""); file.New.State != "other" || file.Old.State != "other" {
		t.Errorf("folder: %+v", file)
	}
}

func TestWorkspaceFileStaysInsideWorkspace(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"inside.txt": "inside\n"})
	outside := t.TempDir()
	writeFiles(t, outside, map[string]string{"secret.txt": "secret\n"})
	if err := os.Symlink(outside, filepath.Join(repo, "escape")); err != nil {
		t.Fatal(err)
	}
	id := diffSession(t, s, repo)
	for _, path := range []string{"../secret.txt", filepath.Join(outside, "secret.txt"), "", ".", "a/../inside.txt", "a/../../secret.txt"} {
		if _, err := s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Path: path}); err == nil {
			t.Errorf("path %q was accepted", path)
		}
	}
	if _, err := s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Path: "inside.txt", OldPath: "../secret.txt"}); err == nil {
		t.Error("old path outside the workspace was accepted")
	}
	file, err := s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Path: "escape/secret.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if file.New.State != "other" || file.New.Text != "" {
		t.Fatalf("a symlink to another folder exposed a file: %+v", file.New)
	}
	// The symlink itself shows its target text and is not followed.
	file, err = s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Path: "escape"})
	if err != nil {
		t.Fatal(err)
	}
	if !file.New.Symlink || file.New.Text != outside {
		t.Fatalf("symlink: %+v", file.New)
	}
}

func TestWorkspaceChangesInRepositorySubfolder(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"top.txt": "top\n", "sub/inner.txt": "inner\n"})
	writeFiles(t, repo, map[string]string{"top.txt": "changed\n", "sub/inner.txt": "changed\n", "sub/new.txt": "new\n", "other.txt": "other\n"})
	id := diffSession(t, s, filepath.Join(repo, "sub"))
	changes, err := s.workspaceChanges(context.Background(), id, nil)
	if err != nil {
		t.Fatal(err)
	}
	files := changesByPath(t, changes)
	if len(files) != 2 || files["inner.txt"].Status != "M" || !files["new.txt"].Untracked {
		t.Fatalf("subfolder changes: %+v", changes.Files)
	}
	file, err := s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Path: "inner.txt"})
	if err != nil || file.Old.Text != "inner\n" || file.New.Text != "changed\n" {
		t.Fatalf("subfolder file: %+v, %v", file, err)
	}
	list, err := s.workspaceFiles(context.Background(), id)
	if err != nil || !reflect.DeepEqual(list.Paths, []string{"inner.txt", "new.txt"}) {
		t.Fatalf("subfolder files: %+v, %v", list, err)
	}
}

func TestWorkspaceChangesWithoutCommits(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, nil)
	writeFiles(t, repo, map[string]string{"staged.txt": "staged\n", "loose.txt": "loose\n"})
	fixtureGit(t, repo, "add", "staged.txt")
	id := diffSession(t, s, repo)
	changes, err := s.workspaceChanges(context.Background(), id, nil)
	if err != nil {
		t.Fatal(err)
	}
	files := changesByPath(t, changes)
	if changes.Baseline.Kind != "head" || len(files) != 2 || files["staged.txt"].Status != "A" || files["staged.txt"].Untracked || !files["loose.txt"].Untracked {
		t.Fatalf("changes without commits: %+v", changes)
	}
	file, err := s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Path: "staged.txt"})
	if err != nil || file.Old.State != "missing" || file.New.Text != "staged\n" {
		t.Fatalf("file without commits: %+v, %v", file, err)
	}
}

func TestWorkspaceViewsOutsideGit(t *testing.T) {
	s := diffServer(t)
	folder := t.TempDir()
	writeFiles(t, folder, map[string]string{"notes.txt": "notes\n"})
	id := diffSession(t, s, folder)
	changes, err := s.workspaceChanges(context.Background(), id, nil)
	if err != nil || changes.Repository || changes.Reason != notRepository || changes.Files == nil {
		t.Fatalf("changes: %+v, %v", changes, err)
	}
	list, err := s.workspaceFiles(context.Background(), id)
	if err != nil || list.Repository || list.Reason != notRepository || list.Paths == nil {
		t.Fatalf("files: %+v, %v", list, err)
	}
	if _, err = s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Path: "notes.txt"}); err == nil {
		t.Fatal("file outside Git was read")
	}
}

func TestWorkspaceChangesUseManagedWorktreeBase(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"a.txt": "a\n", "b.txt": "b\n"})
	base := fixtureGit(t, repo, "rev-parse", "HEAD")
	checkout := filepath.Join(filepath.Dir(repo), filepath.Base(repo)+"-worktree")
	fixtureGit(t, repo, "worktree", "add", "-q", "-b", "bonbon/fixture", checkout, base)
	t.Cleanup(func() { os.RemoveAll(checkout) })
	writeFiles(t, checkout, map[string]string{"a.txt": "agent commit\n"})
	fixtureGit(t, checkout, "commit", "-q", "-am", "agent")
	writeFiles(t, checkout, map[string]string{"b.txt": "uncommitted\n"})
	id := diffSession(t, s, checkout)
	if err := s.store.SaveWorktree(id, history.Worktree{Path: checkout, Repository: repo, Base: "HEAD", Commit: base, Branch: "bonbon/fixture", State: "ready"}); err != nil {
		t.Fatal(err)
	}
	changes, err := s.workspaceChanges(context.Background(), id, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !changes.Base || changes.Baseline != (protocol.Baseline{Kind: "base", Label: "Since worktree base", Commit: base}) || len(changes.Files) != 2 {
		t.Fatalf("base changes: %+v", changes)
	}
	changes, err = s.workspaceChanges(context.Background(), id, &protocol.DiffRequest{Baseline: "head"})
	if err != nil || !changes.Base || changes.Baseline.Kind != "head" || len(changes.Files) != 1 || changes.Files[0].Path != "b.txt" {
		t.Fatalf("head changes: %+v, %v", changes, err)
	}
	file, err := s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Baseline: "base", Path: "a.txt"})
	if err != nil || file.Old.Text != "a\n" || file.New.Text != "agent commit\n" {
		t.Fatalf("base file: %+v, %v", file, err)
	}
	// A plain session has no worktree baseline.
	plain := diffSession(t, s, repo)
	if _, err = s.workspaceChanges(context.Background(), plain, &protocol.DiffRequest{Baseline: "base"}); err == nil {
		t.Fatal("base baseline without a managed worktree was accepted")
	}
	if _, err = s.workspaceChanges(context.Background(), plain, &protocol.DiffRequest{Baseline: "other"}); err == nil {
		t.Fatal("unknown baseline was accepted")
	}
}

func TestWorkspaceViewsRejectMissingSessionAndWorkspace(t *testing.T) {
	s := diffServer(t)
	if _, err := s.workspaceChanges(context.Background(), "missing", nil); err == nil {
		t.Fatal("unknown session was accepted")
	}
	workspace := filepath.Join(t.TempDir(), "removed")
	id := diffSession(t, s, workspace)
	if _, err := s.workspaceChanges(context.Background(), id, nil); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("missing workspace: %v", err)
	}
	if _, err := s.workspaceFiles(context.Background(), id); err == nil {
		t.Fatal("missing workspace listed files")
	}
}

func TestWorkspaceFilesListsTrackedAndUntrackedPaths(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{".gitignore": "*.log\n", "kept.txt": "kept\n", "gone.txt": "gone\n"})
	writeFiles(t, repo, map[string]string{"new.txt": "new\n", "debug.log": "ignored\n"})
	list, err := s.workspaceFiles(context.Background(), diffSession(t, s, repo))
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{".gitignore", "gone.txt", "kept.txt", "new.txt"}; !list.Repository || list.Truncated || !reflect.DeepEqual(list.Paths, want) {
		t.Fatalf("files: %+v", list)
	}
}

func TestDiffParsersDropPartialRecords(t *testing.T) {
	names := parseNameStatus([]byte("M\x00a.txt\x00R100\x00old\x00new\x00D\x00"))
	if want := []protocol.ChangedFile{{Path: "a.txt", Status: "M", Added: -1, Removed: -1}, {Path: "new", OldPath: "old", Status: "R", Added: -1, Removed: -1}}; !reflect.DeepEqual(names, want) {
		t.Fatalf("names: %+v", names)
	}
	counts := parseNumstat([]byte("1\t2\ta.txt\x00-\t-\tb.bin\x000\t0\t\x00old\x00new\x003\t4\t\x00old2\x00"))
	want := map[string]lineCount{"a.txt": {1, 2, false}, "b.bin": {-1, -1, true}, "new": {0, 0, false}}
	if !reflect.DeepEqual(counts, want) {
		t.Fatalf("counts: %+v", counts)
	}
}

func TestWorkspaceFileRequestOverWebSocket(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"a b.txt": "old\n"})
	writeFiles(t, repo, map[string]string{"a b.txt": "new\n"})
	id := diffSession(t, s, repo)
	conn, peer := attachmentPair(t)
	done := make(chan struct{})
	go func() { defer close(done); s.handle(context.Background(), conn) }()
	peer.SetReadDeadline(time.Now().Add(5 * time.Second))
	var greeting protocol.Message
	if err := peer.ReadJSON(&greeting); err != nil || greeting.Type != "server" {
		t.Fatal(greeting, err)
	}
	request := protocol.Message{Type: "request", Request: &protocol.Request{Protocol: protocol.Version, Operation: "workspace-file", Session: id, Diff: &protocol.DiffRequest{Baseline: "head", Path: "a b.txt"}}}
	if err := peer.WriteJSON(request); err != nil {
		t.Fatal(err)
	}
	var reply protocol.Message
	if err := peer.ReadJSON(&reply); err != nil || reply.Type != "result" {
		t.Fatal(reply, err)
	}
	var file protocol.WorkspaceFile
	if err := json.Unmarshal(reply.Result, &file); err != nil || file.Old.Text != "old\n" || file.New.Text != "new\n" {
		t.Fatalf("reply: %+v, %v", file, err)
	}
	peer.Close()
	<-done
}
