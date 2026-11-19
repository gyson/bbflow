package server

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bbflow/internal/protocol"
)

func commitFile(t *testing.T, repo, name, text string) string {
	t.Helper()
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(repo, name), []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", name}, {"commit", "-m", name}} {
		if _, err := git(ctx, repo, args...); err != nil {
			t.Fatal(err)
		}
	}
	commit, err := git(ctx, repo, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	return commit
}

// cloneFixture returns an upstream repository and a clone whose origin is that upstream.
func cloneFixture(t *testing.T) (string, string) {
	t.Helper()
	upstream := fixtureRepository(t)
	clone := filepath.Join(t.TempDir(), "clone")
	if _, err := git(context.Background(), upstream, "clone", "--quiet", "--", upstream, clone); err != nil {
		t.Fatal(err)
	}
	return upstream, clone
}

func TestRemoteBranchSelectsOnlyRemoteTrackingBases(t *testing.T) {
	ctx := context.Background()
	upstream, clone := cloneFixture(t)
	if _, err := git(ctx, upstream, "branch", "feature/new"); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"remote", "add", "team/fork", upstream}, {"tag", "v1"}, {"branch", "local"}} {
		if _, err := git(ctx, clone, args...); err != nil {
			t.Fatal(err)
		}
	}
	commit, err := git(ctx, clone, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	for base, want := range map[string]string{
		"origin/main":              "origin main",
		"remotes/origin/main":      "origin main",
		"refs/remotes/origin/main": "origin main",
		"origin/HEAD":              "origin main",
		"origin/feature/new":       "origin feature/new", // On the remote only.
		"team/fork/main":           "team/fork main",     // Not fetched yet.
		"HEAD":                     " ",
		"main":                     " ",
		"local":                    " ",
		"v1":                       " ",
		commit:                     " ",
		"origin/main~1":            " ",
		"origin/bad:ref":           " ",
		"origin/-x":                " ",
		"--all":                    " ",
		"other/main":               " ",
	} {
		remote, branch := remoteBranch(ctx, clone, base)
		if got := remote + " " + branch; got != want {
			t.Errorf("remoteBranch(%q) = %q, want %q", base, got, want)
		}
	}
}

func TestRemoteBaseIsFetchedBeforeWorktreeCreation(t *testing.T) {
	s, _ := composerServer(t)
	t.Setenv("SHELL", "/bin/sh")
	ctx := context.Background()
	upstream, clone := cloneFixture(t)
	// The clone now has a stale origin/main and no origin/feature.
	latest := commitFile(t, upstream, "latest.txt", "latest")
	if _, err := git(ctx, upstream, "switch", "--quiet", "-c", "feature"); err != nil {
		t.Fatal(err)
	}
	feature := commitFile(t, upstream, "feature.txt", "feature")
	project, err := s.addProject("Clone", clone)
	if err != nil {
		t.Fatal(err)
	}
	launch := func(base string) (string, string) {
		t.Helper()
		session, err := s.prepareProject(ctx, project.ID)
		if err != nil {
			t.Fatal(err)
		}
		p := *session.Preparation
		p.Worktree, p.Base = true, base
		if session, err = s.store.SavePreparation(session.ID, session.Title, p); err != nil {
			t.Fatal(err)
		}
		notice, err := s.refreshPreparedBase(ctx, session.ID, session.Preparation.Revision)
		if err != nil {
			t.Fatal(err)
		}
		launched, _, err := s.launchPrepared(ctx, session.ID, session.Preparation.Revision, protocol.Size{Rows: 24, Cols: 80})
		if err != nil {
			t.Fatal(err)
		}
		if launched.Worktree.Base != base {
			t.Fatalf("recorded base %q, want %q", launched.Worktree.Base, base)
		}
		return launched.Worktree.Commit, notice
	}
	if commit, notice := launch("origin/main"); commit != latest || notice != "" {
		t.Fatalf("origin/main: commit %s, notice %q, want %s", commit, notice, latest)
	}
	if commit, notice := launch("origin/feature"); commit != feature || notice != "" {
		t.Fatalf("origin/feature: commit %s, notice %q, want %s", commit, notice, feature)
	}
	// A local base never fetches, so it keeps the commit of the clone.
	local, err := git(ctx, clone, "rev-parse", "main")
	if err != nil {
		t.Fatal(err)
	}
	if commit, notice := launch("main"); commit != local || commit == latest || notice != "" {
		t.Fatalf("main: commit %s, notice %q, want %s", commit, notice, local)
	}

	// An unreachable remote falls back to the local copy and reports it.
	if _, err = git(ctx, clone, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "missing")); err != nil {
		t.Fatal(err)
	}
	commitFile(t, upstream, "unseen.txt", "unseen")
	if commit, notice := launch("origin/feature"); commit != feature || !strings.Contains(notice, "Could not fetch origin/feature. The worktree uses the local copy at commit "+feature[:7]) {
		t.Fatalf("fallback: commit %s, notice %q", commit, notice)
	}
	// Without a local copy, the fetch error stops the launch before any change.
	session, err := s.prepareProject(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	p := *session.Preparation
	p.Worktree, p.Base = true, "origin/absent"
	if session, err = s.store.SavePreparation(session.ID, session.Title, p); err != nil {
		t.Fatal(err)
	}
	if _, err = s.refreshPreparedBase(ctx, session.ID, session.Preparation.Revision); err == nil || !strings.Contains(err.Error(), "could not fetch origin/absent") {
		t.Fatal("missing remote branch:", err)
	}
	if current, err := s.store.Session(session.ID); err != nil || current.Preparation.State != "draft" || current.Worktree != nil {
		t.Fatal(current, err)
	}
}
