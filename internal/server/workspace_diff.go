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

	"bbflow/internal/protocol"
	agent "bbflow/internal/runtime"
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
// selected repository. The server has no user at a terminal, so Git and SSH must not
// prompt. GIT_ASKPASS overrides core.askPass and SSH_ASKPASS. A failed askpass program
// with no terminal prompt stops the command. Credential helpers and SSH agents still
// work.
func gitEnv() []string {
	var env []string
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "GIT_") && !strings.HasPrefix(item, "SSH_ASKPASS") {
			env = append(env, item)
		}
	}
	return append(env, "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=false", "SSH_ASKPASS_REQUIRE=never")
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
	workspace   string
	base        *protocol.Base // The start of the "base" baseline. Nil without a base.
	baseline    protocol.Baseline
	commits     []listedCommit // The commits since the base, newest first.
	moreCommits bool
}

// listedCommit is a commit of the commit list and its first parent. The parent of a
// root commit is empty.
type listedCommit struct {
	protocol.Commit
	parent string
}

var errNotRepository = errors.New("not a Git repository")

const notRepository = "Not a Git repository."

// resolveDiff finds the session workspace, the base, the commit list, and the baseline
// of the request. It never accepts a workspace path from the client.
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
	head, err := revision(ctx, target.workspace, "HEAD")
	if err != nil {
		return target, err
	}
	// A ready managed worktree uses its recorded commit. Other sessions use the merge
	// base with the default branch.
	w := session.Worktree
	var baseErr error
	switch {
	case w != nil && w.State == "ready" && w.Commit != "" && within(w.Path, target.workspace):
		commit, err := revision(ctx, target.workspace, w.Commit)
		if err == nil && commit == "" {
			err = errors.New("Git has no such commit")
		}
		if err != nil {
			baseErr = fmt.Errorf("the worktree base commit is not available: %w", err)
		} else {
			target.base = &protocol.Base{Commit: commit}
		}
	case head != "":
		if target.base, err = branchBase(ctx, target.workspace, head); err != nil {
			return target, err
		}
	}
	if head != "" {
		base := ""
		if target.base != nil {
			base = target.base.Commit
		}
		if target.commits, target.moreCommits, err = listCommits(ctx, target.workspace, head, base); err != nil {
			return target, err
		}
	}
	var kind, from, to string
	if request != nil {
		kind, from, to = request.Baseline, request.From, request.To
	}
	if to != "" && kind != "commit" {
		return target, errors.New("only the commit baseline accepts a to commit")
	}
	if kind == "commit" {
		ok, err := target.commitBaseline(ctx, from, to)
		if err != nil || ok {
			return target, err
		}
		// A commit is not in the list now, for example after a rebase. Use the default
		// baseline. The reply names the baseline that the diff uses.
		kind = ""
	}
	switch {
	case kind == "base", kind == "" && (target.base != nil || baseErr != nil):
		if baseErr != nil {
			return target, baseErr
		}
		if target.base == nil {
			return target, errors.New("this session has no base commit")
		}
		label := "Since worktree base"
		if target.base.Branch != "" {
			label = "Since the merge base with " + target.base.Branch
		}
		target.baseline = protocol.Baseline{Kind: "base", Label: label, Commit: target.base.Commit}
	case kind == "" || kind == "head":
		commit := head
		if commit == "" {
			// Compare with the empty tree in a repository without commits.
			if commit, err = emptyTree(ctx, target.workspace); err != nil {
				return target, err
			}
		}
		target.baseline = protocol.Baseline{Kind: "head", Label: "Uncommitted changes", Commit: commit}
	default:
		return target, errors.New("unknown diff baseline")
	}
	return target, nil
}

// commitBaseline sets the baseline of the commits from the from commit to the to
// commit. An empty to ends the diff at the current files. It reports false when a
// commit is not in the list now.
func (target *diffTarget) commitBaseline(ctx context.Context, from, to string) (bool, error) {
	index := func(id string) int {
		return slices.IndexFunc(target.commits, func(c listedCommit) bool { return c.ID == id })
	}
	oldest, newest := index(from), -1
	if to != "" {
		newest = index(to)
	}
	if oldest < 0 || (to != "" && newest < 0) {
		return false, nil
	}
	// The list is newest first.
	if newest > oldest {
		return false, errors.New("the to commit is older than the from commit")
	}
	parent := target.commits[oldest].parent
	if parent == "" {
		var err error
		if parent, err = emptyTree(ctx, target.workspace); err != nil {
			return false, err
		}
	}
	short := func(id string) string { return id[:min(7, len(id))] }
	label := "Changes from commit " + short(from)
	switch {
	case from == to:
		label = "Commit " + short(from)
	case to != "":
		label = "Commits " + short(from) + " to " + short(to)
	}
	target.baseline = protocol.Baseline{Kind: "commit", Label: label, Commit: parent, From: from, To: to}
	return true, nil
}

// branchBase finds the base of a session without a managed worktree. It is the merge
// base of HEAD and the default branch: the target of origin/HEAD, or else main. It is
// nil without such a branch, without a merge base, and when HEAD is the merge base.
// Then no commit is after the base, for example on the default branch itself.
func branchBase(ctx context.Context, dir, head string) (*protocol.Base, error) {
	out, _, err := gitRead(ctx, dir, 4096, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
	if err != nil && !isQuietMiss(err) {
		return nil, err
	}
	var names []string
	if name := strings.TrimSpace(string(out)); name != "" {
		names = append(names, name)
	}
	for _, name := range append(names, "refs/heads/main") {
		tip, err := revision(ctx, dir, name)
		if err != nil {
			return nil, err
		}
		if tip == "" {
			continue
		}
		out, _, err := gitRead(ctx, dir, 4096, "merge-base", head, tip)
		if isQuietMiss(err) {
			return nil, nil // The branches have no common commit.
		}
		if err != nil {
			return nil, err
		}
		commit := strings.TrimSpace(string(out))
		if commit == head {
			return nil, nil
		}
		branch := strings.TrimPrefix(strings.TrimPrefix(name, "refs/remotes/"), "refs/heads/")
		return &protocol.Base{Commit: commit, Branch: branch}, nil
	}
	return nil, nil
}

// maxCommits limits the commit list. Tests make it smaller.
var maxCommits = 30

// maxCommitList limits the bytes of the Git output of the commit list. Tests make it
// smaller.
var maxCommitList = 1 << 20

// listCommits lists the commits since the base, newest first. It follows the first
// parent from HEAD and stops at the base. Without a base, it lists the latest commits
// of HEAD. Each commit counts the files that it changes in the workspace folder. More
// reports that older commits are not in the list.
func listCommits(ctx context.Context, dir, head, base string) (commits []listedCommit, more bool, err error) {
	// One more commit than the limit detects more commits. Each record starts with a
	// record separator, so that the line with the file count stays with its commit.
	args := []string{"log", "--first-parent", "--no-show-signature", "--no-color", "--relative", "--shortstat",
		"--format=%x1e%H %P%x09%s", "-n", strconv.Itoa(maxCommits + 1), head}
	if base != "" {
		args = append(args, "^"+base)
	}
	out, truncated, err := gitRead(ctx, dir, maxCommitList, append(args, "--")...)
	if err != nil {
		return nil, false, err
	}
	commits = []listedCommit{}
	records := strings.Split(string(out), "\x1e")[1:]
	if truncated && len(records) > 0 {
		records = records[:len(records)-1] // A partial record.
	}
	more = truncated
	for _, record := range records {
		line, stat, _ := strings.Cut(record, "\n")
		ids, subject, found := strings.Cut(line, "\t")
		fields := strings.Fields(ids)
		if !found || len(fields) == 0 {
			continue
		}
		commit := listedCommit{Commit: protocol.Commit{ID: fields[0], Subject: subject}}
		// The file count starts the stat line, as in " 2 files changed, 3 insertions(+)".
		// A commit without changes in the folder has no stat line.
		if count, _, ok := strings.Cut(strings.TrimSpace(stat), " "); ok {
			commit.Files, _ = strconv.Atoi(count)
		}
		if len(fields) > 1 {
			commit.parent = fields[1]
		}
		if commit.parent == "" {
			// Git shows no parent for the last commit of a shallow clone. Only a true
			// root commit compares with the empty tree.
			root, err := rootCommit(ctx, dir, commit.ID)
			if err != nil {
				return nil, false, err
			}
			if !root {
				more = true
				continue
			}
		}
		if len(commits) == maxCommits {
			more = true
			break
		}
		commits = append(commits, commit)
	}
	return commits, more, nil
}

// rootCommit reports that a commit object has no parent. It reads the object itself,
// because Git hides the parents of a shallow clone boundary.
func rootCommit(ctx context.Context, dir, id string) (bool, error) {
	out, _, err := gitRead(ctx, dir, 64<<10, "cat-file", "commit", id)
	if err != nil {
		return false, err
	}
	header, _, _ := strings.Cut(string(out), "\n\n")
	for _, line := range strings.Split(header, "\n") {
		if strings.HasPrefix(line, "parent ") {
			return false, nil
		}
	}
	return true, nil
}

// emptyTree returns the ID of the empty tree. A diff with it shows every file as added.
func emptyTree(ctx context.Context, dir string) (string, error) {
	out, _, err := gitRead(ctx, dir, 4096, "hash-object", "-t", "tree", os.DevNull)
	return strings.TrimSpace(string(out)), err
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
	result := protocol.WorkspaceChanges{Commits: []protocol.Commit{}, Files: []protocol.ChangedFile{}}
	target, err := s.resolveDiff(ctx, id, request)
	if errors.Is(err, errNotRepository) {
		result.Reason = notRepository
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.Repository, result.Base, result.Baseline = true, target.base, target.baseline
	for _, commit := range target.commits {
		result.Commits = append(result.Commits, commit.Commit)
	}
	result.MoreCommits = target.moreCommits
	// --relative limits a repository subfolder session to its own folder. Without a to
	// commit, Git compares the baseline commit with the current files.
	sides := []string{target.baseline.Commit}
	if target.baseline.To != "" {
		sides = append(sides, target.baseline.To)
	}
	diff := []string{"diff", "--no-ext-diff", "--no-textconv", "--no-color", "--relative", "-M", "-z"}
	names, moreNames, err := gitRead(ctx, target.workspace, maxGitList, slices.Concat(diff, []string{"--name-status"}, sides, []string{"--"})...)
	if err != nil {
		return result, err
	}
	counts, moreCounts, err := gitRead(ctx, target.workspace, maxGitList, slices.Concat(diff, []string{"--numstat"}, sides, []string{"--"})...)
	if err != nil {
		return result, err
	}
	result.Files = parseNameStatus(names)
	applyNumstat(result.Files, parseNumstat(counts))
	result.Truncated = moreNames || moreCounts
	if len(result.Files) > maxDiffFiles {
		result.Files, result.Truncated = result.Files[:maxDiffFiles], true
	}
	// Untracked files are part of the current files only.
	if target.baseline.To != "" {
		return result, nil
	}
	untracked, moreUntracked, err := gitRead(ctx, target.workspace, maxGitList, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return result, err
	}
	result.Truncated = result.Truncated || moreUntracked
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
		if result.Old, err = treeSide(ctx, target.workspace, target.baseline.Commit, oldPath); err != nil {
			return result, err
		}
		if target.baseline.To != "" {
			result.New, err = treeSide(ctx, target.workspace, target.baseline.To, request.Path)
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

// treeSide reads one path from the tree of a commit. The path is relative to the
// workspace, which can be a repository subfolder.
func treeSide(ctx context.Context, workspace, commit, path string) (protocol.FileSide, error) {
	missing := protocol.FileSide{State: "missing"}
	out, _, err := gitRead(ctx, workspace, 64<<10, "ls-tree", "-l", "-z", commit, "--", path)
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
	data, _, err := gitRead(ctx, workspace, maxFileSide, "cat-file", "blob", fields[2])
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
