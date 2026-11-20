package history

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// familyStore has two projects. In "Work", "Parent" has the sub-sessions "Reviewer" and
// "Docs". "Solo" and "Older" are top-level sessions. "Other" is in "Elsewhere".
type familyStore struct {
	*Store
	work, elsewhere Project
	ids             map[string]string
}

func newFamilyStore(t *testing.T) *familyStore {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	f := &familyStore{Store: s, ids: map[string]string{}}
	if f.work, err = s.CreateProject("Work", "/work"); err != nil {
		t.Fatal(err)
	}
	if f.elsewhere, err = s.CreateProject("Elsewhere", "/elsewhere"); err != nil {
		t.Fatal(err)
	}
	add := func(title string, project Project, parent string) {
		t.Helper()
		var session Session
		if parent == "" {
			session, err = s.CreatePreparation(title, project.Workspace, project.ID, Preparation{})
		} else {
			session, err = s.CreateSubPreparation(f.ids[parent], project.Workspace, project.ID, Preparation{})
			if err == nil {
				err = s.RenameSession(session.ID, title)
			}
		}
		if err != nil {
			t.Fatal(title, err)
		}
		f.ids[title] = session.ID
	}
	add("Older", f.work, "")
	add("Parent", f.work, "")
	add("Reviewer", f.work, "Parent")
	add("Solo", f.work, "")
	add("Docs", f.work, "Parent")
	add("Other", f.elsewhere, "")
	return f
}

// touch gives a session terminal activity at a time.
func (f *familyStore) touch(t *testing.T, title, created string) {
	t.Helper()
	event, err := f.Append(f.ids[title], "", "output", nil, "")
	if err == nil {
		_, err = f.db.Exec("UPDATE events SET created=? WHERE seq=?", created, event.Seq)
	}
	if err != nil {
		t.Fatal(err)
	}
}

// list returns the titles of a page. A context row has a "~" prefix. A sub-session has
// a "-" prefix.
func (f *familyStore) list(t *testing.T, filter SessionFilter) ([]string, []string) {
	t.Helper()
	page, err := f.ListSessions(filter)
	if err != nil {
		t.Fatal(err)
	}
	titles := []string{}
	for _, item := range page.Sessions {
		title := item.Title
		if item.ParentID != "" {
			if item.ParentID != f.ids[strings.TrimLeft(titles[len(titles)-1], "~-")] && !strings.HasPrefix(titles[len(titles)-1], "-") {
				t.Fatalf("sub-session %s does not follow its parent: %v", title, titles)
			}
			title = "-" + title
		}
		if item.Context {
			title = "~" + title
		}
		titles = append(titles, title)
	}
	return titles, page.More
}

func TestFamiliesListTogetherAndPageAsOne(t *testing.T) {
	f := newFamilyStore(t)
	if _, err := f.db.Exec("UPDATE sessions SET created='2026-01-01T00:00:00Z'"); err != nil {
		t.Fatal(err)
	}
	f.touch(t, "Older", "2026-01-02T00:00:00Z")
	f.touch(t, "Solo", "2026-01-03T00:00:00Z")
	f.touch(t, "Parent", "2026-01-04T00:00:00Z")
	// The activity of a sub-session moves its family. The sub-sessions keep their
	// creation order.
	titles, more := f.list(t, SessionFilter{Groups: []string{f.work.ID}})
	if want := []string{"Parent", "-Reviewer", "-Docs", "Solo", "Older"}; !reflect.DeepEqual(titles, want) || len(more) != 0 {
		t.Fatal(titles, more)
	}
	f.touch(t, "Solo", "2026-01-05T00:00:00Z")
	f.touch(t, "Docs", "2026-01-06T00:00:00Z")
	titles, _ = f.list(t, SessionFilter{Groups: []string{f.work.ID}})
	if want := []string{"Parent", "-Reviewer", "-Docs", "Solo", "Older"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
	f.touch(t, "Older", "2026-01-07T00:00:00Z")
	// The limit and the offset count families, not sessions.
	titles, more = f.list(t, SessionFilter{Limit: 1, Groups: []string{f.work.ID}})
	if want := []string{"Older"}; !reflect.DeepEqual(titles, want) || !reflect.DeepEqual(more, []string{f.work.ID}) {
		t.Fatal(titles, more)
	}
	titles, more = f.list(t, SessionFilter{Limit: 1, Groups: []string{f.work.ID}, Offset: 1})
	if want := []string{"Parent", "-Reviewer", "-Docs"}; !reflect.DeepEqual(titles, want) || !reflect.DeepEqual(more, []string{f.work.ID}) {
		t.Fatal(titles, more)
	}
	titles, more = f.list(t, SessionFilter{Limit: 2, Groups: []string{f.work.ID}, Offset: 1})
	if want := []string{"Parent", "-Reviewer", "-Docs", "Solo"}; !reflect.DeepEqual(titles, want) || len(more) != 0 {
		t.Fatal(titles, more)
	}
	// An included sub-session brings its whole family outside the limit.
	titles, _ = f.list(t, SessionFilter{Limit: 1, Groups: []string{f.work.ID}, Include: f.ids["Reviewer"]})
	if want := []string{"Older", "Parent", "-Reviewer", "-Docs"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
	// Groups stay separate.
	titles, _ = f.list(t, SessionFilter{Groups: []string{f.elsewhere.ID}})
	if want := []string{"Other"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
}

func TestFamilySearchShowsParentAsContext(t *testing.T) {
	f := newFamilyStore(t)
	// A match of a sub-session shows its parent as context.
	titles, _ := f.list(t, SessionFilter{Query: "review"})
	if want := []string{"~Parent", "-Reviewer"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
	// A match of the parent shows the whole family.
	titles, _ = f.list(t, SessionFilter{Query: "parent"})
	if want := []string{"Parent", "-Reviewer", "-Docs"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
	// Sub-session titles are not inherited. "Docs" matches only itself.
	titles, _ = f.list(t, SessionFilter{Query: "doc"})
	if want := []string{"~Parent", "-Docs"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
}

func TestFamilyArchive(t *testing.T) {
	f := newFamilyStore(t)
	// Archive of a sub-session changes only that session. The archived list shows its
	// parent as context.
	ids, err := f.SetSessionArchived(f.ids["Reviewer"], true, nil, nil)
	if err != nil || !reflect.DeepEqual(ids, []string{f.ids["Reviewer"]}) {
		t.Fatal(ids, err)
	}
	// "Docs" is newer than "Solo", so its family comes first.
	titles, _ := f.list(t, SessionFilter{Groups: []string{f.work.ID}})
	if want := []string{"Parent", "-Docs", "Solo", "Older"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
	titles, _ = f.list(t, SessionFilter{Archived: true})
	if want := []string{"~Parent", "-Reviewer"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
	// A search for the context parent in the archived list finds its archived sub-sessions.
	titles, _ = f.list(t, SessionFilter{Archived: true, Query: "parent"})
	if want := []string{"~Parent", "-Reviewer"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
	// A live member blocks the archive of the family.
	live := func(id string) bool { return id == f.ids["Docs"] }
	if _, err = f.SetSessionArchived(f.ids["Parent"], true, live, nil); err == nil || !strings.Contains(err.Error(), "every session of this family") {
		t.Fatal(err)
	}
	if _, err = f.db.Exec("UPDATE preparations SET state='creating' WHERE session_id=?", f.ids["Docs"]); err != nil {
		t.Fatal(err)
	}
	if _, err = f.SetSessionArchived(f.ids["Parent"], true, nil, nil); err == nil {
		t.Fatal("archived a family with an unfinished launch claim")
	}
	if _, err = f.db.Exec("UPDATE preparations SET state='draft' WHERE session_id=?", f.ids["Docs"]); err != nil {
		t.Fatal(err)
	}
	// A family archive checks the sub-sessions that the user confirmed. An archived
	// sub-session is not a member of the archive.
	for _, members := range [][]string{{}, {f.ids["Docs"], f.ids["Reviewer"]}, {f.ids["Reviewer"]}} {
		if _, err = f.SetSessionArchived(f.ids["Parent"], true, nil, members); err != ErrFamilyChanged {
			t.Fatal(members, err)
		}
	}
	if session, err := f.Session(f.ids["Parent"]); err != nil || session.Archived {
		t.Fatal("a rejected family archive changed the parent", session, err)
	}
	// Archive of the parent archives the family.
	ids, err = f.SetSessionArchived(f.ids["Parent"], true, nil, []string{f.ids["Docs"]})
	if err != nil || !reflect.DeepEqual(ids, []string{f.ids["Parent"], f.ids["Docs"]}) {
		t.Fatal(ids, err)
	}
	titles, _ = f.list(t, SessionFilter{Archived: true, Groups: []string{f.work.ID}})
	if want := []string{"Parent", "-Reviewer", "-Docs"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
	// Restore of a sub-session also restores its parent.
	ids, err = f.SetSessionArchived(f.ids["Docs"], false, nil, nil)
	if err != nil || !reflect.DeepEqual(ids, []string{f.ids["Docs"], f.ids["Parent"]}) {
		t.Fatal(ids, err)
	}
	titles, _ = f.list(t, SessionFilter{Archived: true})
	if want := []string{"~Parent", "-Reviewer"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
	// Restore of the parent restores all of its archived sub-sessions.
	if _, err = f.SetSessionArchived(f.ids["Parent"], true, nil, nil); err != nil {
		t.Fatal(err)
	}
	ids, err = f.SetSessionArchived(f.ids["Parent"], false, nil, nil)
	if err != nil || !reflect.DeepEqual(ids, []string{f.ids["Parent"], f.ids["Reviewer"], f.ids["Docs"]}) {
		t.Fatal(ids, err)
	}
}

func TestSessionParentRules(t *testing.T) {
	f := newFamilyStore(t)
	for _, test := range []struct{ session, parent, message string }{
		{"Solo", "Solo", "own parent"},
		{"Solo", "Reviewer", "cannot have sub-sessions"},
		{"Parent", "Solo", "has sub-sessions"},
		{"Solo", "Other", "same project"},
		{"Solo", "missing", "not found"},
	} {
		parent := f.ids[test.parent]
		if parent == "" {
			parent = test.parent
		}
		if err := f.SetSessionParent(f.ids[test.session], parent); err == nil || !strings.Contains(err.Error(), test.message) {
			t.Errorf("%s under %s: %v", test.session, test.parent, err)
		}
	}
	if err := f.SetSessionParent("missing", ""); err != ErrNotFound {
		t.Fatal(err)
	}
	// A move changes only the parent.
	before, err := f.Session(f.ids["Solo"])
	if err != nil {
		t.Fatal(err)
	}
	if err = f.SetSessionParent(f.ids["Solo"], f.ids["Parent"]); err != nil {
		t.Fatal(err)
	}
	after, err := f.Session(f.ids["Solo"])
	// The parent gives the meaning of the workspace choice of a draft. Thus a view with
	// the revision from before the move cannot start the draft.
	before.ParentID = f.ids["Parent"]
	before.Preparation.Revision++
	if err != nil || !reflect.DeepEqual(after, before) {
		t.Fatal(after, before, err)
	}
	if err = f.SetPreparationState(f.ids["Solo"], before.Preparation.Revision-1, "draft", "creating"); err == nil {
		t.Fatal("claimed a draft with its revision from before the move")
	}
	titles, _ := f.list(t, SessionFilter{Groups: []string{f.work.ID}})
	if want := []string{"Parent", "-Reviewer", "-Solo", "-Docs", "Older"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
	if err = f.SetSessionParent(f.ids["Reviewer"], ""); err != nil {
		t.Fatal(err)
	}
	if session, err := f.Session(f.ids["Reviewer"]); err != nil || session.ParentID != "" {
		t.Fatal(session, err)
	}
	// Archived sessions and archived parents do not move.
	if _, err = f.SetSessionArchived(f.ids["Older"], true, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err = f.SetSessionParent(f.ids["Older"], f.ids["Parent"]); err == nil {
		t.Fatal("moved an archived session")
	}
	if err = f.SetSessionParent(f.ids["Reviewer"], f.ids["Older"]); err == nil {
		t.Fatal("moved a session under an archived parent")
	}
	// A sub-session draft needs a top-level parent in the same project.
	if _, err = f.CreateSubPreparation(f.ids["Docs"], f.work.Workspace, f.work.ID, Preparation{}); err == nil {
		t.Fatal("created a second level")
	}
	if _, err = f.CreateSubPreparation(f.ids["Other"], f.work.Workspace, f.work.ID, Preparation{}); err == nil {
		t.Fatal("created a sub-session in another project")
	}
	// Project removal keeps the family together under Standalone.
	if err = f.RemoveProject(f.work.ID); err != nil {
		t.Fatal(err)
	}
	titles, _ = f.list(t, SessionFilter{Groups: []string{""}, Query: "parent"})
	if want := []string{"Parent", "-Solo", "-Docs"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
}
