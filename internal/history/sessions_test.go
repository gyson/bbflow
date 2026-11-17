package history

import (
	"fmt"
	"path/filepath"
	"slices"
	"testing"
)

func TestRecentSessionsUseTerminalActivity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.sqlite")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if store != nil {
			store.Close()
		}
	})
	older, err := store.CreateSession("older", "/tmp", "")
	if err != nil {
		t.Fatal(err)
	}
	newer, err := store.CreateSession("newer", "/tmp", "")
	if err != nil {
		t.Fatal(err)
	}
	const early = "2026-01-01T00:00:00Z"
	const later = "2026-01-02T00:00:00Z"
	const activity = "2026-01-03T00:00:00Z"
	const ignored = "2026-01-04T00:00:00Z"
	for id, created := range map[string]string{older.ID: early, newer.ID: later} {
		if _, err = store.db.Exec("UPDATE sessions SET created=? WHERE id=?", created, id); err != nil {
			t.Fatal(err)
		}
	}
	appendAt := func(id, kind, created string) {
		t.Helper()
		event, err := store.Append(id, "", kind, nil, "")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = store.db.Exec("UPDATE events SET created=? WHERE seq=?", created, event.Seq); err != nil {
			t.Fatal(err)
		}
	}
	assertRecent := func(id, updated string) {
		t.Helper()
		listed, err := store.ListSessions(SessionFilter{Limit: 1})
		items := listed.Sessions
		if err != nil || len(items) != 1 || items[0].ID != id || items[0].Updated != updated {
			t.Fatalf("recent = %+v, %v; want %s at %s", items, err, id, updated)
		}
	}
	// Sessions with no terminal events use creation time, even with newer drafts.
	appendAt(older.ID, "draft", ignored)
	assertRecent(newer.ID, later)
	appendAt(older.ID, "output", activity)
	appendAt(newer.ID, "output", activity)
	assertRecent(newer.ID, activity)
	for _, kind := range []string{"resize", "draft", "attachment", "terminal-response", "terminal-screen"} {
		appendAt(older.ID, kind, ignored)
		assertRecent(newer.ID, activity)
	}
	if err = store.RenameSession(older.ID, "renamed"); err != nil {
		t.Fatal(err)
	}
	assertRecent(newer.ID, activity)
	// Only qualifying event sequences determine the order when timestamps are equal. This
	// includes input and lifecycle events without associated output.
	for _, kind := range []string{"start", "run", "input", "output", "notice"} {
		appendAt(older.ID, kind, activity)
		assertRecent(older.ID, activity)
		appendAt(newer.ID, "output", activity)
		assertRecent(newer.ID, activity)
	}
	appendAt(older.ID, "draft", ignored)
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	assertRecent(newer.ID, activity)
}

// Sessions with equal times keep their creation order, newest first. Session IDs are
// random, so they cannot give a stable order.
func TestEqualSessionTimesUseCreationOrder(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	var ids []string
	for i := range 20 {
		session, err := store.CreateSession(fmt.Sprintf("Session %d", i), "/tmp", "")
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, session.ID)
	}
	if _, err = store.db.Exec("UPDATE sessions SET created='2026-01-01T00:00:00Z'"); err != nil {
		t.Fatal(err)
	}
	listed, err := store.ListSessions(SessionFilter{Limit: 100})
	items := listed.Sessions
	if err != nil || len(items) != len(ids) {
		t.Fatal(items, err)
	}
	for i, item := range items {
		if want := ids[len(ids)-1-i]; item.ID != want {
			t.Fatalf("position %d = %s; want %s", i, item.ID, want)
		}
	}
}

// Each saved project is one group. Sessions without a saved project, also after their
// project is removed, form the Standalone group "".
func TestSessionGroupLimits(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	kept, err := store.CreateProject("Kept", "/kept")
	if err != nil {
		t.Fatal(err)
	}
	removed, err := store.CreateProject("Removed", "/removed")
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string][]string{} // Session IDs by group, newest first.
	for i := range 3 {
		for _, project := range []string{kept.ID, removed.ID, ""} {
			session, err := store.CreateSession(fmt.Sprintf("Session %d", i), "/tmp", project)
			if err != nil {
				t.Fatal(err)
			}
			group := project
			if group == removed.ID {
				group = ""
			}
			ids[group] = append([]string{session.ID}, ids[group]...)
		}
	}
	if err = store.RemoveProject(removed.ID); err != nil {
		t.Fatal(err)
	}
	listed := func(filter SessionFilter) map[string][]string {
		t.Helper()
		page, err := store.ListSessions(filter)
		if err != nil {
			t.Fatal(err)
		}
		groups := map[string][]string{}
		for _, session := range page.Sessions {
			groups[session.ProjectID] = append(groups[session.ProjectID], session.ID)
		}
		groups["more"] = page.More
		return groups
	}
	got := listed(SessionFilter{Limit: 2})
	if !slices.Equal(got[kept.ID], ids[kept.ID][:2]) || len(got[""]) != 2 || !slices.Equal(got["more"], []string{"", kept.ID}) {
		t.Fatal("group limit", got)
	}
	got = listed(SessionFilter{Limit: 2, Limits: map[string]int{"": 6}})
	if len(got[kept.ID]) != 2 || len(got[""]) != 6 || !slices.Equal(got["more"], []string{kept.ID}) {
		t.Fatal("standalone limit", got)
	}
	oldest := ids[kept.ID][2]
	got = listed(SessionFilter{Limit: 1, Include: oldest})
	if !slices.Equal(got[kept.ID], []string{ids[kept.ID][0], oldest}) || !slices.Equal(got["more"], []string{"", kept.ID}) {
		t.Fatal("included session", got)
	}
	if got = listed(SessionFilter{Limit: 1, Include: oldest, Archived: true}); len(got[kept.ID]) != 0 {
		t.Fatal("included session outside the archive filter", got)
	}
}
