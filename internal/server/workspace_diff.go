package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"bonbon/internal/protocol"
	agent "bonbon/internal/runtime"
)

// Limits of the read-only diff and file views. Tests make them smaller.
var (
	maxDiffFiles     = 5000  // Changed files in one list.
	maxFolderEntries = 20000 // Entries in one reply of folder lists.
)

const (
	maxFolderRequest  = 200      // Folders in one request.
	maxWorkspaceFiles = 20000    // Paths in the list that the Files filter searches.
	maxFileSide       = 1 << 20  // Bytes of one side of one file.
	maxGitList        = 16 << 20 // Bytes of one Git list output.
	maxCountBudget    = 32 << 20 // Bytes read to count lines of untracked files.
	gitReadTimeout    = 10 * time.Second
)

// gitEnv removes Git variables of the server's launcher. Git state belongs to the
// selected repository.
func gitEnv() []string {
	var env []string
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "GIT_") {
			env = append(env, item)
		}
	}
	return append(env, "GIT_TERMINAL_PROMPT=0")
}

// gitCommand prepares a read-only Git command in dir. The command does not take
// optional locks, so it does not block Git commands of a live agent. An fsmonitor hook
// from the repository configuration does not run. Messages use the C locale, so that
// callers can identify a missing repository.
func gitCommand(ctx context.Context, dir string, args ...string) *exec.Cmd {
	base := []string{"-C", dir, "-c", "core.fsmonitor=false", "-c", "core.quotePath=false"}
	cmd := exec.CommandContext(ctx, "git", append(base, args...)...)
	cmd.Env = append(gitEnv(), "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
	return cmd
}

// gitRead runs a read-only Git command in dir and returns at most limit bytes of
// stdout. More reports that Git wrote more output. Paths are literal. Clean filters
// from the repository configuration, such as Git LFS, still run when Git compares work
// files.
func gitRead(ctx context.Context, dir string, limit int, args ...string) (out []byte, more bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, gitReadTimeout)
	defer cancel()
	cmd := gitCommand(ctx, dir, args...)
	cmd.Env = append(cmd.Env, "GIT_LITERAL_PATHSPECS=1")
	var stderr bytes.Buffer
	cmd.Stderr = &limitedWriter{buffer: &stderr, limit: 4096}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false, err
	}
	if err = cmd.Start(); err != nil {
		return nil, false, err
	}
	out, readErr := io.ReadAll(io.LimitReader(stdout, int64(limit)+1))
	if len(out) > limit {
		out, more = out[:limit], true
		cancel()
	}
	err = cmd.Wait()
	if more {
		return out, true, nil
	}
	if ctx.Err() == context.DeadlineExceeded {
		return nil, false, fmt.Errorf("git %s took more than %s", args[0], gitReadTimeout)
	}
	if err != nil {
		return nil, false, &gitError{command: args[0], err: err, stderr: strings.TrimSpace(stderr.String())}
	}
	return out, false, readErr
}

// gitError is a failed Git command. Stderr holds the first part of its error output.
type gitError struct {
	command string
	err     error
	stderr  string
}

func (e *gitError) Error() string { return fmt.Sprintf("git %s: %v: %s", e.command, e.err, e.stderr) }
func (e *gitError) Unwrap() error { return e.err }

// isNotRepository reports that Git found no repository. Other failures, such as a
// missing Git executable, a timeout, or a safe.directory refusal, are real errors.
func isNotRepository(err error) bool {
	var failure *gitError
	return errors.As(err, &failure) && strings.Contains(strings.ToLower(failure.stderr), "not a git repository")
}

// withoutGit reports that the workspace is not in a Git repository, or that the server
// has no Git executable. The file views then show the current files without Git data.
func withoutGit(err error) bool {
	return errors.Is(err, errNotRepository) || isNotRepository(err) || errors.Is(err, exec.ErrNotFound)
}

// isQuietMiss reports that `git rev-parse --verify --quiet` found no commit. Git then
// exits with status 1 and writes no error.
func isQuietMiss(err error) bool {
	var failure *gitError
	var exit *exec.ExitError
	return errors.As(err, &failure) && failure.stderr == "" && errors.As(err, &exit) && exit.ExitCode() == 1
}

type limitedWriter struct {
	buffer *bytes.Buffer
	limit  int
}

func (w *limitedWriter) Write(data []byte) (int, error) {
	if room := w.limit - w.buffer.Len(); room > 0 {
		w.buffer.Write(data[:min(room, len(data))])
	}
	return len(data), nil
}

// diffTarget is the resolved workspace and baseline of a diff request.
type diffTarget struct {
	workspace string
	base      bool // The managed worktree baseline is available.
	baseline  protocol.Baseline
}

var errNotRepository = errors.New("not a Git repository")

const notRepository = "Not a Git repository."

// resolveDiff finds the session workspace and the baseline commit. It never accepts a
// workspace path from the client.
func (s *Server) resolveDiff(ctx context.Context, id string, request *protocol.DiffRequest) (diffTarget, error) {
	var target diffTarget
	session, err := s.store.Session(id)
	if err != nil {
		return target, err
	}
	target.workspace, err = agent.Canonical(session.Workspace)
	if err != nil {
		return target, fmt.Errorf("the session workspace is not available: %w", err)
	}
	if _, _, err = gitRead(ctx, target.workspace, 4096, "rev-parse", "--show-toplevel"); err != nil {
		if isNotRepository(err) {
			return target, errNotRepository
		}
		return target, err
	}
	w := session.Worktree
	target.base = w != nil && w.State == "ready" && w.Commit != "" && within(w.Path, target.workspace)
	kind := ""
	if request != nil {
		kind = request.Baseline
	}
	switch {
	case kind == "" && target.base, kind == "base":
		if !target.base {
			return target, errors.New("this session has no managed worktree baseline")
		}
		commit, err := revision(ctx, target.workspace, w.Commit)
		if err == nil && commit == "" {
			err = errors.New("Git has no such commit")
		}
		if err != nil {
			return target, fmt.Errorf("the worktree base commit is not available: %w", err)
		}
		target.baseline = protocol.Baseline{Kind: "base", Label: "Since worktree base", Commit: commit}
	case kind == "" || kind == "head":
		commit, err := revision(ctx, target.workspace, "HEAD")
		if err != nil {
			return target, err
		}
		if commit == "" {
			// Compare with the empty tree in a repository without commits.
			out, _, treeErr := gitRead(ctx, target.workspace, 4096, "hash-object", "-t", "tree", os.DevNull)
			if treeErr != nil {
				return target, treeErr
			}
			commit = strings.TrimSpace(string(out))
		}
		target.baseline = protocol.Baseline{Kind: "head", Label: "Uncommitted changes", Commit: commit}
	default:
		return target, errors.New("unknown diff baseline")
	}
	return target, nil
}

// revision resolves a commit. It returns an empty commit, without an error, when Git
// has no such commit. Other failures are errors.
func revision(ctx context.Context, dir, name string) (string, error) {
	out, _, err := gitRead(ctx, dir, 4096, "rev-parse", "--verify", "--quiet", "--end-of-options", name+"^{commit}")
	if isQuietMiss(err) {
		return "", nil
	}
	return strings.TrimSpace(string(out)), err
}

func (s *Server) workspaceChanges(ctx context.Context, id string, request *protocol.DiffRequest) (protocol.WorkspaceChanges, error) {
	result := protocol.WorkspaceChanges{Files: []protocol.ChangedFile{}}
	target, err := s.resolveDiff(ctx, id, request)
	if errors.Is(err, errNotRepository) {
		result.Reason = notRepository
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.Repository, result.Base, result.Baseline = true, target.base, target.baseline
	// --relative limits a repository subfolder session to its own folder.
	diff := []string{"diff", "--no-ext-diff", "--no-textconv", "--no-color", "--relative", "-M", "-z"}
	names, moreNames, err := gitRead(ctx, target.workspace, maxGitList, append(diff, "--name-status", target.baseline.Commit, "--")...)
	if err != nil {
		return result, err
	}
	counts, moreCounts, err := gitRead(ctx, target.workspace, maxGitList, append(diff, "--numstat", target.baseline.Commit, "--")...)
	if err != nil {
		return result, err
	}
	untracked, moreUntracked, err := gitRead(ctx, target.workspace, maxGitList, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return result, err
	}
	result.Files = parseNameStatus(names)
	applyNumstat(result.Files, parseNumstat(counts))
	result.Truncated = moreNames || moreCounts || moreUntracked
	if len(result.Files) > maxDiffFiles {
		result.Files, result.Truncated = result.Files[:maxDiffFiles], true
	}
	root, err := os.OpenRoot(target.workspace)
	if err != nil {
		return result, err
	}
	defer root.Close()
	// After `git rm --cached`, a path is deleted from Git and also untracked. Show one row.
	deleted := map[string]int{}
	for i, file := range result.Files {
		if file.Status == "D" {
			deleted[file.Path] = i
		}
	}
	budget := maxCountBudget
	for _, path := range splitZ(untracked) {
		if err = ctx.Err(); err != nil {
			return result, err
		}
		// Git lists an untracked nested repository as a folder with a final slash.
		path = strings.TrimSuffix(path, "/")
		if i, ok := deleted[path]; ok {
			result.Files[i] = protocol.ChangedFile{Path: path, Status: "M", Added: -1, Removed: -1, Untracked: true}
			continue
		}
		if len(result.Files) >= maxDiffFiles {
			result.Truncated = true
			break
		}
		file := protocol.ChangedFile{Path: path, Status: "A", Untracked: true}
		file.Added, file.Binary = countLines(root, path, &budget)
		result.Files = append(result.Files, file)
	}
	return result, nil
}

// splitZ splits NUL-terminated records. It drops the text after the last NUL, which is
// empty or the partial record of truncated output.
func splitZ(out []byte) []string {
	records := strings.Split(string(out), "\x00")
	return records[:len(records)-1]
}

func parseNameStatus(out []byte) []protocol.ChangedFile {
	files := []protocol.ChangedFile{}
	records := splitZ(out)
	for i := 0; i < len(records); {
		status := records[i]
		if status == "" {
			break
		}
		file := protocol.ChangedFile{Status: status[:1], Added: -1, Removed: -1}
		paths := 1
		if file.Status == "R" || file.Status == "C" {
			paths = 2
		}
		if i+paths >= len(records) {
			break // A partial record of truncated output.
		}
		if paths == 2 {
			file.OldPath, file.Path = records[i+1], records[i+2]
			if file.Status == "C" {
				file.Status, file.OldPath = "A", ""
			}
		} else {
			file.Path = records[i+1]
		}
		files = append(files, file)
		i += 1 + paths
	}
	return files
}

type lineCount struct {
	added, removed int
	binary         bool
}

// parseNumstat reads `git diff --numstat -z` records by their new path.
func parseNumstat(out []byte) map[string]lineCount {
	counts := map[string]lineCount{}
	records := splitZ(out)
	for i := 0; i < len(records); i++ {
		fields := strings.SplitN(records[i], "\t", 3)
		if len(fields) != 3 {
			break
		}
		path := fields[2]
		if path == "" { // A rename: the old path and the new path follow.
			if i+2 >= len(records) {
				break
			}
			path = records[i+2]
			i += 2
		}
		var count lineCount
		if fields[0] == "-" {
			count = lineCount{added: -1, removed: -1, binary: true}
		} else {
			count.added, _ = strconv.Atoi(fields[0])
			count.removed, _ = strconv.Atoi(fields[1])
		}
		counts[path] = count
	}
	return counts
}

func applyNumstat(files []protocol.ChangedFile, counts map[string]lineCount) {
	for i := range files {
		if count, ok := counts[files[i].Path]; ok {
			files[i].Added, files[i].Removed, files[i].Binary = count.added, count.removed, count.binary
		}
	}
}

// countLines counts the lines of an untracked file. It reads at most budget bytes over
// all calls. It returns -1 for an unknown count.
func countLines(root *os.Root, path string, budget *int) (int, bool) {
	side := readSide(root, path, min(*budget, maxFileSide))
	switch side.State {
	case "binary":
		*budget -= int(side.Size)
		return -1, true
	case "text":
		*budget -= int(side.Size)
		lines := strings.Count(side.Text, "\n")
		if side.Text != "" && !strings.HasSuffix(side.Text, "\n") {
			lines++
		}
		return lines, false
	}
	return -1, false
}

func (s *Server) workspaceFiles(ctx context.Context, id string) (protocol.WorkspaceFiles, error) {
	result := protocol.WorkspaceFiles{Paths: []string{}}
	session, err := s.store.Session(id)
	if err != nil {
		return result, err
	}
	workspace, err := agent.Canonical(session.Workspace)
	if err != nil {
		return result, fmt.Errorf("the session workspace is not available: %w", err)
	}
	out, more, err := gitRead(ctx, workspace, maxGitList, "ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z")
	if isNotRepository(err) {
		result.Reason = notRepository
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.Repository = true
	for _, path := range splitZ(out) {
		result.Paths = append(result.Paths, strings.TrimSuffix(path, "/"))
	}
	slices.Sort(result.Paths)
	result.Truncated = more
	if len(result.Paths) > maxWorkspaceFiles {
		result.Paths, result.Truncated = result.Paths[:maxWorkspaceFiles], true
	}
	return result, nil
}

// workspacePath reports that path is a clean path below the session workspace.
func workspacePath(path string) bool {
	return filepath.IsLocal(path) && path == filepath.Clean(path) && path != "." && !strings.ContainsRune(path, 0)
}

// workspaceFile reads both sides of one file. Without Git, the baseline is empty, the
// old side is missing, and the new side is the current file.
func (s *Server) workspaceFile(ctx context.Context, id string, request *protocol.DiffRequest) (protocol.WorkspaceFile, error) {
	var result protocol.WorkspaceFile
	if request == nil {
		return result, errors.New("missing diff request")
	}
	oldPath := request.OldPath
	if oldPath == "" {
		oldPath = request.Path
	}
	if !workspacePath(request.Path) || !workspacePath(oldPath) {
		return result, errors.New("the file path must name a file in the session workspace")
	}
	result.Path, result.Old = request.Path, protocol.FileSide{State: "missing"}
	target, err := s.resolveDiff(ctx, id, request)
	switch {
	case err == nil:
		result.Baseline = target.baseline
		if result.Old, err = baselineSide(ctx, target, oldPath); err != nil {
			return result, err
		}
	case withoutGit(err) && target.workspace != "":
	default:
		return result, err
	}
	root, err := os.OpenRoot(target.workspace)
	if err != nil {
		return result, err
	}
	defer root.Close()
	result.New = readSide(root, request.Path, maxFileSide)
	return result, nil
}

// workspaceFolders lists the entries of folders in the session workspace. An empty
// path names the workspace folder. The lists work without Git. A path that is not a
// folder now has Missing, so that one removed folder does not fail a refresh.
func (s *Server) workspaceFolders(ctx context.Context, id string, request *protocol.DiffRequest) (protocol.WorkspaceFolders, error) {
	result := protocol.WorkspaceFolders{Folders: []protocol.WorkspaceFolder{}}
	if request == nil || len(request.Folders) == 0 {
		return result, errors.New("missing folder paths")
	}
	if len(request.Folders) > maxFolderRequest {
		return result, fmt.Errorf("one request lists at most %d folders", maxFolderRequest)
	}
	for _, path := range request.Folders {
		if path != "" && !workspacePath(path) {
			return result, errors.New("the folder path must name a folder in the session workspace")
		}
	}
	session, err := s.store.Session(id)
	if err != nil {
		return result, err
	}
	workspace, err := agent.Canonical(session.Workspace)
	if err != nil {
		return result, fmt.Errorf("the session workspace is not available: %w", err)
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return result, err
	}
	defer root.Close()
	budget := maxFolderEntries
	for _, path := range request.Folders {
		if err = ctx.Err(); err != nil {
			return result, err
		}
		folder := readFolder(root, path, budget)
		budget -= len(folder.Entries)
		// Git finds the repository from the folder. Thus a submodule and a nested
		// repository use their own ignore rules.
		ignored, err := ignoredNames(ctx, filepath.Join(workspace, path), folder.Entries)
		if err != nil && result.IgnoreError == "" {
			result.IgnoreError = err.Error()
		}
		for i := range folder.Entries {
			folder.Entries[i].Ignored = ignored[folder.Entries[i].Name]
		}
		result.Folders = append(result.Folders, folder)
	}
	return result, nil
}

// readFolder lists one folder through os.Root, which refuses paths that leave the
// workspace. A symlink in the path is not followed. The list omits `.git`. It puts
// folders first and sorts names without case. Truncated reports that the folder has
// more than limit entries. The kept entries are then an arbitrary part of the folder.
func readFolder(root *os.Root, path string, limit int) protocol.WorkspaceFolder {
	folder := protocol.WorkspaceFolder{Path: path, Entries: []protocol.FolderEntry{}}
	name := "."
	if path != "" {
		name = path
		parts := strings.Split(path, string(filepath.Separator))
		for i := range parts {
			info, err := root.Lstat(filepath.Join(parts[:i+1]...))
			if err != nil || !info.IsDir() {
				folder.Missing = true
				return folder
			}
		}
	}
	dir, err := root.Open(name)
	if err != nil {
		folder.Missing = true
		return folder
	}
	defer dir.Close()
	// Read one more entry than the limit to detect a longer folder. `.git` takes one
	// place in the read.
	entries, err := dir.ReadDir(limit + 2)
	if err != nil && !errors.Is(err, io.EOF) {
		folder.Missing = true
		return folder
	}
	for _, entry := range entries {
		if entry.Name() == ".git" {
			continue
		}
		if len(folder.Entries) == limit {
			folder.Truncated = true
			break
		}
		kind := "other"
		switch mode := entry.Type(); {
		case mode.IsDir():
			kind = "folder"
		case mode.IsRegular():
			kind = "file"
		case mode&fs.ModeSymlink != 0:
			kind = "symlink"
		}
		folder.Entries = append(folder.Entries, protocol.FolderEntry{Name: entry.Name(), Kind: kind})
	}
	slices.SortFunc(folder.Entries, func(a, b protocol.FolderEntry) int {
		if a.Kind != b.Kind && (a.Kind == "folder" || b.Kind == "folder") {
			if a.Kind == "folder" {
				return -1
			}
			return 1
		}
		if order := strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)); order != 0 {
			return order
		}
		return strings.Compare(a.Name, b.Name)
	})
	return folder
}

// ignoredNames returns the entries of dir that Git ignores. It returns no names without
// Git. `./` keeps Git from reading a name that starts with a colon as pathspec magic.
func ignoredNames(ctx context.Context, dir string, entries []protocol.FolderEntry) (map[string]bool, error) {
	if len(entries) == 0 {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, gitReadTimeout)
	defer cancel()
	var input strings.Builder
	for _, entry := range entries {
		input.WriteString("./" + entry.Name + "\x00")
	}
	cmd := gitCommand(ctx, dir, "check-ignore", "-z", "--stdin")
	cmd.Stdin = strings.NewReader(input.String())
	var stderr bytes.Buffer
	cmd.Stderr = &limitedWriter{buffer: &stderr, limit: 4096}
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("git check-ignore took more than %s", gitReadTimeout)
		}
		failure := &gitError{command: "check-ignore", err: err, stderr: strings.TrimSpace(stderr.String())}
		// Git exits with status 1 when it ignores none of the names.
		if isQuietMiss(failure) || withoutGit(failure) {
			return nil, nil
		}
		return nil, failure
	}
	ignored := map[string]bool{}
	for _, name := range splitZ(out) {
		ignored[strings.TrimPrefix(name, "./")] = true
	}
	return ignored, nil
}

// baselineSide reads one path from the baseline commit. The path is relative to the
// workspace, which can be a repository subfolder.
func baselineSide(ctx context.Context, target diffTarget, path string) (protocol.FileSide, error) {
	missing := protocol.FileSide{State: "missing"}
	out, _, err := gitRead(ctx, target.workspace, 64<<10, "ls-tree", "-l", "-z", target.baseline.Commit, "--", path)
	if err != nil {
		return missing, err
	}
	entry, _, found := strings.Cut(string(out), "\x00")
	if !found {
		return missing, nil
	}
	meta, name, _ := strings.Cut(entry, "\t")
	if name != filepath.ToSlash(path) {
		return missing, nil // Git listed the contents of a folder.
	}
	fields := strings.Fields(meta) // mode, type, object, size
	if len(fields) != 4 {
		return missing, fmt.Errorf("unexpected git ls-tree output for %q", path)
	}
	if fields[1] != "blob" {
		return protocol.FileSide{State: "other"}, nil
	}
	side := protocol.FileSide{Symlink: fields[0] == "120000"}
	side.Size, _ = strconv.ParseInt(fields[3], 10, 64)
	if side.Size > maxFileSide {
		side.State = "tooLarge"
		return side, nil
	}
	data, _, err := gitRead(ctx, target.workspace, maxFileSide, "cat-file", "blob", fields[2])
	if err != nil {
		return missing, err
	}
	setText(&side, data)
	return side, nil
}

// readSide reads one path of the current workspace. os.Root refuses paths and
// symlinks that leave the workspace. A symlink holds its target text and is not
// followed.
func readSide(root *os.Root, path string, limit int) protocol.FileSide {
	info, err := root.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return protocol.FileSide{State: "missing"}
		}
		return protocol.FileSide{State: "other"}
	}
	side := protocol.FileSide{Size: info.Size()}
	if info.Mode()&fs.ModeSymlink != 0 {
		target, err := root.Readlink(path)
		if err != nil {
			return protocol.FileSide{State: "other"}
		}
		side.Symlink = true
		side.Size = int64(len(target))
		setText(&side, []byte(target))
		return side
	}
	if !info.Mode().IsRegular() {
		side.State = "other"
		return side
	}
	if side.Size > int64(limit) {
		side.State = "tooLarge"
		return side
	}
	// O_NONBLOCK keeps a special file that replaced the regular file from blocking.
	file, err := root.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return protocol.FileSide{State: "other"}
	}
	defer file.Close()
	if info, err = file.Stat(); err != nil || !info.Mode().IsRegular() {
		return protocol.FileSide{State: "other"}
	}
	data, err := io.ReadAll(io.LimitReader(file, int64(limit)+1))
	if err != nil {
		return protocol.FileSide{State: "other"}
	}
	side.Size = int64(len(data))
	if len(data) > limit {
		side.State = "tooLarge"
		return side
	}
	setText(&side, data)
	return side
}

// setText stores text, or marks the side as binary. Like Git, it treats a NUL byte in
// the first 8000 bytes as binary. Invalid UTF-8 is binary too.
func setText(side *protocol.FileSide, data []byte) {
	if bytes.IndexByte(data[:min(len(data), 8000)], 0) >= 0 || !utf8.Valid(data) {
		side.State = "binary"
		return
	}
	side.State, side.Text = "text", string(data)
}
