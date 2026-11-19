package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
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
	// A new session has no terminal for prompts. At the deadline or at server stop,
	// stop the whole group. A transport helper, such as ssh, can keep the output open.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
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
// launch for the full Git timeout. Tests make it shorter.
var fetchTimeout = 15 * time.Second

// remoteRef is a remote-tracking ref and the remote ref that a fetch copies into it.
type remoteRef struct {
	remote, source, tracking string
}

// matchRef matches ref against a refspec side. A side has no star or one star, and the
// star matches any text. It returns the text of the star.
func matchRef(pattern, ref string) (string, bool) {
	prefix, suffix, glob := strings.Cut(pattern, "*")
	if !glob {
		return "", pattern == ref
	}
	if len(ref) < len(prefix)+len(suffix) || !strings.HasPrefix(ref, prefix) || !strings.HasSuffix(ref, suffix) {
		return "", false
	}
	return ref[len(prefix) : len(ref)-len(suffix)], true
}

// fetchSource finds the remote ref that the configured fetch refspecs copy into
// tracking. The most specific destination wins. Equal matches with different sources
// and refs that a negative refspec excludes return false.
func fetchSource(ctx context.Context, dir, tracking string) (remoteRef, bool) {
	var found remoteRef
	// An exact destination is more specific than a pattern with the same prefix.
	best, ambiguous := -1, false
	lines, _ := git(ctx, dir, "config", "--get-regexp", `^remote\..*\.fetch$`)
	excluded := map[string][]string{}
	type mapping struct{ remote, source, destination string }
	var mappings []mapping
	for _, line := range strings.Split(lines, "\n") {
		key, spec, ok := strings.Cut(line, " ")
		remote := strings.TrimSuffix(strings.TrimPrefix(key, "remote."), ".fetch")
		if !ok || remote == "" {
			continue
		}
		if negative, ok := strings.CutPrefix(spec, "^"); ok {
			excluded[remote] = append(excluded[remote], negative)
			continue
		}
		source, destination, ok := strings.Cut(strings.TrimPrefix(spec, "+"), ":")
		if ok && strings.Count(source, "*") == strings.Count(destination, "*") && strings.Count(source, "*") <= 1 {
			mappings = append(mappings, mapping{remote, source, destination})
		}
	}
	for _, m := range mappings {
		star, ok := matchRef(m.destination, tracking)
		if !ok {
			continue
		}
		source := strings.Replace(m.source, "*", star, 1)
		if !strings.HasPrefix(source, "refs/") || slices.ContainsFunc(excluded[m.remote], func(pattern string) bool {
			_, ok := matchRef(pattern, source)
			return ok
		}) {
			continue
		}
		score, _, glob := strings.Cut(m.destination, "*")
		rank := 2 * len(score)
		if !glob {
			rank++
		}
		candidate := remoteRef{m.remote, source, tracking}
		switch {
		case rank > best:
			found, best, ambiguous = candidate, rank, false
		case rank == best && candidate != found:
			ambiguous = true
		}
	}
	if best < 0 || ambiguous {
		return remoteRef{}, false
	}
	// A valid ref name cannot change the meaning of the refspec.
	for _, ref := range []string{found.source, found.tracking} {
		if _, err := git(ctx, dir, "check-ref-format", ref); err != nil {
			return remoteRef{}, false
		}
	}
	return found, true
}

// remoteBase returns the remote-tracking ref that base names. A name that does not
// resolve can name a remote branch that was not fetched yet. Other bases, such as HEAD,
// local branches, tags, and commit expressions, return an empty tracking ref.
func remoteBase(ctx context.Context, dir, base string) (string, bool) {
	full, err := git(ctx, dir, "rev-parse", "--verify", "--quiet", "--symbolic-full-name", "--end-of-options", base)
	if err == nil {
		// The base names a ref or a commit. Only a remote-tracking branch can be fetched.
		if !strings.HasPrefix(full, "refs/remotes/") {
			return "", false
		}
		return full, true
	}
	if strings.HasPrefix(base, "-") {
		return "", false
	}
	return "refs/remotes/" + strings.TrimPrefix(strings.TrimPrefix(base, "refs/"), "remotes/"), false
}

// refreshBase fetches a remote-tracking base before worktree creation. Thus the new
// checkout starts from the current remote commit, not from the last fetch. The fetch
// updates only the selected tracking ref, also when other fetch refspecs match.
//
// The problem is not empty when the launch must use the local tracking ref: the fetch
// failed, or no fetch refspec maps to the ref. If the fetch fails and no local copy
// exists, refreshBase returns the fetch error. Other bases need no fetch.
func refreshBase(ctx context.Context, workspace, base string) (problem string, err error) {
	dir, err := expandWorkspace(workspace)
	if err != nil {
		// Worktree creation reports workspace and repository problems.
		return "", nil
	}
	tracking, exists := remoteBase(ctx, dir, base)
	if tracking == "" {
		return "", nil
	}
	ref, ok := fetchSource(ctx, dir, tracking)
	if !ok {
		if exists {
			return fmt.Sprintf("No fetch setting of a remote maps to %s, so bbflow did not fetch %s.", tracking, base), nil
		}
		// The name is not a remote branch. Worktree creation reports it.
		return "", nil
	}
	fetchCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	_, fetchErr := git(fetchCtx, dir, "fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", "--", ref.remote, "+"+ref.source+":"+ref.tracking)
	if fetchErr == nil {
		return "", nil
	}
	if _, err = git(ctx, dir, "rev-parse", "--verify", "--quiet", "--end-of-options", ref.tracking+"^{commit}"); err != nil {
		return "", fmt.Errorf("could not fetch %s: %w", base, fetchErr)
	}
	return fmt.Sprintf("Could not fetch %s (%v).", base, fetchErr), nil
}

// baseNotice tells the starting view that the worktree did not use a fetched base. It
// names the commit of the worktree record, so that the notice and the record agree.
func baseNotice(problem string, w *history.Worktree) string {
	if problem == "" || w == nil {
		return ""
	}
	return fmt.Sprintf("%s The worktree uses the local commit %.12s.", problem, w.Commit)
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
