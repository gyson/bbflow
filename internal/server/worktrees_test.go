package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

// cloneFixture returns an upstream repository and a clone of it. The origin of the
// clone is the upstream.
func cloneFixture(t *testing.T) (string, string) {
	t.Helper()
	upstream := fixtureRepository(t)
	clone := filepath.Join(t.TempDir(), "clone")
	if _, err := git(context.Background(), upstream, "clone", "--quiet", "--", upstream, clone); err != nil {
		t.Fatal(err)
	}
	return upstream, clone
}

func gitAll(t *testing.T, dir string, commands ...[]string) {
	t.Helper()
	for _, args := range commands {
		if _, err := git(context.Background(), dir, args...); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRemoteBaseUsesTheConfiguredFetchSource(t *testing.T) {
	ctx := context.Background()
	upstream, clone := cloneFixture(t)
	gitAll(t, upstream, []string{"branch", "feature/new"})
	gitAll(t, clone,
		[]string{"remote", "add", "team/fork", upstream},
		[]string{"remote", "add", "mirror", upstream},
		[]string{"tag", "v1"},
		[]string{"branch", "local"},
		// A tracking ref can have another name than its remote branch.
		[]string{"config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/stable"},
		[]string{"config", "--add", "remote.origin.fetch", "^refs/heads/private"},
		[]string{"update-ref", "refs/remotes/origin/private", "HEAD"},
		[]string{"update-ref", "refs/remotes/manual/main", "HEAD"},
		// Two remotes map different sources to the same tracking ref.
		[]string{"config", "--add", "remote.origin.fetch", "+refs/heads/x:refs/remotes/origin/dup"},
		[]string{"config", "--add", "remote.mirror.fetch", "+refs/heads/y:refs/remotes/origin/dup"},
	)
	commit, err := git(ctx, clone, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	resolve := func(base string) string {
		tracking, exists := remoteBase(ctx, clone, base)
		if tracking == "" {
			return ""
		}
		ref, ok := fetchSource(ctx, clone, tracking)
		switch {
		case ok:
			return ref.remote + " " + ref.source + " " + ref.tracking
		case exists:
			return "unmapped " + tracking
		}
		return ""
	}
	for base, want := range map[string]string{
		"origin/main":              "origin refs/heads/main refs/remotes/origin/main",
		"remotes/origin/main":      "origin refs/heads/main refs/remotes/origin/main",
		"refs/remotes/origin/main": "origin refs/heads/main refs/remotes/origin/main",
		"origin/HEAD":              "origin refs/heads/main refs/remotes/origin/main",
		"origin/stable":            "origin refs/heads/main refs/remotes/origin/stable",
		"origin/feature/new":       "origin refs/heads/feature/new refs/remotes/origin/feature/new", // Not fetched.
		"team/fork/main":           "team/fork refs/heads/main refs/remotes/team/fork/main",         // A remote name with a slash.
		"origin/private":           "unmapped refs/remotes/origin/private",
		"manual/main":              "unmapped refs/remotes/manual/main",
		"origin/dup":               "",
		"HEAD":                     "",
		"main":                     "",
		"local":                    "",
		"v1":                       "",
		commit:                     "",
		"origin/main~1":            "",
		"origin/bad:ref":           "",
		"--all":                    "",
		"other/main":               "",
	} {
		if got := resolve(base); got != want {
			t.Errorf("%q resolves to %q, want %q", base, got, want)
		}
	}
}

func TestRemoteBaseIsFetchedBeforeWorktreeCreation(t *testing.T) {
	s, _ := composerServer(t)
	t.Setenv("SHELL", "/bin/sh")
	ctx := context.Background()
	upstream, clone := cloneFixture(t)
	// A configured refspec that updates a local branch must not take effect.
	gitAll(t, clone,
		[]string{"branch", "local-copy"},
		[]string{"config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/heads/local-copy"},
		[]string{"config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/stable"},
	)
	localCopy, err := git(ctx, clone, "rev-parse", "local-copy")
	if err != nil {
		t.Fatal(err)
	}
	// The clone now has a stale origin/main and no origin/feature.
	latest := commitFile(t, upstream, "latest.txt", "latest")
	gitAll(t, upstream, []string{"switch", "--quiet", "-c", "stable"})
	commitFile(t, upstream, "stable.txt", "stable")
	gitAll(t, upstream, []string{"switch", "--quiet", "-c", "feature"})
	feature := commitFile(t, upstream, "feature.txt", "feature")
	project, err := s.addProject("Clone", clone)
	if err != nil {
		t.Fatal(err)
	}
	draft := func(base string) (string, int64) {
		t.Helper()
		session, err := s.prepareProject(ctx, project.ID, "")
		if err != nil {
			t.Fatal(err)
		}
		p := *session.Preparation
		p.Worktree, p.Base = true, base
		if session, err = s.store.SavePreparation(session.ID, session.Title, p); err != nil {
			t.Fatal(err)
		}
		return session.ID, session.Preparation.Revision
	}
	launch := func(base string, between func()) (string, string) {
		t.Helper()
		id, revision := draft(base)
		problem, err := s.refreshPreparedBase(ctx, id, revision)
		if err != nil {
			t.Fatal(err)
		}
		if between != nil {
			between()
		}
		launched, _, err := s.launchPrepared(ctx, id, revision, protocol.Size{Rows: 24, Cols: 80})
		if err != nil {
			t.Fatal(err)
		}
		if launched.Worktree.Base != base {
			t.Fatalf("recorded base %q, want %q", launched.Worktree.Base, base)
		}
		return launched.Worktree.Commit, baseNotice(problem, launched.Worktree)
	}
	if commit, notice := launch("origin/main", nil); commit != latest || notice != "" {
		t.Fatalf("origin/main: commit %s, notice %q, want %s", commit, notice, latest)
	}
	if commit, err := git(ctx, clone, "rev-parse", "local-copy"); err != nil || commit != localCopy {
		t.Fatalf("fetch moved local-copy to %s: %v", commit, err)
	}
	// origin/stable copies the remote main, not the remote stable.
	if commit, notice := launch("origin/stable", nil); commit != latest || notice != "" {
		t.Fatalf("origin/stable: commit %s, notice %q, want %s", commit, notice, latest)
	}
	if commit, notice := launch("origin/feature", nil); commit != feature || notice != "" {
		t.Fatalf("origin/feature: commit %s, notice %q, want %s", commit, notice, feature)
	}
	// A local base never fetches, so it keeps the commit of the clone.
	if commit, notice := launch("main", nil); commit != localCopy || notice != "" {
		t.Fatalf("main: commit %s, notice %q, want %s", commit, notice, localCopy)
	}

	// An unreachable remote falls back to the local copy and reports it.
	gitAll(t, clone, []string{"remote", "set-url", "origin", filepath.Join(t.TempDir(), "missing")})
	commitFile(t, upstream, "unseen.txt", "unseen")
	commit, notice := launch("origin/feature", nil)
	if commit != feature || !strings.HasPrefix(notice, "Could not fetch origin/feature (git fetch: ") || !strings.HasSuffix(notice, "). The worktree uses the local commit "+feature[:12]+".") {
		t.Fatalf("fallback: commit %s, notice %q", commit, notice)
	}
	// The notice names the recorded commit, also when the ref moves before creation.
	commit, notice = launch("origin/feature", func() {
		gitAll(t, clone, []string{"update-ref", "refs/remotes/origin/feature", latest})
	})
	if commit != latest || !strings.HasSuffix(notice, "The worktree uses the local commit "+latest[:12]+".") {
		t.Fatalf("moved ref: commit %s, notice %q", commit, notice)
	}
	// Without a local copy, the fetch error stops the launch before any change.
	id, revision := draft("origin/absent")
	if _, err = s.refreshPreparedBase(ctx, id, revision); err == nil || !strings.Contains(err.Error(), "could not fetch origin/absent") {
		t.Fatal("missing remote branch:", err)
	}
	if current, err := s.store.Session(id); err != nil || current.Preparation.State != "draft" || current.Worktree != nil {
		t.Fatal(current, err)
	}
	// A tracking ref that no refspec maps is used without a fetch, with a notice.
	gitAll(t, clone, []string{"update-ref", "refs/remotes/manual/main", latest})
	if commit, notice := launch("manual/main", nil); commit != latest || notice != "No fetch setting of a remote maps to refs/remotes/manual/main, so bbflow did not fetch manual/main. The worktree uses the local commit "+latest[:12]+"." {
		t.Fatalf("unmapped: commit %s, notice %q", commit, notice)
	}
}

func TestUnmappedRemoteBranchFailsEarly(t *testing.T) {
	ctx := context.Background()
	upstream, clone := cloneFixture(t)
	gitAll(t, upstream, []string{"branch", "new-feature"})
	// A single-branch clone maps only main.
	gitAll(t, clone, []string{"remote", "set-branches", "origin", "main"})
	_, err := refreshBase(ctx, clone, "origin/new-feature")
	if err == nil || err.Error() != "cannot fetch origin/new-feature: the fetch refspecs of the repository do not map one branch of remote origin to refs/remotes/origin/new-feature" {
		t.Fatal(err)
	}
	// An expression that does not resolve is not a remote branch. Worktree creation
	// reports it.
	for _, base := range []string{"origin/main~1", "origin/main^{tree}", "origin/a..b"} {
		if problem, err := refreshBase(ctx, clone, base); problem != "" || err != nil {
			t.Fatalf("%s: %q %v", base, problem, err)
		}
	}
	// After the user adds the refspec, the same base fetches.
	gitAll(t, clone, []string{"remote", "set-branches", "--add", "origin", "new-feature"})
	if problem, err := refreshBase(ctx, clone, "origin/new-feature"); problem != "" || err != nil {
		t.Fatal(problem, err)
	}
	if _, err = git(ctx, clone, "rev-parse", "--verify", "refs/remotes/origin/new-feature"); err != nil {
		t.Fatal(err)
	}
	// A name that is not a remote branch is left to worktree creation.
	if problem, err := refreshBase(ctx, clone, "mian"); problem != "" || err != nil {
		t.Fatal(problem, err)
	}
}

func TestBaseFetchStopsTransportHelpersAtTheDeadline(t *testing.T) {
	ctx := context.Background()
	_, clone := cloneFixture(t)
	previous := fetchTimeout
	fetchTimeout = time.Second
	t.Cleanup(func() { fetchTimeout = previous })
	// The helper keeps the output pipe of Git open after Git is killed.
	gitAll(t, clone, []string{"config", "remote.origin.uploadpack", "sleep 30; git-upload-pack"})
	started := time.Now()
	problem, err := refreshBase(ctx, clone, "origin/main")
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("fetch returned after %s", elapsed)
	}
	if err != nil || !strings.HasPrefix(problem, "Could not fetch origin/main") {
		t.Fatalf("problem %q, error %v", problem, err)
	}
}

func TestGitShowsNoCredentialPrompt(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("WWW-Authenticate", `Basic realm="fixture"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(remote.Close)
	repo := fixtureRepository(t)
	marker := filepath.Join(t.TempDir(), "asked")
	askpass := filepath.Join(t.TempDir(), "askpass")
	if err := os.WriteFile(askpass, []byte("#!/bin/sh\ntouch '"+marker+"'\necho secret\n"), 0700); err != nil {
		t.Fatal(err)
	}
	gitAll(t, repo, []string{"config", "credential.helper", ""}, []string{"config", "core.askPass", askpass})
	t.Setenv("SSH_ASKPASS", askpass)
	t.Setenv("SSH_ASKPASS_REQUIRE", "force")
	if _, err := git(context.Background(), repo, "fetch", remote.URL+"/repository.git"); err == nil {
		t.Fatal("fetch without credentials succeeded")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("Git ran the askpass program", err)
	}
}

func TestStartingViewGetsRunningStatuses(t *testing.T) {
	previous := startKeepalive
	startKeepalive = 20 * time.Millisecond
	t.Cleanup(func() { startKeepalive = previous })
	conn, peer := attachmentPair(t)
	stop := keepStarting(conn)
	var message protocol.Message
	peer.SetReadDeadline(time.Now().Add(5 * time.Second))
	for range 2 {
		if err := peer.ReadJSON(&message); err != nil || message.Type != "status" || message.Status != "running" {
			t.Fatal(message, err)
		}
	}
	stop()
	// After stop returns, the next message is the reply of the request.
	conn.Send(protocol.Message{Type: "session", Session: "one"})
	for {
		if err := peer.ReadJSON(&message); err != nil {
			t.Fatal(err)
		}
		if message.Type != "status" {
			break
		}
	}
	if message.Type != "session" {
		t.Fatal(message)
	}
}
