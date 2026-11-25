package history

import (
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
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
	record := func(add func(sid, rid, kind string, data []byte, text string) (Event, error), id, kind, created string) int64 {
		t.Helper()
		event, err := add(id, "", kind, nil, "")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = store.db.Exec("UPDATE events SET created=? WHERE seq=?", created, event.Seq); err != nil {
			t.Fatal(err)
		}
		return event.Seq
	}
	appendAt := func(id, kind, created string) int64 {
		t.Helper()
		return record(store.Append, id, kind, created)
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
	// Quiet events are not activity: a focus report of a view, and output that changed
	// nothing on the screen.
	record(store.AppendQuiet, older.ID, "input", ignored)
	assertRecent(newer.ID, activity)
	if err = store.MarkQuiet(appendAt(older.ID, "output", ignored)); err != nil {
		t.Fatal(err)
	}
	assertRecent(newer.ID, activity)
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

// The server records output before it sets the quiet flag of the output. Until then, the
// output of a live terminal does not count. Other events count, because their flags are
// final when they are recorded.
func TestOrderSkipsLiveOutputBeforeItsQuietFlag(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	live, err := store.CreateSession("live", "/tmp", "")
	if err != nil {
		t.Fatal(err)
	}
	other, err := store.CreateSession("other", "/tmp", "")
	if err != nil {
		t.Fatal(err)
	}
	record := func(id, kind string) int64 {
		t.Helper()
		event, err := store.Append(id, "run", kind, nil, "")
		if err != nil {
			t.Fatal(err)
		}
		return event.Seq
	}
	first := func(reason string, classified map[string]int64, want string) {
		t.Helper()
		listed, err := store.ListSessions(SessionFilter{Limit: 2, Classified: classified})
		if err != nil || len(listed.Sessions) != 2 || listed.Sessions[0].ID != want {
			t.Fatalf("%s: list is %+v, %v, expected %s first", reason, listed, err, want)
		}
	}
	start := record(live.ID, "start")
	record(other.ID, "output")
	output := record(live.ID, "output")
	first("without a live terminal", nil, live.ID)
	first("output before its quiet flag", map[string]int64{live.ID: start}, other.ID)
	first("output with its quiet flag", map[string]int64{live.ID: output}, live.ID)
	record(live.ID, "input")
	first("input after the classified event", map[string]int64{live.ID: start}, live.ID)
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
	standalone := ""
	got = listed(SessionFilter{Limit: 3, Groups: []string{standalone}, Offset: 2})
	if len(got[kept.ID]) != 0 || !slices.Equal(got[""], ids[""][2:5]) || !slices.Equal(got["more"], []string{""}) {
		t.Fatal("standalone window", got)
	}
	got = listed(SessionFilter{Limit: 3, Groups: []string{kept.ID}, Offset: 1})
	if !slices.Equal(got[kept.ID], ids[kept.ID][1:]) || len(got[""]) != 0 || len(got["more"]) != 0 {
		t.Fatal("last project window", got)
	}
	oldest := ids[kept.ID][2]
	got = listed(SessionFilter{Limit: 1, Include: oldest})
	if !slices.Equal(got[kept.ID], []string{ids[kept.ID][0], oldest}) || !slices.Equal(got["more"], []string{"", kept.ID}) {
		t.Fatal("included session", got)
	}
	// A batch of groups includes the session only when its group is in the batch.
	if got = listed(SessionFilter{Limit: 1, Groups: []string{kept.ID}, Include: oldest}); !slices.Equal(got[kept.ID], []string{ids[kept.ID][0], oldest}) || len(got[""]) != 0 {
		t.Fatal("included session in its batch", got)
	}
	if got = listed(SessionFilter{Limit: 1, Groups: []string{""}, Include: oldest}); len(got[kept.ID]) != 0 || len(got[""]) != 1 {
		t.Fatal("included session outside its batch", got)
	}
	if got = listed(SessionFilter{Limit: 1, Include: oldest, Archived: true}); len(got[kept.ID]) != 0 {
		t.Fatal("included session outside the archive filter", got)
	}
}

// Each reply holds at most MaxSessionLimit sessions. Windows of one group reach each of
// its sessions once.
func TestSessionGroupWindows(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	const count = 1005
	var want []string
	for i := range count {
		session, err := store.CreateSession(fmt.Sprintf("Session %d", i), "/tmp", "")
		if err != nil {
			t.Fatal(err)
		}
		want = append([]string{session.ID}, want...)
	}
	standalone := ""
	var got []string
	for offset := 0; ; offset += MaxSessionLimit {
		page, err := store.ListSessions(SessionFilter{Limit: MaxSessionLimit, Groups: []string{standalone}, Offset: offset})
		if err != nil || len(page.Sessions) > MaxSessionLimit {
			t.Fatal(offset, len(page.Sessions), err)
		}
		for _, session := range page.Sessions {
			got = append(got, session.ID)
		}
		if len(page.More) == 0 {
			break
		}
	}
	if !slices.Equal(got, want) {
		t.Fatalf("windows listed %d sessions; want %d in order", len(got), len(want))
	}
}

func TestSessionTitlesKeepUserAndDerivedValues(t *testing.T) {
	store := testStore(t)
	session, err := store.CreateSession("", "/missing/workspace", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = store.SetLaunchWorkspace(session.ID, "Shell · workspace", session.Workspace); err != nil {
		t.Fatal(err)
	}
	if err = store.SetAutoTitle(session.ID, "Fix login redirect"); err != nil {
		t.Fatal(err)
	}
	if err = store.SetAutoTitle("missing", "Other"); err == nil {
		t.Fatal("set a title of a missing session")
	}
	if err = store.RenameSession(session.ID, "  My name  "); err != nil {
		t.Fatal(err)
	}
	got, err := store.Session(session.ID)
	if err != nil || got.Title != "My name" || got.AutoTitle != "Fix login redirect" || got.DisplayTitle() != "My name" {
		t.Fatalf("session: %+v, %v", got, err)
	}
	// Search matches both titles.
	for _, query := range []string{"my name", "LOGIN"} {
		page, err := store.ListSessions(SessionFilter{Query: query})
		if err != nil || len(page.Sessions) != 1 || page.Sessions[0].AutoTitle != "Fix login redirect" {
			t.Fatalf("search %q: %+v, %v", query, page, err)
		}
	}
	if err = store.RenameSession(session.ID, ""); err != nil {
		t.Fatal(err)
	}
	if got, err = store.Session(session.ID); err != nil || got.DisplayTitle() != "Fix login redirect" {
		t.Fatalf("cleared session: %+v, %v", got, err)
	}
}

// Only SetTitleTool changes the title tool and the custom title command. A settings save
// keeps both, and its revision check rejects a save from before a title tool change.
func TestTitleToolSettings(t *testing.T) {
	store := testStore(t)
	settings, err := store.Settings()
	if err != nil || settings.TitleTool != "none" || settings.TitleCommand != "" {
		t.Fatalf("default title tool: %+v, %v", settings, err)
	}
	// choose saves a title tool from the current choice.
	choose := func(tool, command string) (Settings, error) {
		t.Helper()
		current, err := store.Settings()
		if err != nil {
			t.Fatal(err)
		}
		return store.SetTitleTool(TitleChoice{Tool: tool, Command: command}, current.Choice())
	}
	for _, tool := range TitleTools {
		command := ""
		if tool == "custom" {
			command = `my-llm --fast "$(cat)"`
		}
		saved, err := choose(tool, command)
		if err != nil || saved.TitleTool != tool || saved.Revision != settings.Revision+1 {
			t.Fatalf("set %s: %+v, %v", tool, saved, err)
		}
		settings = saved
	}
	if settings.TitleCommand != `my-llm --fast "$(cat)"` {
		t.Fatalf("custom command: %+v", settings)
	}
	// Another tool keeps the saved custom command.
	if settings, err = choose("none", ""); err != nil || settings.TitleTool != "none" || settings.TitleCommand != `my-llm --fast "$(cat)"` {
		t.Fatalf("none lost the custom command: %+v, %v", settings, err)
	}
	for _, test := range []struct{ tool, command, want string }{
		{"", "", "none, claude, codex, code-puppy, apple, custom"},
		{"claude -p", "", "none, claude, codex, code-puppy, apple, custom"},
		{"codex", "codex exec -", "only the custom title tool takes a command"},
		{"custom", " ", "enter a command for the custom title tool"},
		{"custom", "my-llm\nrm -rf", "must be one line"},
		{"custom", strings.Repeat("x", 1001), "at most 1000 bytes"},
	} {
		if _, err = choose(test.tool, test.command); err == nil || !strings.Contains(err.Error(), test.want) {
			t.Fatalf("set %q %q: %v, want %q", test.tool, test.command, err, test.want)
		}
	}
	if after, err := store.Settings(); err != nil || after.Revision != settings.Revision {
		t.Fatalf("a rejected title tool saved settings: %+v, %v", after, err)
	}

	// A change from an earlier title choice saves nothing, so a test that ends late does
	// not undo a later change. A change of another setting does not block it.
	earlier := settings.Choice()
	if _, err = choose("codex", ""); err != nil {
		t.Fatal(err)
	}
	if _, err = store.SetTitleTool(TitleChoice{Tool: "claude"}, earlier); !errors.Is(err, ErrTitleChanged) {
		t.Fatalf("a change from an earlier choice: %v", err)
	}
	from := TitleChoice{Tool: "codex", Command: `my-llm --fast "$(cat)"`}
	current, _ := store.Settings()
	current.Appearance = "light"
	if _, err = store.SaveSettings(current); err != nil {
		t.Fatal(err)
	}
	if settings, err = store.SetTitleTool(TitleChoice{Tool: "none"}, from); err != nil || settings.TitleTool != "none" || settings.Appearance != "light" {
		t.Fatalf("a change after another setting saved: %+v, %v", settings, err)
	}

	// A settings save does not change the title tool or the custom command, also with
	// other values.
	settings.TitleTool, settings.TitleCommand = "claude", "other"
	settings.Appearance = "dark"
	if settings, err = store.SaveSettings(settings); err != nil || settings.TitleTool != "none" || settings.TitleCommand != `my-llm --fast "$(cat)"` || settings.Appearance != "dark" {
		t.Fatalf("a settings save changed the title tool: %+v, %v", settings, err)
	}
	stale := settings
	if _, err = choose("codex", ""); err != nil {
		t.Fatal(err)
	}
	stale.Appearance = "light"
	if _, err = store.SaveSettings(stale); err == nil || !strings.Contains(err.Error(), "settings changed") {
		t.Fatalf("a save from before the title tool change: %v", err)
	}
	if saved, err := store.Settings(); err != nil || saved.TitleTool != "codex" || saved.Appearance != "dark" {
		t.Fatalf("settings after the stale save: %+v, %v", saved, err)
	}
}
