package history

import (
	"bytes"
	"fmt"
	"math"
	"path/filepath"
	"slices"
	"testing"
)

func TestArchivePersistenceAndSearchAcrossPages(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.sqlite")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	project, err := s.CreateProject("Saved work", "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.CreatePreparation("Old 100%_draft", project.Workspace, project.ID, Preparation{ToolName: "Shell", Base: "unfinished base"})
	if err != nil {
		t.Fatal(err)
	}
	data := []byte(`{"text":"unsent message","attachments":[],"pending":false}`)
	revision, err := s.SaveDraft(first.ID, 0, data)
	if err != nil {
		t.Fatal(err)
	}
	attachment, err := s.Append(first.ID, "", "attachment", []byte{0, 1, 2, 255}, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	for i := range 105 {
		session, err := s.CreatePreparation(fmt.Sprintf("Draft %d", i), project.Workspace, project.ID, Preparation{})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = s.SetSessionArchived(session.ID, true, nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.SetSessionArchived(first.ID, true, nil); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	visible, err := s.ListSessions(SessionFilter{Limit: 100})
	if err != nil || len(visible.Sessions) != 0 || len(visible.More) != 0 {
		t.Fatal("archived drafts leaked into normal list", visible, err)
	}
	page, err := s.ListSessions(SessionFilter{Limit: 100, Archived: true})
	if err != nil || len(page.Sessions) != 100 || !slices.Equal(page.More, []string{project.ID}) {
		t.Fatal(page, err)
	}
	page, err = s.ListSessions(SessionFilter{Limit: 100, Groups: []string{project.ID}, Offset: 100, Archived: true})
	if err != nil || len(page.Sessions) != 6 || page.Sessions[5].ID != first.ID || len(page.More) != 0 {
		t.Fatal("old drafts are not reachable", page, err)
	}
	for _, query := range []string{"OLD", "100%_", first.ID} {
		found, err := s.ListSessions(SessionFilter{Limit: 1, Archived: true, Query: query})
		if err != nil || len(found.Sessions) != 1 || found.Sessions[0].ID != first.ID {
			t.Fatal("search did not find old draft", query, found, err)
		}
	}
	for _, query := range []string{"saved WORK", "/workspace"} {
		found, err := s.ListSessions(SessionFilter{Limit: 100, Groups: []string{project.ID}, Offset: 6, Archived: true, Query: query})
		if err != nil || len(found.Sessions) != 100 || found.Sessions[99].ID != first.ID {
			t.Fatal("project search failed", query, len(found.Sessions), err)
		}
	}
	if err = s.RemoveProject(project.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetSessionArchived(first.ID, false, nil); err != nil {
		t.Fatal(err)
	}
	got, err := s.Session(first.ID)
	if err != nil || got.Archived || got.ProjectID != "" || got.Title != first.Title || got.Workspace != first.Workspace || got.Run != nil || *got.Preparation != *first.Preparation {
		t.Fatal("restore changed session content", got, err)
	}
	draft, err := s.LatestDraft(first.ID)
	if err != nil || draft.Seq != revision || !bytes.Equal(draft.Data, data) {
		t.Fatal("archive lost draft revision", draft, err)
	}
	file, err := s.Attachment(first.ID, attachment.Seq)
	if err != nil || !bytes.Equal(file.Data, attachment.Data) {
		t.Fatal("archive lost original attachment", file, err)
	}
	visible, err = s.ListSessions(SessionFilter{})
	if err != nil || len(visible.Sessions) != 1 || visible.Sessions[0].ID != first.ID {
		t.Fatal("restore did not return draft to normal list", visible, err)
	}
}

func TestArchiveRejectsActiveRunsAndLaunchClaims(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	project, err := s.CreateProject("Project", "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	draft, err := s.CreatePreparation("Draft", project.Workspace, project.ID, Preparation{})
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"creating", "launched"} {
		if err = s.SetPreparationState(draft.ID, 1, "draft", state); err != nil {
			t.Fatal(err)
		}
		if _, err = s.SetSessionArchived(draft.ID, true, nil); err == nil {
			t.Fatal("archived unfinished launch", state)
		}
		if err = s.SetPreparationState(draft.ID, 1, state, "draft"); err != nil {
			t.Fatal(err)
		}
	}
	run, err := s.NewRun(draft.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"starting", "running", "exited", "stopped", "failed", "interrupted"} {
		run.Status = status
		if err = s.SaveRun(run); err != nil {
			t.Fatal(err)
		}
		_, err = s.SetSessionArchived(draft.ID, true, nil)
		if wantError := status == "starting" || status == "running"; (err != nil) != wantError {
			t.Fatal("incorrect archive eligibility", status, err)
		}
	}
	if _, err = s.SetSessionArchived("missing", true, nil); err == nil {
		t.Fatal("archived nonexistent session")
	}
	standalone := ""
	for _, filter := range []SessionFilter{{Limit: -1}, {Limit: 101}, {Offset: -1, Groups: []string{standalone}}, {Offset: 1}, {Groups: []string{standalone}, Offset: 1, Include: draft.ID}, {Limit: 50, Groups: []string{"a", "b", "c"}}, {Limit: math.MaxInt/2 + 1, Groups: []string{"a", "b"}}} {
		if _, err = s.ListSessions(filter); err == nil {
			t.Fatal("accepted invalid filter", filter)
		}
	}
}
