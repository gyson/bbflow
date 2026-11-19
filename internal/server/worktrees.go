package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"bbflow/internal/history"
	agent "bbflow/internal/runtime"
)

type RepositoryInfo struct {
	Available bool   `json:"available"`
	Root      string `json:"root"`
	Head      string `json:"head"`
	Branch    string `json:"branch"`
	Reason    string `json:"reason"`
}

func git(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = gitEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

func inspectRepository(ctx context.Context, workspace string) RepositoryInfo {
	var result RepositoryInfo
	path, err := expandWorkspace(workspace)
	if err == nil {
		path, err = agent.Canonical(path)
	}
	if err != nil {
		result.Reason = err.Error()
		return result
	}
	root, err := git(ctx, path, "rev-parse", "--show-toplevel")
	if err != nil {
		result.Reason = "Worktrees require Git and an existing repository."
		return result
	}
	root, err = agent.Canonical(root)
	if err != nil {
		result.Reason = err.Error()
		return result
	}
	result.Root = root
	result.Head, err = git(ctx, path, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil {
		result.Reason = "Commit at least once before creating a worktree."
		return result
	}
	// Linked worktrees with submodules require additional lifecycle handling.
	files, err := git(ctx, root, "ls-files", "--stage")
	if err != nil {
		result.Reason = err.Error()
		return result
	}
	for _, line := range strings.Split(files, "\n") {
		if strings.HasPrefix(line, "160000 ") {
			result.Reason = "Managed worktrees with submodules are not supported yet."
			return result
		}
	}
	result.Branch, _ = git(ctx, path, "symbolic-ref", "--short", "HEAD")
	result.Available = true
	return result
}

func within(parent, path string) bool {
	relative, err := filepath.Rel(parent, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

// fetchTimeout limits the base fetch. A remote that does not answer must not hold the
// launch for the full Git timeout.
const fetchTimeout = 15 * time.Second

// remoteBranch returns the remote and branch when base names a remote-tracking branch.
// It also accepts a branch that is on the remote but was not fetched yet. Other bases,
// such as HEAD, local branches, tags, and commit expressions, return empty strings.
func remoteBranch(ctx context.Context, dir, base string) (string, string) {
	list, err := git(ctx, dir, "remote")
	if err != nil || list == "" {
		return "", ""
	}
	name := strings.TrimPrefix(strings.TrimPrefix(base, "refs/"), "remotes/")
	full, err := git(ctx, dir, "rev-parse", "--verify", "--quiet", "--symbolic-full-name", "--end-of-options", base)
	if err == nil {
		// The base names a ref or a commit. Fetch only for a remote-tracking branch.
		var tracking bool
		if name, tracking = strings.CutPrefix(full, "refs/remotes/"); !tracking {
			return "", ""
		}
	}
	// Branch names can contain slashes. Use the longest remote name that matches.
	remote := ""
	for _, candidate := range strings.Split(list, "\n") {
		if len(candidate) > len(remote) && strings.HasPrefix(name, candidate+"/") {
			remote = candidate
		}
	}
	if remote == "" {
		return "", ""
	}
	branch := strings.TrimPrefix(name, remote+"/")
	// A valid ref name cannot change the meaning of the refspec.
	if branch == "HEAD" || strings.HasPrefix(branch, "-") {
		return "", ""
	}
	if _, err = git(ctx, dir, "check-ref-format", "refs/heads/"+branch); err != nil {
		return "", ""
	}
	return remote, branch
}

// refreshBase fetches a remote-tracking base before worktree creation. Thus the new
// checkout starts from the current remote commit, not from the last fetch. If the fetch
// fails and a local copy exists, refreshBase returns a notice, and the launch uses that
// copy. If no local copy exists, it returns the fetch error. Other bases need no fetch.
func refreshBase(ctx context.Context, workspace, base string) (string, error) {
	dir, err := expandWorkspace(workspace)
	if err != nil {
		// Worktree creation reports workspace and repository problems.
		return "", nil
	}
	remote, branch := remoteBranch(ctx, dir, base)
	if remote == "" {
		return "", nil
	}
	tracking := "refs/remotes/" + remote + "/" + branch
	fetchCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	_, fetchErr := git(fetchCtx, dir, "fetch", "--no-tags", "--no-write-fetch-head", "--", remote, "+refs/heads/"+branch+":"+tracking)
	if fetchErr == nil {
		return "", nil
	}
	commit, err := git(ctx, dir, "rev-parse", "--verify", "--short", "--end-of-options", tracking+"^{commit}")
	if err != nil {
		return "", fmt.Errorf("could not fetch %s: %w", base, fetchErr)
	}
	return fmt.Sprintf("Could not fetch %s. The worktree uses the local copy at commit %s. %v", base, commit, fetchErr), nil
}

func (s *Server) createWorktree(ctx context.Context, id, source, base, branch string) (string, history.Worktree, error) {
	var w history.Worktree
	repo := inspectRepository(ctx, source)
	if !repo.Available {
		return "", w, errors.New(repo.Reason)
	}
	if base == "" {
		base = "HEAD"
	}
	commit, err := git(ctx, repo.Root, "rev-parse", "--verify", "--end-of-options", base+"^{commit}")
	if err != nil {
		return "", w, err
	}
	// Refuse submodules in the selected base as well as the current checkout.
	tree, err := git(ctx, repo.Root, "ls-tree", "-r", commit)
	if err != nil {
		return "", w, err
	}
	for _, line := range strings.Split(tree, "\n") {
		if strings.HasPrefix(line, "160000 ") {
			return "", w, errors.New("the selected base contains unsupported submodules")
		}
	}
	name := time.Now().UTC().Format("20060102-150405") + "-" + history.ID()[:8]
	if branch == "" {
		branch = "bbflow/" + name
	}
	if _, err = git(ctx, repo.Root, "check-ref-format", "--branch", branch); err != nil {
		return "", w, err
	}
	if strings.HasPrefix(branch, "-") || strings.Contains(branch, "@{") {
		return "", w, errors.New("invalid branch name")
	}
	dataDir, err := agent.Canonical(s.info.DataDir)
	if err != nil {
		return "", w, err
	}
	parent := filepath.Join(dataDir, "worktrees")
	if err = os.MkdirAll(parent, 0700); err != nil {
		return "", w, err
	}
	canonical, err := agent.Canonical(parent)
	if err != nil {
		return "", w, err
	}
	if canonical != parent {
		return "", w, errors.New("managed worktree directory must not be a symlink")
	}
	w = history.Worktree{Path: filepath.Join(parent, name), Repository: repo.Root, Base: base, Commit: commit, Branch: branch, State: "creating"}
	if err = s.store.SaveWorktree(id, w); err != nil {
		return "", w, err
	}
	_, err = git(ctx, repo.Root, "worktree", "add", "-b", branch, "--", w.Path, commit)
	if err != nil {
		if _, statErr := os.Lstat(w.Path); os.IsNotExist(statErr) {
			w.State = "removed"
		} else {
			w.State = "failed"
		}
		return "", w, errors.Join(err, s.store.SaveWorktree(id, w))
	}
	w.State = "ready"
	if err = s.store.SaveWorktree(id, w); err != nil {
		return "", w, err
	}
	relative, err := filepath.Rel(repo.Root, source)
	if err != nil {
		return "", w, err
	}
	cwd, err := agent.Canonical(filepath.Join(w.Path, relative))
	if err != nil {
		return "", w, fmt.Errorf("project subfolder is missing in the new checkout; the worktree was preserved: %w", err)
	}
	if !within(w.Path, cwd) {
		return "", w, errors.New("project subfolder points outside the new worktree; the worktree was preserved")
	}
	return cwd, w, nil
}

func (s *Server) removeWorktree(ctx context.Context, id string) error {
	s.launchMu.Lock()
	defer s.launchMu.Unlock()
	session, err := s.store.Session(id)
	if err != nil {
		return err
	}
	w := session.Worktree
	if w == nil || w.State == "removed" {
		return errors.New("no managed worktree to remove")
	}
	dataDir, err := agent.Canonical(s.info.DataDir)
	if err != nil {
		return err
	}
	if filepath.Dir(w.Path) != filepath.Join(dataDir, "worktrees") {
		return errors.New("invalid managed worktree path")
	}
	// Include sessions opened manually in this checkout or any of its subfolders.
	s.mu.Lock()
	ids := make([]string, 0, len(s.sessions)+len(s.sides))
	for sid := range s.sessions {
		ids = append(ids, sid)
	}
	for sid := range s.sides {
		ids = append(ids, sid)
	}
	s.mu.Unlock()
	for _, sid := range ids {
		active, err := s.store.Session(sid)
		if err != nil {
			return err
		}
		if within(w.Path, active.Workspace) || within(active.Workspace, w.Path) {
			return errors.New("stop all sessions and side terminals using this worktree before removing it")
		}
	}
	root, err := git(ctx, w.Path, "rev-parse", "--show-toplevel")
	if err != nil {
		return err
	}
	canonical, err := agent.Canonical(root)
	if err != nil || canonical != w.Path {
		return errors.New("worktree path no longer identifies the managed checkout")
	}
	common, err := git(ctx, w.Path, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return err
	}
	expected, err := git(ctx, w.Repository, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return err
	}
	common, err = agent.Canonical(common)
	if err != nil {
		return err
	}
	expected, err = agent.Canonical(expected)
	if err != nil {
		return err
	}
	if common != expected {
		return errors.New("worktree now belongs to a different repository")
	}
	if _, err = git(ctx, w.Path, "symbolic-ref", "--quiet", "HEAD"); err != nil {
		return errors.New("worktree has a detached HEAD; create a branch to preserve its commits before removal")
	}
	dirty, err := git(ctx, w.Path, "status", "--porcelain", "--untracked-files=all", "--ignored=matching")
	if err != nil {
		return err
	}
	if dirty != "" {
		return errors.New("worktree contains modified, untracked, or ignored files; preserve or remove them before removing the worktree")
	}
	// Do not force removal. Git also protects locks and initialized submodules. Keep
	// branches.
	if _, err = git(ctx, w.Repository, "worktree", "remove", "--", w.Path); err != nil {
		return err
	}
	w.State = "removed"
	return s.store.SaveWorktree(id, *w)
}
