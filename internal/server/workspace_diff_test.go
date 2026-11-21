package server

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"bbflow/internal/history"
	"bbflow/internal/protocol"
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
	if !changes.Repository || changes.Base != nil || changes.Baseline.Kind != "head" || changes.Truncated {
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
	// The file view and the folder list need no repository.
	file, err := s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Path: "notes.txt"})
	if err != nil || file.Baseline != (protocol.Baseline{}) || file.Old.State != "missing" || file.New.Text != "notes\n" {
		t.Fatalf("file outside Git: %+v, %v", file, err)
	}
	if _, err = s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Path: "../notes.txt"}); err == nil {
		t.Fatal("a path outside the workspace was accepted")
	}
	folders, err := s.workspaceFolders(context.Background(), id, &protocol.DiffRequest{Folders: []string{""}})
	want := []protocol.FolderEntry{{Name: "notes.txt", Kind: "file"}}
	if err != nil || folders.IgnoreError != "" || !reflect.DeepEqual(folders.Folders[0].Entries, want) {
		t.Fatalf("folders outside Git: %+v, %v", folders, err)
	}
}

func listFolders(t *testing.T, s *Server, id string, paths ...string) protocol.WorkspaceFolders {
	t.Helper()
	folders, err := s.workspaceFolders(context.Background(), id, &protocol.DiffRequest{Folders: paths})
	if err != nil {
		t.Fatal(err)
	}
	if len(folders.Folders) != len(paths) {
		t.Fatalf("folders: %+v", folders)
	}
	for i, path := range paths {
		if folders.Folders[i].Path != path || folders.Folders[i].Entries == nil {
			t.Fatalf("folder %d: %+v", i, folders.Folders[i])
		}
	}
	return folders
}

func TestWorkspaceFoldersListEntries(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{
		".gitignore": "*.log\nbuild/\n", "README.md": "readme\n", "b.txt": "b\n", "Alpha.txt": "a\n",
		"src/main.go": "package main\n", "src/deep/x.go": "package deep\n", "kept.log": "tracked\n",
	})
	fixtureGit(t, repo, "add", "-f", "kept.log")
	fixtureGit(t, repo, "commit", "-q", "-m", "tracked log")
	writeFiles(t, repo, map[string]string{"debug.log": "ignored\n", "build/out.bin": "\x00", "src/trace.log": "ignored\n", ":colon.log": "ignored\n", "empty/.keep": ""})
	os.Remove(filepath.Join(repo, "empty", ".keep"))
	if err := os.Symlink("README.md", filepath.Join(repo, "link")); err != nil {
		t.Fatal(err)
	}
	// A nested repository uses its own ignore rules.
	nested := filepath.Join(repo, "nested")
	writeFiles(t, nested, map[string]string{".gitignore": "*.tmp\n", "work.tmp": "ignored\n", "work.log": "kept\n"})
	fixtureGit(t, nested, "init", "-q")
	id := diffSession(t, s, repo)
	folders := listFolders(t, s, id, "", "src", "empty", "nested", "missing", "README.md")
	if folders.IgnoreError != "" {
		t.Fatalf("ignore error: %s", folders.IgnoreError)
	}
	want := []protocol.WorkspaceFolder{
		{Path: "", Entries: []protocol.FolderEntry{
			{Name: "build", Kind: "folder", Ignored: true}, {Name: "empty", Kind: "folder"}, {Name: "nested", Kind: "folder"}, {Name: "src", Kind: "folder"},
			{Name: ".gitignore", Kind: "file"}, {Name: ":colon.log", Kind: "file", Ignored: true}, {Name: "Alpha.txt", Kind: "file"}, {Name: "b.txt", Kind: "file"},
			{Name: "debug.log", Kind: "file", Ignored: true}, {Name: "kept.log", Kind: "file"}, {Name: "link", Kind: "symlink"}, {Name: "README.md", Kind: "file"},
		}},
		{Path: "src", Entries: []protocol.FolderEntry{{Name: "deep", Kind: "folder"}, {Name: "main.go", Kind: "file"}, {Name: "trace.log", Kind: "file", Ignored: true}}},
		{Path: "empty", Entries: []protocol.FolderEntry{}},
		{Path: "nested", Entries: []protocol.FolderEntry{{Name: ".gitignore", Kind: "file"}, {Name: "work.log", Kind: "file"}, {Name: "work.tmp", Kind: "file", Ignored: true}}},
		{Path: "missing", Missing: true, Entries: []protocol.FolderEntry{}},
		{Path: "README.md", Missing: true, Entries: []protocol.FolderEntry{}},
	}
	if !reflect.DeepEqual(folders.Folders, want) {
		t.Fatalf("folders:\n got %+v\nwant %+v", folders.Folders, want)
	}
	// A repository subfolder session lists its own folder.
	sub := listFolders(t, s, diffSession(t, s, filepath.Join(repo, "src")), "")
	if !reflect.DeepEqual(sub.Folders[0].Entries, want[1].Entries) {
		t.Fatalf("subfolder session: %+v", sub.Folders[0])
	}
}

func TestWorkspaceFoldersStayInsideWorkspace(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"real/inside.txt": "inside\n"})
	outside := t.TempDir()
	writeFiles(t, outside, map[string]string{"secret.txt": "secret\n"})
	for name, target := range map[string]string{"escape": outside, "inner": "real"} {
		if err := os.Symlink(target, filepath.Join(repo, name)); err != nil {
			t.Fatal(err)
		}
	}
	id := diffSession(t, s, repo)
	for _, path := range []string{"..", "../" + filepath.Base(outside), outside, ".", "real/..", "real/", "a\x00b"} {
		if _, err := s.workspaceFolders(context.Background(), id, &protocol.DiffRequest{Folders: []string{path}}); err == nil {
			t.Errorf("folder path %q was accepted", path)
		}
	}
	for _, request := range []*protocol.DiffRequest{nil, {}, {Folders: make([]string, maxFolderRequest+1)}} {
		if _, err := s.workspaceFolders(context.Background(), id, request); err == nil {
			t.Errorf("request %+v was accepted", request)
		}
	}
	if _, err := s.workspaceFolders(context.Background(), "missing", &protocol.DiffRequest{Folders: []string{""}}); err == nil {
		t.Error("unknown session was accepted")
	}
	// A symlink is an entry. The server does not follow it, also inside the workspace.
	folders := listFolders(t, s, id, "", "escape", "inner", "escape/sub", "real")
	root := []protocol.FolderEntry{{Name: "real", Kind: "folder"}, {Name: "escape", Kind: "symlink"}, {Name: "inner", Kind: "symlink"}}
	if !reflect.DeepEqual(folders.Folders[0].Entries, root) {
		t.Fatalf("root: %+v", folders.Folders[0])
	}
	for _, folder := range folders.Folders[1:4] {
		if !folder.Missing || len(folder.Entries) != 0 {
			t.Errorf("a symlink was followed: %+v", folder)
		}
	}
	if len(folders.Folders[4].Entries) != 1 || folders.Folders[4].Missing {
		t.Fatalf("real folder: %+v", folders.Folders[4])
	}
}

func TestWorkspaceFoldersLimitEntries(t *testing.T) {
	defer func(limit int) { maxFolderEntries = limit }(maxFolderEntries)
	maxFolderEntries = 3
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"a/1": "", "a/2": "", "b/1": "", "b/2": "", "b/3": ""})
	id := diffSession(t, s, repo)
	// The limit covers all folders of one reply. `.git` does not use it.
	folders := listFolders(t, s, id, "a", "b", "")
	a, b, root := folders.Folders[0], folders.Folders[1], folders.Folders[2]
	if len(a.Entries) != 2 || a.Truncated || len(b.Entries) != 1 || !b.Truncated || len(root.Entries) != 0 || !root.Truncated {
		t.Fatalf("limited folders: %+v", folders)
	}
	if exact := listFolders(t, s, id, "b").Folders[0]; len(exact.Entries) != 3 || exact.Truncated {
		t.Fatalf("a folder at the limit: %+v", exact)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.workspaceFolders(ctx, id, &protocol.DiffRequest{Folders: []string{""}}); err == nil {
		t.Fatal("a canceled request listed folders")
	}
}

func TestWorkspaceChangesUseManagedWorktreeBase(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"a.txt": "a\n", "b.txt": "b\n"})
	base := fixtureGit(t, repo, "rev-parse", "HEAD")
	checkout := filepath.Join(filepath.Dir(repo), filepath.Base(repo)+"-worktree")
	fixtureGit(t, repo, "worktree", "add", "-q", "-b", "bbflow/fixture", checkout, base)
	t.Cleanup(func() { os.RemoveAll(checkout) })
	writeFiles(t, checkout, map[string]string{"a.txt": "agent commit\n"})
	fixtureGit(t, checkout, "commit", "-q", "-am", "agent")
	writeFiles(t, checkout, map[string]string{"b.txt": "uncommitted\n"})
	id := diffSession(t, s, checkout)
	if err := s.store.SaveWorktree(id, history.Worktree{Path: checkout, Repository: repo, Base: "HEAD", Commit: base, Branch: "bbflow/fixture", State: "ready"}); err != nil {
		t.Fatal(err)
	}
	changes, err := s.workspaceChanges(context.Background(), id, nil)
	if err != nil {
		t.Fatal(err)
	}
	if *changes.Base != (protocol.Base{Commit: base}) || changes.Baseline != (protocol.Baseline{Kind: "base", Label: "Since worktree base", Commit: base}) || len(changes.Files) != 2 {
		t.Fatalf("base changes: %+v", changes)
	}
	changes, err = s.workspaceChanges(context.Background(), id, &protocol.DiffRequest{Baseline: "head"})
	if err != nil || changes.Base == nil || changes.Baseline.Kind != "head" || len(changes.Files) != 1 || changes.Files[0].Path != "b.txt" {
		t.Fatalf("head changes: %+v, %v", changes, err)
	}
	file, err := s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Baseline: "base", Path: "a.txt"})
	if err != nil || file.Old.Text != "a\n" || file.New.Text != "agent commit\n" {
		t.Fatalf("base file: %+v, %v", file, err)
	}
	// A plain session on the default branch has no base. A base request then uses the
	// default baseline.
	plain := diffSession(t, s, repo)
	changes, err = s.workspaceChanges(context.Background(), plain, &protocol.DiffRequest{Baseline: "base"})
	if err != nil || changes.Base != nil || changes.Baseline.Kind != "head" {
		t.Fatalf("base request without a base: %+v, %v", changes, err)
	}
	if _, err = s.workspaceChanges(context.Background(), plain, &protocol.DiffRequest{Baseline: "other"}); err == nil {
		t.Fatal("unknown baseline was accepted")
	}
}

func TestWorkspaceChangesFromCommit(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n"})
	base := fixtureGit(t, repo, "rev-parse", "HEAD")
	checkout := filepath.Join(filepath.Dir(repo), filepath.Base(repo)+"-worktree")
	fixtureGit(t, repo, "worktree", "add", "-q", "-b", "bbflow/fixture", checkout, base)
	t.Cleanup(func() { os.RemoveAll(checkout) })
	commit := func(name, text, subject string) string {
		writeFiles(t, checkout, map[string]string{name: text})
		fixtureGit(t, checkout, "commit", "-q", "-am", subject)
		return fixtureGit(t, checkout, "rev-parse", "HEAD")
	}
	first := commit("a.txt", "first\n", "First")
	second := commit("b.txt", "second\n", "Second\tstep")
	third := commit("c.txt", "third\n", "Third")
	writeFiles(t, checkout, map[string]string{"loose.txt": "loose\n"})
	id := diffSession(t, s, checkout)
	if err := s.store.SaveWorktree(id, history.Worktree{Path: checkout, Repository: repo, Base: "HEAD", Commit: base, Branch: "bbflow/fixture", State: "ready"}); err != nil {
		t.Fatal(err)
	}
	changes, err := s.workspaceChanges(context.Background(), id, nil)
	if err != nil {
		t.Fatal(err)
	}
	// The list has each commit since the base, with its file count.
	want := []protocol.Commit{{ID: third, Subject: "Third", Files: 1}, {ID: second, Subject: "Second\tstep", Files: 1}, {ID: first, Subject: "First", Files: 1}}
	if changes.Baseline.Kind != "base" || !reflect.DeepEqual(changes.Commits, want) || changes.MoreCommits {
		t.Fatalf("commit list: %+v", changes)
	}
	if paths := changedPaths(changes); !reflect.DeepEqual(paths, []string{"a.txt", "b.txt", "c.txt", "loose.txt"}) {
		t.Fatalf("base changes: %v", paths)
	}
	changes, err = s.workspaceChanges(context.Background(), id, &protocol.DiffRequest{Baseline: "commit", From: second})
	if err != nil {
		t.Fatal(err)
	}
	if changes.Baseline != (protocol.Baseline{Kind: "commit", Label: "Changes from commit " + second[:7], Commit: first, From: second}) {
		t.Fatalf("commit baseline: %+v", changes.Baseline)
	}
	if paths := changedPaths(changes); !reflect.DeepEqual(paths, []string{"b.txt", "c.txt", "loose.txt"}) {
		t.Fatalf("changes from the second commit: %v", paths)
	}
	file, err := s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Baseline: "commit", From: third, Path: "c.txt"})
	if err != nil || file.Baseline.Commit != second || file.Old.Text != "c\n" || file.New.Text != "third\n" {
		t.Fatalf("file from the third commit: %+v, %v", file, err)
	}
	// One commit compares its first parent with its own tree. The untracked file is not
	// part of a commit.
	changes, err = s.workspaceChanges(context.Background(), id, &protocol.DiffRequest{Baseline: "commit", From: second, To: second})
	if err != nil || changes.Baseline != (protocol.Baseline{Kind: "commit", Label: "Commit " + second[:7], Commit: first, From: second, To: second}) {
		t.Fatalf("one commit: %+v, %v", changes.Baseline, err)
	}
	if paths := changedPaths(changes); !reflect.DeepEqual(paths, []string{"b.txt"}) || changes.Files[0].Added != 1 || changes.Files[0].Removed != 1 {
		t.Fatalf("changes of one commit: %+v", changes.Files)
	}
	// A range of commits ends at the tree of its newest commit.
	changes, err = s.workspaceChanges(context.Background(), id, &protocol.DiffRequest{Baseline: "commit", From: first, To: second})
	if err != nil || changes.Baseline.Commit != base || changes.Baseline.Label != "Commits "+first[:7]+" to "+second[:7] {
		t.Fatalf("commit range: %+v, %v", changes.Baseline, err)
	}
	if paths := changedPaths(changes); !reflect.DeepEqual(paths, []string{"a.txt", "b.txt"}) {
		t.Fatalf("changes of a commit range: %v", paths)
	}
	// The new side of a file comes from the to commit, also when the file changed later
	// or is not in the commit.
	writeFiles(t, checkout, map[string]string{"b.txt": "uncommitted\n"})
	file, err = s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Baseline: "commit", From: second, To: second, Path: "b.txt"})
	if err != nil || file.Baseline.To != second || file.Old.Text != "b\n" || file.New.Text != "second\n" {
		t.Fatalf("file of one commit: %+v, %v", file, err)
	}
	file, err = s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Baseline: "commit", From: second, To: second, Path: "loose.txt"})
	if err != nil || file.Old.State != "missing" || file.New.State != "missing" {
		t.Fatalf("untracked file in one commit: %+v, %v", file, err)
	}
	// A to commit needs the commit baseline, and it must not be older than from.
	for _, request := range []protocol.DiffRequest{{Baseline: "head", To: second}, {To: second}, {Baseline: "commit", From: second, To: first}} {
		if _, err = s.workspaceChanges(context.Background(), id, &request); err == nil {
			t.Fatalf("request %+v was accepted", request)
		}
	}
	// A commit outside the list falls back to the default baseline.
	for _, request := range []protocol.DiffRequest{{From: base}, {From: ""}, {From: "HEAD"}, {From: third[:7]}, {From: second, To: base}} {
		request.Baseline = "commit"
		changes, err = s.workspaceChanges(context.Background(), id, &request)
		if err != nil || changes.Baseline.Kind != "base" {
			t.Fatalf("request %+v: %+v, %v", request, changes.Baseline, err)
		}
	}
	// A rebase removes the listed commits. The old ID then uses the default too.
	fixtureGit(t, checkout, "reset", "-q", "--soft", first)
	fixtureGit(t, checkout, "commit", "-q", "-m", "Squashed")
	changes, err = s.workspaceChanges(context.Background(), id, &protocol.DiffRequest{Baseline: "commit", From: third, To: third})
	if err != nil || changes.Baseline.Kind != "base" || len(changes.Commits) != 2 || changes.Commits[0].Subject != "Squashed" || changes.Commits[0].Files != 2 {
		t.Fatalf("after a rebase: %+v, %v", changes, err)
	}
}

func TestWorkspaceChangesUseMergeBaseWithDefaultBranch(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"a.txt": "a\n", "sub/b.txt": "b\n"})
	fork := fixtureGit(t, repo, "rev-parse", "HEAD")
	fixtureGit(t, repo, "switch", "-q", "-c", "feature")
	writeFiles(t, repo, map[string]string{"a.txt": "feature\n", "sub/b.txt": "feature\n"})
	fixtureGit(t, repo, "commit", "-q", "-am", "Feature")
	feature := fixtureGit(t, repo, "rev-parse", "HEAD")
	fixtureGit(t, repo, "commit", "-q", "--allow-empty", "-m", "Empty")
	// main moves on after the fork. Its later commit is not part of the changes.
	fixtureGit(t, repo, "switch", "-q", "main")
	writeFiles(t, repo, map[string]string{"main.txt": "main\n"})
	fixtureGit(t, repo, "add", "main.txt")
	fixtureGit(t, repo, "commit", "-q", "-m", "Main")
	fixtureGit(t, repo, "switch", "-q", "feature")
	writeFiles(t, repo, map[string]string{"loose.txt": "loose\n"})
	id := diffSession(t, s, repo)
	changes, err := s.workspaceChanges(context.Background(), id, nil)
	if err != nil {
		t.Fatal(err)
	}
	if changes.Base == nil || *changes.Base != (protocol.Base{Commit: fork, Branch: "main"}) || changes.Baseline.Label != "Since the merge base with main" {
		t.Fatalf("merge base: %+v, %+v", changes.Base, changes.Baseline)
	}
	if len(changes.Commits) != 2 || changes.Commits[0].Files != 0 || changes.Commits[1] != (protocol.Commit{ID: feature, Subject: "Feature", Files: 2}) || changes.MoreCommits {
		t.Fatalf("commits since the merge base: %+v", changes.Commits)
	}
	if paths := changedPaths(changes); !reflect.DeepEqual(paths, []string{"a.txt", "loose.txt", "sub/b.txt"}) {
		t.Fatalf("changes since the merge base: %v", paths)
	}
	// A subfolder session counts only the files in its folder.
	sub := diffSession(t, s, filepath.Join(repo, "sub"))
	changes, err = s.workspaceChanges(context.Background(), sub, &protocol.DiffRequest{Baseline: "commit", From: feature, To: feature})
	if err != nil || changes.Commits[1].Files != 1 || !reflect.DeepEqual(changedPaths(changes), []string{"b.txt"}) {
		t.Fatalf("subfolder commit: %+v, %v", changes, err)
	}
	// On main without local commits, HEAD is the merge base. The session then has no
	// base. A base request from before the switch uses the default baseline.
	fixtureGit(t, repo, "switch", "-q", "main")
	changes, err = s.workspaceChanges(context.Background(), id, nil)
	if err != nil || changes.Base != nil || changes.Baseline.Kind != "head" || len(changes.Commits) != 2 {
		t.Fatalf("default branch: %+v, %v", changes, err)
	}
	changes, err = s.workspaceChanges(context.Background(), id, &protocol.DiffRequest{Baseline: "base"})
	if err != nil || changes.Baseline.Kind != "head" {
		t.Fatalf("base request on the default branch: %+v, %v", changes.Baseline, err)
	}
	file, err := s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Baseline: "base", Path: "a.txt"})
	if err != nil || file.Baseline.Kind != "head" {
		t.Fatalf("base file request on the default branch: %+v, %v", file.Baseline, err)
	}
	// A clone uses the branch of origin/HEAD, which is the branch of the cloned
	// repository.
	clone := filepath.Join(t.TempDir(), "clone")
	fixtureGit(t, repo, "clone", "-q", "file://"+repo, clone)
	fixtureGit(t, clone, "switch", "-q", "-c", "work")
	writeFiles(t, clone, map[string]string{"a.txt": "work\n"})
	fixtureGit(t, clone, "commit", "-q", "-am", "Work")
	cloned := diffSession(t, s, clone)
	changes, err = s.workspaceChanges(context.Background(), cloned, nil)
	if err != nil || changes.Base == nil || changes.Base.Branch != "origin/main" || len(changes.Commits) != 1 || changes.Baseline.Kind != "base" {
		t.Fatalf("clone: %+v, %v", changes, err)
	}
	// On main of the clone, a local commit that origin/main does not have gets
	// origin/main as its base. Without it, the session has no base.
	fixtureGit(t, clone, "switch", "-q", "main")
	changes, err = s.workspaceChanges(context.Background(), cloned, nil)
	if err != nil || changes.Base != nil || changes.Baseline.Kind != "head" {
		t.Fatalf("main of the clone: %+v, %v", changes, err)
	}
	writeFiles(t, clone, map[string]string{"local.txt": "local\n"})
	fixtureGit(t, clone, "add", "local.txt")
	fixtureGit(t, clone, "commit", "-q", "-m", "Local")
	changes, err = s.workspaceChanges(context.Background(), cloned, nil)
	if err != nil || changes.Base == nil || changes.Base.Branch != "origin/main" || len(changes.Commits) != 1 || changes.Commits[0].Subject != "Local" ||
		!reflect.DeepEqual(changedPaths(changes), []string{"local.txt"}) {
		t.Fatalf("local commit on main of the clone: %+v, %v", changes, err)
	}
	// Without a common commit, the session has no base.
	fixtureGit(t, repo, "switch", "-q", "--orphan", "lonely")
	fixtureGit(t, repo, "commit", "-q", "--allow-empty", "-m", "Lonely")
	changes, err = s.workspaceChanges(context.Background(), id, nil)
	if err != nil || changes.Base != nil || changes.Baseline.Kind != "head" {
		t.Fatalf("no merge base: %+v, %v", changes, err)
	}
}

func TestCommitFileCountsUseTheRulesOfTheFileList(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"old name.txt": "same text for a rename\n"})
	// The repository settings must not change the count. The file list ignores them.
	fixtureGit(t, repo, "config", "diff.renames", "false")
	fixtureGit(t, repo, "config", "log.showRoot", "false")
	root := fixtureGit(t, repo, "rev-parse", "HEAD")
	fixtureGit(t, repo, "mv", "old name.txt", "new name.txt")
	fixtureGit(t, repo, "commit", "-q", "-m", "Rename")
	rename := fixtureGit(t, repo, "rev-parse", "HEAD")
	id := diffSession(t, s, repo)
	changes, err := s.workspaceChanges(context.Background(), id, nil)
	if err != nil || len(changes.Commits) != 2 || changes.Commits[0].Files != 1 || changes.Commits[1].Files != 1 {
		t.Fatalf("file counts: %+v, %v", changes.Commits, err)
	}
	for _, commit := range []string{rename, root} {
		changes, err = s.workspaceChanges(context.Background(), id, &protocol.DiffRequest{Baseline: "commit", From: commit, To: commit})
		if err != nil || len(changes.Files) != 1 {
			t.Fatalf("files of commit %s: %+v, %v", commit[:7], changes.Files, err)
		}
	}
	if changes.Files[0].Status != "A" {
		t.Fatalf("root commit: %+v", changes.Files)
	}
}

func TestWorkspaceChangesListLatestCommits(t *testing.T) {
	defer func(limit int) { maxCommits = limit }(maxCommits)
	maxCommits = 2
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"a.txt": "a\n"})
	root := fixtureGit(t, repo, "rev-parse", "HEAD")
	id := diffSession(t, s, repo)
	// Without a worktree base, the list starts at HEAD. A root commit compares with the
	// empty tree.
	changes, err := s.workspaceChanges(context.Background(), id, &protocol.DiffRequest{Baseline: "commit", From: root})
	if err != nil || len(changes.Commits) != 1 || changes.MoreCommits || changes.Baseline.Kind != "commit" {
		t.Fatalf("root commit: %+v, %v", changes, err)
	}
	if paths := changedPaths(changes); !reflect.DeepEqual(paths, []string{"a.txt"}) || changes.Files[0].Status != "A" {
		t.Fatalf("root commit changes: %+v", changes.Files)
	}
	for _, text := range []string{"b\n", "c\n"} {
		writeFiles(t, repo, map[string]string{"a.txt": text})
		fixtureGit(t, repo, "commit", "-q", "-am", "next")
	}
	changes, err = s.workspaceChanges(context.Background(), id, nil)
	if err != nil || len(changes.Commits) != 2 || !changes.MoreCommits || changes.Baseline.Kind != "head" {
		t.Fatalf("limited list: %+v, %v", changes, err)
	}
	// A repository without commits has no list.
	empty := diffSession(t, s, diffRepository(t, nil))
	changes, err = s.workspaceChanges(context.Background(), empty, nil)
	if err != nil || changes.Commits == nil || len(changes.Commits) != 0 {
		t.Fatalf("empty repository: %+v, %v", changes, err)
	}
}

func TestWorkspaceChangesCommitListLimits(t *testing.T) {
	defer func(limit, bytes int) { maxCommits, maxCommitList = limit, bytes }(maxCommits, maxCommitList)
	maxCommits = 2
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"a.txt": "0\n"})
	base := fixtureGit(t, repo, "rev-parse", "HEAD")
	next := func(text, subject string) {
		writeFiles(t, repo, map[string]string{"a.txt": text})
		fixtureGit(t, repo, "commit", "-q", "-am", subject)
	}
	list := func(base string) ([]listedCommit, bool) {
		t.Helper()
		commits, more, err := listCommits(context.Background(), repo, fixtureGit(t, repo, "rev-parse", "HEAD"), base)
		if err != nil {
			t.Fatal(err)
		}
		return commits, more
	}
	// The list stops at the base. Two commits fill the list.
	for i, text := range []string{"1\n", "2\n"} {
		next(text, "Commit "+strconv.Itoa(i+1))
	}
	if commits, more := list(base); len(commits) != 2 || more || commits[1].Subject != "Commit 1" {
		t.Fatalf("two commits after the base: %+v, %v", commits, more)
	}
	next("3\n", "Commit 3")
	if commits, more := list(base); len(commits) != 2 || !more || commits[0].Subject != "Commit 3" {
		t.Fatalf("three commits after the base: %+v, %v", commits, more)
	}
	// A commit after the output limit is not in the list, and the list reports it. The
	// record of the first commit, with its file count, takes 137 bytes.
	maxCommits, maxCommitList = 30, 200
	next("5\n", strings.Repeat("long ", 20))
	next("6\n", "Short")
	if commits, more := list(""); len(commits) != 1 || !more || commits[0].Subject != "Short" {
		t.Fatalf("output limit: %+v, %v", commits, more)
	}
	// A shallow clone hides the parent of its last commit. The list omits that commit.
	maxCommitList = 1 << 20
	clone := filepath.Join(t.TempDir(), "shallow")
	fixtureGit(t, repo, "clone", "-q", "--depth", "2", "file://"+repo, clone)
	id := diffSession(t, s, clone)
	changes, err := s.workspaceChanges(context.Background(), id, nil)
	if err != nil || len(changes.Commits) != 1 || changes.Commits[0].Subject != "Short" || !changes.MoreCommits {
		t.Fatalf("shallow clone: %+v, %v", changes, err)
	}
	boundary := fixtureGit(t, clone, "rev-parse", "HEAD~1")
	changes, err = s.workspaceChanges(context.Background(), id, &protocol.DiffRequest{Baseline: "commit", From: boundary})
	if err != nil || changes.Baseline.Kind != "head" {
		t.Fatalf("shallow boundary commit: %+v, %v", changes.Baseline, err)
	}
}

func changedPaths(changes protocol.WorkspaceChanges) []string {
	var paths []string
	for _, file := range changes.Files {
		paths = append(paths, file.Path)
	}
	slices.Sort(paths)
	return paths
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

// requestResult sends one request through the server and returns its result.
func requestResult(t *testing.T, s *Server, request protocol.Request, result any) {
	t.Helper()
	conn, peer := attachmentPair(t)
	done := make(chan struct{})
	go func() { defer close(done); s.handle(context.Background(), conn) }()
	peer.SetReadDeadline(time.Now().Add(5 * time.Second))
	var greeting protocol.Message
	if err := peer.ReadJSON(&greeting); err != nil || greeting.Type != "server" {
		t.Fatal(greeting, err)
	}
	request.Protocol = protocol.Version
	if err := peer.WriteJSON(protocol.Message{Type: "request", Request: &request}); err != nil {
		t.Fatal(err)
	}
	var reply protocol.Message
	if err := peer.ReadJSON(&reply); err != nil || reply.Type != "result" {
		t.Fatal(reply, err)
	}
	if err := json.Unmarshal(reply.Result, result); err != nil {
		t.Fatal(err)
	}
	peer.Close()
	<-done
}

func TestWorkspaceRequestsOverWebSocket(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"a b.txt": "old\n"})
	writeFiles(t, repo, map[string]string{"a b.txt": "new\n"})
	id := diffSession(t, s, repo)
	var file protocol.WorkspaceFile
	requestResult(t, s, protocol.Request{Operation: "workspace-file", Session: id, Diff: &protocol.DiffRequest{Baseline: "head", Path: "a b.txt"}}, &file)
	if file.Old.Text != "old\n" || file.New.Text != "new\n" {
		t.Fatalf("file reply: %+v", file)
	}
	var folders protocol.WorkspaceFolders
	requestResult(t, s, protocol.Request{Operation: "workspace-folders", Session: id, Diff: &protocol.DiffRequest{Folders: []string{""}}}, &folders)
	if len(folders.Folders) != 1 || !reflect.DeepEqual(folders.Folders[0].Entries, []protocol.FolderEntry{{Name: "a b.txt", Kind: "file"}}) {
		t.Fatalf("folders reply: %+v", folders)
	}
}

func TestWorkspaceChangesLimitUntrackedScan(t *testing.T) {
	defer func(limit int) { maxDiffFiles = limit }(maxDiffFiles)
	maxDiffFiles = 3
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"tracked.txt": "old\n"})
	writeFiles(t, repo, map[string]string{"tracked.txt": "new\n", "u1": "1\n", "u2": "2\n", "u3": "3\n", "u4": "4\n"})
	id := diffSession(t, s, repo)
	changes, err := s.workspaceChanges(context.Background(), id, nil)
	if err != nil || len(changes.Files) != 3 || !changes.Truncated {
		t.Fatalf("limited changes: %+v, %v", changes, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = s.workspaceChanges(ctx, id, nil); err == nil {
		t.Fatal("a canceled request listed changes")
	}
}

func TestWorkspaceChangesShowNestedRepositoryAndUntrackedDeletion(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"kept.txt": "one\n"})
	fixtureGit(t, repo, "rm", "-q", "--cached", "kept.txt")
	nested := filepath.Join(repo, "vendor", "lib")
	if err := os.MkdirAll(nested, 0700); err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, nested, "init", "-q")
	id := diffSession(t, s, repo)
	changes, err := s.workspaceChanges(context.Background(), id, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]protocol.ChangedFile{
		"kept.txt":   {Path: "kept.txt", Status: "M", Added: -1, Removed: -1, Untracked: true},
		"vendor/lib": {Path: "vendor/lib", Status: "A", Added: -1, Untracked: true},
	}
	if files := changesByPath(t, changes); !reflect.DeepEqual(files, want) || len(changes.Files) != 2 {
		t.Fatalf("files:\n got %+v\nwant %+v", changes.Files, want)
	}
	file, err := s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Path: "vendor/lib"})
	if err != nil || file.New.State != "other" || file.Old.State != "missing" {
		t.Fatalf("nested repository: %+v, %v", file, err)
	}
	file, err = s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Path: "kept.txt"})
	if err != nil || file.Old.Text != "one\n" || file.New.Text != "one\n" {
		t.Fatalf("untracked deletion: %+v, %v", file, err)
	}
	list, err := s.workspaceFiles(context.Background(), id)
	if err != nil || !reflect.DeepEqual(list.Paths, []string{"kept.txt", "vendor/lib"}) {
		t.Fatalf("files: %+v, %v", list, err)
	}
}

func TestWorkspaceViewsReportGitFailures(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"a.txt": "a\n"})
	id := diffSession(t, s, repo)
	t.Setenv("PATH", t.TempDir())
	changes, err := s.workspaceChanges(context.Background(), id, nil)
	if err == nil || changes.Reason == notRepository {
		t.Fatalf("missing Git was reported as no repository: %+v, %v", changes, err)
	}
	list, err := s.workspaceFiles(context.Background(), id)
	if err == nil || list.Reason == notRepository {
		t.Fatalf("missing Git was reported as no repository: %+v, %v", list, err)
	}
	// The file view and the folder list show the current files without Git.
	file, err := s.workspaceFile(context.Background(), id, &protocol.DiffRequest{Path: "a.txt"})
	if err != nil || file.New.Text != "a\n" || file.Old.State != "missing" || file.Baseline.Commit != "" {
		t.Fatalf("file without Git: %+v, %v", file, err)
	}
	folders := listFolders(t, s, id, "")
	if folders.IgnoreError != "" || !reflect.DeepEqual(folders.Folders[0].Entries, []protocol.FolderEntry{{Name: "a.txt", Kind: "file"}}) {
		t.Fatalf("folders without Git: %+v", folders)
	}
}

func TestWorkspaceFoldersReportIgnoreFailure(t *testing.T) {
	s := diffServer(t)
	repo := diffRepository(t, map[string]string{"a.txt": "a\n"})
	// Git refuses a repository with a damaged configuration.
	writeFiles(t, repo, map[string]string{".git/config": "[core\n"})
	folders := listFolders(t, s, diffSession(t, s, repo), "")
	if folders.IgnoreError == "" || len(folders.Folders[0].Entries) != 1 {
		t.Fatalf("a Git failure was hidden or stopped the list: %+v", folders)
	}
}

func TestRevisionSeparatesMissingCommitFromFailure(t *testing.T) {
	repo := diffRepository(t, nil)
	commit, err := revision(context.Background(), repo, "HEAD")
	if err != nil || commit != "" {
		t.Fatalf("unborn HEAD: %q, %v", commit, err)
	}
	if _, err = revision(context.Background(), filepath.Join(repo, "missing"), "HEAD"); err == nil {
		t.Fatal("a failed Git command was reported as a missing commit")
	}
}
