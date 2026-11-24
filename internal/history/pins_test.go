package history

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// pin pins a session of the family store and sets the time of the pin, so the order of
// the Pinned group does not depend on the clock.
func (f *familyStore) pin(t *testing.T, title, pinned string) {
	t.Helper()
	err := f.SetSessionPinned(f.ids[title], true)
	if err == nil {
		_, err = f.db.Exec("UPDATE sessions SET pinned_at=? WHERE id=?", pinned, f.ids[title])
	}
	if err != nil {
		t.Fatal(title, err)
	}
}

func TestPinnedFamiliesFormTheirOwnGroup(t *testing.T) {
	f := newFamilyStore(t)
	if _, err := f.db.Exec("UPDATE sessions SET created='2026-01-01T00:00:00Z'"); err != nil {
		t.Fatal(err)
	}
	f.touch(t, "Older", "2026-01-02T00:00:00Z")
	f.touch(t, "Solo", "2026-01-03T00:00:00Z")
	f.touch(t, "Parent", "2026-01-04T00:00:00Z")
	f.pin(t, "Solo", "2026-02-01T00:00:00Z")
	f.pin(t, "Other", "2026-02-02T00:00:00Z")
	f.pin(t, "Parent", "2026-02-03T00:00:00Z")
	// The newest pin comes first. A pinned family lists its sub-sessions.
	pinned := []string{"Parent", "-Reviewer", "-Docs", "Other", "Solo"}
	titles, more := f.list(t, SessionFilter{Groups: []string{PinnedGroup}})
	if !reflect.DeepEqual(titles, pinned) || len(more) != 0 {
		t.Fatal(titles, more)
	}
	// Activity does not change the order of the Pinned group.
	f.touch(t, "Solo", "2026-03-01T00:00:00Z")
	f.touch(t, "Docs", "2026-03-02T00:00:00Z")
	if titles, _ = f.list(t, SessionFilter{Groups: []string{PinnedGroup}}); !reflect.DeepEqual(titles, pinned) {
		t.Fatal(titles)
	}
	// A pinned family is not in the group of its project.
	if titles, _ = f.list(t, SessionFilter{Groups: []string{f.work.ID}}); !reflect.DeepEqual(titles, []string{"Older"}) {
		t.Fatal(titles)
	}
	if titles, _ = f.list(t, SessionFilter{Groups: []string{f.elsewhere.ID}}); len(titles) != 0 {
		t.Fatal(titles)
	}
	// The limit and the offset count the families of the Pinned group too.
	titles, more = f.list(t, SessionFilter{Limit: 1, Groups: []string{PinnedGroup}, Offset: 1})
	if want := []string{"Other"}; !reflect.DeepEqual(titles, want) || !reflect.DeepEqual(more, []string{PinnedGroup}) {
		t.Fatal(titles, more)
	}
	// All groups list the Pinned group first.
	if titles, _ = f.list(t, SessionFilter{}); !reflect.DeepEqual(titles, append(pinned, "Older")) {
		t.Fatal(titles)
	}
	// An included pinned session comes only with a request for the Pinned group.
	if titles, _ = f.list(t, SessionFilter{Limit: 1, Groups: []string{f.work.ID}, Include: f.ids["Reviewer"]}); !reflect.DeepEqual(titles, []string{"Older"}) {
		t.Fatal(titles)
	}
	titles, _ = f.list(t, SessionFilter{Limit: 1, Groups: []string{PinnedGroup, f.work.ID}, Include: f.ids["Reviewer"]})
	if want := []string{"Parent", "-Reviewer", "-Docs", "Older"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
	// Search applies to the Pinned group. A match of a sub-session shows its parent as
	// context.
	if titles, _ = f.list(t, SessionFilter{Groups: []string{PinnedGroup}, Query: "review"}); !reflect.DeepEqual(titles, []string{"~Parent", "-Reviewer"}) {
		t.Fatal(titles)
	}
	// A summary reports the pin of a top-level session.
	page, err := f.ListSessions(SessionFilter{Groups: []string{PinnedGroup}})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range page.Sessions {
		if item.Pinned != (item.ParentID == "") {
			t.Fatal("wrong pin in the summary", item.Title, item.Pinned)
		}
	}
	if session, err := f.Session(f.ids["Solo"]); err != nil || !session.Pinned {
		t.Fatal("lost the pin", session, err)
	}
	// Archived ignores pins. The archive of a sub-session keeps the pin of its parent.
	if _, err := f.SetSessionArchived(f.ids["Docs"], true, nil, nil); err != nil {
		t.Fatal(err)
	}
	if titles, _ = f.list(t, SessionFilter{Groups: []string{f.work.ID}, Archived: true}); !reflect.DeepEqual(titles, []string{"~Parent", "-Docs"}) {
		t.Fatal(titles)
	}
	if titles, _ = f.list(t, SessionFilter{Groups: []string{PinnedGroup}, Archived: true}); len(titles) != 0 {
		t.Fatal(titles)
	}
	if titles, _ = f.list(t, SessionFilter{Groups: []string{PinnedGroup}}); !reflect.DeepEqual(titles, []string{"Parent", "-Reviewer", "Other", "Solo"}) {
		t.Fatal(titles)
	}
	// An unpin returns the family to the group of its project, at its activity position.
	if err := f.SetSessionPinned(f.ids["Solo"], false); err != nil {
		t.Fatal(err)
	}
	if titles, _ = f.list(t, SessionFilter{Groups: []string{f.work.ID}}); !reflect.DeepEqual(titles, []string{"Solo", "Older"}) {
		t.Fatal(titles)
	}
	// A pinned session of a removed project stays in the Pinned group.
	if err := f.RemoveProject(f.elsewhere.ID); err != nil {
		t.Fatal(err)
	}
	if titles, _ = f.list(t, SessionFilter{Groups: []string{PinnedGroup}}); !reflect.DeepEqual(titles, []string{"Parent", "-Reviewer", "Other"}) {
		t.Fatal(titles)
	}
	if titles, _ = f.list(t, SessionFilter{Groups: []string{""}}); len(titles) != 0 {
		t.Fatal(titles)
	}
}

func TestPinRules(t *testing.T) {
	f := newFamilyStore(t)
	pinnedAt := func(title string) any {
		t.Helper()
		return sqlRows(t, f.db, fmt.Sprintf("SELECT pinned_at FROM sessions WHERE id='%s'", f.ids[title]))[0][0]
	}
	if err := f.SetSessionPinned("missing", true); !errors.Is(err, ErrNotFound) {
		t.Fatal("pinned a missing session", err)
	}
	if err := f.SetSessionPinned(f.ids["Reviewer"], true); err == nil || !strings.Contains(err.Error(), "pin its top-level session") {
		t.Fatal("pinned a sub-session", err)
	}
	// A pin of a pinned session keeps the time of the first pin. An unpin of a session
	// without a pin changes nothing.
	f.pin(t, "Solo", "2026-02-01T00:00:00Z")
	if err := f.SetSessionPinned(f.ids["Solo"], true); err != nil || pinnedAt("Solo") != "2026-02-01T00:00:00Z" {
		t.Fatal("changed the pin", pinnedAt("Solo"), err)
	}
	if err := f.SetSessionPinned(f.ids["Older"], false); err != nil || pinnedAt("Older") != nil {
		t.Fatal("changed a session without a pin", pinnedAt("Older"), err)
	}
	// Archive removes the pin, and restore does not pin the session again.
	if _, err := f.SetSessionArchived(f.ids["Solo"], true, nil, nil); err != nil || pinnedAt("Solo") != nil {
		t.Fatal("kept the pin of an archived session", pinnedAt("Solo"), err)
	}
	if err := f.SetSessionPinned(f.ids["Solo"], true); err == nil || !strings.Contains(err.Error(), "restore the session") {
		t.Fatal("pinned an archived session", err)
	}
	if _, err := f.SetSessionArchived(f.ids["Solo"], false, nil, nil); err != nil || pinnedAt("Solo") != nil {
		t.Fatal("restored a pin", pinnedAt("Solo"), err)
	}
	// The schema rejects a pin of a sub-session or an archived session.
	for _, statement := range []string{
		"UPDATE sessions SET pinned_at='2026-02-01T00:00:00Z' WHERE id='" + f.ids["Reviewer"] + "'",
		"UPDATE sessions SET archived=1,pinned_at='2026-02-01T00:00:00Z' WHERE id='" + f.ids["Older"] + "'",
	} {
		if _, err := f.db.Exec(statement); err == nil || !strings.Contains(err.Error(), "CHECK") {
			t.Fatal("accepted an invalid pin", statement, err)
		}
	}
	// At most MaxPinned sessions have a pin.
	for i := range MaxPinned {
		session, err := f.CreateSession(fmt.Sprint("Pinned ", i), "/work", f.work.ID)
		if err == nil {
			err = f.SetSessionPinned(session.ID, true)
		}
		if err != nil {
			t.Fatal(i, err)
		}
	}
	if err := f.SetSessionPinned(f.ids["Solo"], true); err == nil || !strings.Contains(err.Error(), fmt.Sprintf("at most %d sessions", MaxPinned)) {
		t.Fatal("accepted too many pins", err)
	}
	page, err := f.ListSessions(SessionFilter{Limit: MaxPinned, Groups: []string{PinnedGroup}})
	if err != nil || len(page.Sessions) != MaxPinned || len(page.More) != 0 {
		t.Fatal("one page does not list every pin", len(page.Sessions), page.More, err)
	}
	id := page.Sessions[0].ID
	if err = f.SetSessionPinned(id, false); err != nil {
		t.Fatal(err)
	}
	if err = f.SetSessionPinned(f.ids["Solo"], true); err != nil {
		t.Fatal("rejected a pin after an unpin", err)
	}
}

// Pins in quick succession, and a pin after the clock moved back, come first.
func TestNewestPinComesFirst(t *testing.T) {
	f := newFamilyStore(t)
	for _, title := range []string{"Older", "Solo", "Parent", "Other"} {
		if err := f.SetSessionPinned(f.ids[title], true); err != nil {
			t.Fatal(err)
		}
	}
	titles, _ := f.list(t, SessionFilter{Groups: []string{PinnedGroup}})
	if want := []string{"Other", "Parent", "-Reviewer", "-Docs", "Solo", "Older"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
	// A pin from a later clock time comes before a new pin of a clock that moved back.
	if _, err := f.db.Exec("UPDATE sessions SET pinned_at='2999-01-01T00:00:00.000000000Z' WHERE id=?", f.ids["Older"]); err != nil {
		t.Fatal(err)
	}
	if err := f.SetSessionPinned(f.ids["Solo"], false); err != nil {
		t.Fatal(err)
	}
	if err := f.SetSessionPinned(f.ids["Solo"], true); err != nil {
		t.Fatal(err)
	}
	if got := sqlRows(t, f.db, "SELECT pinned_at FROM sessions WHERE id='"+f.ids["Solo"]+"'")[0][0]; got != "2999-01-01T00:00:00.000000001Z" {
		t.Fatal("wrong time of a pin after the latest pin", got)
	}
	titles, _ = f.list(t, SessionFilter{Groups: []string{PinnedGroup}})
	if want := []string{"Solo", "Older", "Other", "Parent", "-Reviewer", "-Docs"}; !reflect.DeepEqual(titles, want) {
		t.Fatal(titles)
	}
}
