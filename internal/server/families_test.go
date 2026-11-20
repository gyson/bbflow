package server

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"bbflow/internal/history"
	"bbflow/internal/protocol"
	agent "bbflow/internal/runtime"
)

func TestSubSessionDraftsAndWorkspaces(t *testing.T) {
	ctx := context.Background()
	s, _ := composerServer(t)
	repo := fixtureRepository(t)
	project, err := s.addProject("Repository", repo)
	if err != nil {
		t.Fatal(err)
	}
	source, err := agent.Canonical(repo)
	if err != nil {
		t.Fatal(err)
	}
	size := protocol.Size{Rows: 24, Cols: 80}
	choose := func(session history.Session, worktree bool) (string, int64) {
		t.Helper()
		p := *session.Preparation
		p.Worktree = worktree
		saved, err := s.store.SavePreparation(session.ID, session.Title, p)
		if err != nil {
			t.Fatal(err)
		}
		return saved.ID, saved.Preparation.Revision
	}
	parent, err := s.prepareProject(ctx, project.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	// A sub-session draft takes the project from its parent.
	early, err := s.prepareProject(ctx, "", parent.ID)
	if err != nil || early.ParentID != parent.ID || early.ProjectID != project.ID || early.Workspace != source || early.Preparation.Base != "HEAD" {
		t.Fatal(early, err)
	}
	// The workspace of a parent draft is not known yet.
	id, revision := choose(early, false)
	if _, _, err = s.launchPrepared(ctx, id, revision, size); err == nil || !strings.Contains(err.Error(), "start the parent session first") {
		t.Fatal(err)
	}
	id, revision = choose(parent, true)
	parent, _, err = s.launchPrepared(ctx, id, revision, size)
	if err == nil {
		// The terminal of the parent starts after the launch.
		_, err = s.store.NewRun(parent.ID)
	}
	if err != nil {
		t.Fatal(err)
	}
	// After the start, a sub-session draft uses the worktree branch of the parent as its
	// base. A draft for a sub-session joins the family of its parent.
	shared, err := s.prepareProject(ctx, "", parent.ID)
	if err != nil || shared.Preparation.Base != parent.Worktree.Branch {
		t.Fatal(shared, err)
	}
	nested, err := s.prepareProject(ctx, "", shared.ID)
	if err != nil || nested.ParentID != parent.ID {
		t.Fatal(nested, err)
	}
	// Without a worktree, the sub-session starts in the workspace of its parent. Its title
	// names the project folder.
	id, revision = choose(shared, false)
	launched, run, err := s.launchPrepared(ctx, id, revision, size)
	if err != nil || launched.Workspace != parent.Workspace || run.Workspace != parent.Workspace || launched.Worktree != nil {
		t.Fatal(launched, err)
	}
	if want := "Shell · " + filepath.Base(source); launched.AutoTitle != want {
		t.Fatalf("title %q, want %q", launched.AutoTitle, want)
	}
	// With a worktree, it gets a new checkout from the branch of the parent.
	id, revision = choose(nested, true)
	launched, _, err = s.launchPrepared(ctx, id, revision, size)
	if err != nil || launched.Worktree == nil || launched.Worktree.Base != parent.Worktree.Branch ||
		launched.Worktree.Commit != parent.Worktree.Commit || launched.Workspace == parent.Workspace {
		t.Fatal(launched, err)
	}
	// The default base follows the current checkout of the parent worktree: its branch,
	// or its commit when the checkout is detached.
	gitAll(t, parent.Workspace, []string{"switch", "--quiet", "-c", "topic"})
	topic := commitFile(t, parent.Workspace, "topic.txt", "topic")
	gitAll(t, parent.Workspace, []string{"switch", "--quiet", "--detach"})
	detached := commitFile(t, parent.Workspace, "detached.txt", "detached")
	gitAll(t, parent.Workspace, []string{"switch", "--quiet", "topic"})
	for _, want := range []struct{ base, commit string }{{"topic", topic}, {detached, detached}} {
		if want.base == detached {
			gitAll(t, parent.Workspace, []string{"switch", "--quiet", "--detach", detached})
		}
		child, err := s.prepareProject(ctx, "", parent.ID)
		if err != nil || child.Preparation.Base != want.base {
			t.Fatal(child, err)
		}
		id, revision := choose(child, true)
		launched, _, err := s.launchPrepared(ctx, id, revision, size)
		if err != nil || launched.Worktree.Commit != want.commit {
			t.Fatal(launched, err)
		}
	}
	// A parent launch that stopped before its first terminal keeps the project folder as
	// its workspace. A sub-session cannot start there in place of the parent workspace.
	stalled, err := s.prepareProject(ctx, project.ID, "")
	if err == nil {
		err = s.store.SetPreparationState(stalled.ID, stalled.Preparation.Revision, "draft", "interrupted")
	}
	if err != nil {
		t.Fatal(err)
	}
	waiting, err := s.prepareProject(ctx, "", stalled.ID)
	if err != nil {
		t.Fatal(err)
	}
	id, revision = choose(waiting, false)
	if _, _, err = s.launchPrepared(ctx, id, revision, size); err == nil || !strings.Contains(err.Error(), "start the parent session first") {
		t.Fatal(err)
	}
	// A session without a project cannot get a sub-session.
	standalone, err := s.store.CreateSession("Standalone", repo, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.prepareProject(ctx, "", standalone.ID); err == nil {
		t.Fatal("created a sub-session of a standalone session")
	}
	if _, err = s.prepareProject(ctx, "", "missing"); err == nil {
		t.Fatal("created a sub-session of a missing session")
	}
}

func TestArchiveFamilyChecksLiveMembers(t *testing.T) {
	ctx := context.Background()
	s, _ := composerServer(t)
	project, err := s.addProject("Family", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	parent, err := s.prepareProject(ctx, project.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	child, err := s.prepareProject(ctx, "", parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	// A live terminal that the server owns blocks the archive of the family.
	s.sessions = map[string]*runningSession{child.ID: {id: child.ID}}
	if err = s.archiveSession(parent.ID, true, nil); err == nil || !strings.Contains(err.Error(), "every session of this family") {
		t.Fatal(err)
	}
	s.sessions = nil
	// The archive checks the sub-sessions that the user confirmed.
	if err = s.archiveSession(parent.ID, true, []string{}); err != history.ErrFamilyChanged {
		t.Fatal(err)
	}
	if err = s.archiveSession(parent.ID, true, []string{child.ID}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{parent.ID, child.ID} {
		if session, err := s.store.Session(id); err != nil || !session.Archived {
			t.Fatal(session, err)
		}
	}
	if err = s.archiveSession(parent.ID, false, nil); err != nil {
		t.Fatal(err)
	}
	if session, err := s.store.Session(child.ID); err != nil || session.Archived {
		t.Fatal(session, err)
	}
}

func TestSessionSummariesCarryTheLatestRunStatus(t *testing.T) {
	s, _ := composerServer(t)
	session, err := s.store.CreateSession("Failed run", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.store.NewRun(session.ID)
	if err == nil {
		run.Status = "failed"
		err = s.store.SaveRun(run)
	}
	if err != nil {
		t.Fatal(err)
	}
	page, err := s.listSessions(history.SessionFilter{Groups: []string{""}})
	if err != nil {
		t.Fatal(err)
	}
	statuses := map[string]string{}
	for _, info := range page.Sessions {
		statuses[info.Title] = info.Status + "/" + info.RunStatus
	}
	// The fixture session has no run and no preparation, so it shows as ended with no run
	// status.
	if statuses["Failed run"] != "ended/failed" || statuses["Composer fixture"] != "ended/" {
		t.Fatal(statuses)
	}
}
