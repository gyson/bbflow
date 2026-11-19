package history

import (
	"cmp"
	"context"
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func storageEvent(t *testing.T, s *Store, sid, rid, kind string, data []byte, text string) {
	t.Helper()
	if _, err := s.Append(sid, rid, kind, data, text); err != nil {
		t.Fatal(err)
	}
}

func storageRun(t *testing.T, s *Store, sid string) string {
	t.Helper()
	run, err := s.NewRun(sid)
	if err != nil {
		t.Fatal(err)
	}
	return run.ID
}

func TestStorageReportGroupsEventsBySessionProjectKindAndDay(t *testing.T) {
	s := testStore(t)
	project, err := s.CreateProject("Orbit", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	large, err := s.CreateSession("Large", t.TempDir(), project.ID)
	if err != nil {
		t.Fatal(err)
	}
	small, err := s.CreateSession("", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	create(t, s)
	for _, tool := range []string{"Codex", "Codex", "Claude"} {
		run := storageRun(t, s, large.ID)
		storageEvent(t, s, large.ID, run, "start", []byte(`{"tool":"`+tool+`"}`), "")
		storageEvent(t, s, large.ID, run, "output", []byte(strings.Repeat("o", 1000)), strings.Repeat("t", 500))
		storageEvent(t, s, large.ID, run, "input", []byte("k"), "")
	}
	run := storageRun(t, s, small.ID)
	storageEvent(t, s, small.ID, run, "start", []byte(`{"cols":80}`), "")
	storageEvent(t, s, small.ID, run, "output", []byte("hello"), "hello")

	report, err := s.StorageReport(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	startBytes := int64(len(`{"tool":"Codex"}`)*2 + len(`{"tool":"Claude"}`) + len(`{"cols":80}`))
	total := StorageUsage{Events: 11, Data: 3*1000 + 3 + 5 + startBytes, Text: 3*500 + 5}
	if got := report.Total; got.Events != total.Events || got.Data != total.Data || got.Text != total.Text {
		t.Fatalf("total %+v, want %+v", got, total)
	}
	if report.Format != schemaVersion || report.PageSize <= 0 || report.Pages <= 0 || report.SQLite == "" {
		t.Fatalf("database facts: %+v", report)
	}
	if report.Columns.SessionID != 11*32 || report.Columns.RunID != 11*32 || report.Columns.Kind != 3*5+3*6+3*5+5+6 ||
		report.Columns.Created < 11*20 || report.Columns.Data != total.Data || report.Columns.Text != total.Text {
		t.Fatalf("columns: %+v", report.Columns)
	}
	if report.Overhead <= 0 || report.Total.Disk < total.Data+total.Text {
		t.Fatalf("estimate: overhead %v, disk %d", report.Overhead, report.Total.Disk)
	}
	if report.SessionCount != 3 || report.EmptySessions != 1 || report.ArchivedSessions != 0 || report.Terminals != 4 {
		t.Fatalf("session counts: %+v", report)
	}

	// The list has only sessions with events.
	if len(report.Sessions) != 2 {
		t.Fatalf("sessions: %+v", report.Sessions)
	}
	first, second := report.Sessions[0], report.Sessions[1]
	if first.ID != large.ID || first.Title != "Large" || first.Project != "Orbit" || first.Terminals != 3 || first.Events != 9 {
		t.Fatalf("largest session: %+v", first)
	}
	if !reflect.DeepEqual(first.Tools, []string{"Codex", "Claude"}) {
		t.Fatalf("tools: %v", first.Tools)
	}
	if len(first.Kinds) != 3 || first.Kinds[0].Kind != "output" || first.Kinds[0].Data != 3000 || first.Kinds[0].Text != 1500 {
		t.Fatalf("session kinds: %+v", first.Kinds)
	}
	if second.ID != small.ID || second.ProjectID != "" || !reflect.DeepEqual(second.Tools, []string{""}) {
		t.Fatalf("standalone session: %+v", second)
	}
	if diff := first.Disk + second.Disk - report.Total.Disk; diff < -2 || diff > 2 {
		t.Fatalf("session estimates add up to %d, total %d", first.Disk+second.Disk, report.Total.Disk)
	}

	if len(report.Projects) != 2 || report.Projects[0].ID != project.ID || report.Projects[0].Sessions != 1 || report.Projects[0].Terminals != 3 {
		t.Fatalf("projects: %+v", report.Projects)
	}
	if standalone := report.Projects[1]; standalone.ID != "" || standalone.Sessions != 2 || standalone.Events != 2 {
		t.Fatalf("standalone project: %+v", standalone)
	}
	if len(report.Kinds) != 3 || report.Kinds[0].Kind != "output" || report.Kinds[0].Events != 4 {
		t.Fatalf("kinds: %+v", report.Kinds)
	}
	if len(report.Days) != 1 || report.Days[0].Sessions != 2 || report.Days[0].Events != 11 || len(report.Days[0].Day) != len("2006-01-02") {
		t.Fatalf("days: %+v", report.Days)
	}
}

// The read connection limits a value to 1 MiB. The composer accepts larger attachments.
func TestStorageReportCountsAttachmentsLargerThanTheReadValueLimit(t *testing.T) {
	s := testStore(t)
	session := create(t, s)
	attachment := make([]byte, 2<<20)
	storageEvent(t, s, session.ID, "", "attachment", attachment, `{"name":"large.bin"}`)
	report, err := s.StorageReport(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.Total.Data != 2<<20 || len(report.Kinds) != 1 || report.Kinds[0].Kind != "attachment" || report.Sessions[0].Data != 2<<20 {
		t.Fatalf("attachment: %+v", report)
	}
}

// Start events from bbflow 0.0.4 and earlier have no tool. The first terminal then uses
// the tool of the preparation, as the terminal list does. Later terminals do not.
func TestStorageReportUsesThePreparationToolForTheFirstOlderTerminal(t *testing.T) {
	s := testStore(t)
	project, err := s.CreateProject("Orbit", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.CreatePreparation("", t.TempDir(), project.ID, Preparation{ToolName: "Fixture Tool"})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		storageEvent(t, s, session.ID, storageRun(t, s, session.ID), "start", []byte(`{"cols":80}`), "")
	}
	report, err := s.StorageReport(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Sessions) != 1 || !reflect.DeepEqual(report.Sessions[0].Tools, []string{"Fixture Tool", ""}) {
		t.Fatalf("tools: %+v", report.Sessions)
	}
}

// The reply lists the top sessions only, so its size does not grow with the archive.
func TestStorageReportListsOnlyTheLargestSessions(t *testing.T) {
	s := testStore(t)
	projects := []string{""}
	for _, name := range []string{"A", "B", "C", "D"} {
		project, err := s.CreateProject(name, t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		projects = append(projects, project.ID)
	}
	type fixture struct {
		id, project string
		events      int
	}
	var fixtures []fixture
	for i := 1; i <= 60; i++ {
		project := projects[(i*7)%len(projects)]
		session, err := s.CreateSession("", t.TempDir(), project)
		if err != nil {
			t.Fatal(err)
		}
		// Each session has a different event count, so the expected order is clear.
		for range i {
			storageEvent(t, s, session.ID, "", "output", []byte("0123456789"), "")
		}
		fixtures = append(fixtures, fixture{session.ID, project, i})
	}
	report, err := s.StorageReport(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.SessionCount != 60 || report.EmptySessions != 0 {
		t.Fatalf("counts: %+v", report)
	}
	slices.SortFunc(fixtures, func(a, b fixture) int { return cmp.Compare(b.events, a.events) })
	ids := func(items []fixture) []string {
		var result []string
		for _, item := range items {
			result = append(result, item.id)
		}
		return result
	}
	var listed []string
	for _, item := range report.Sessions {
		listed = append(listed, item.ID)
	}
	if !reflect.DeepEqual(listed[:StorageTopSessions], ids(fixtures[:StorageTopSessions])) {
		t.Fatalf("top sessions %v, want %v", listed[:StorageTopSessions], ids(fixtures[:StorageTopSessions]))
	}
	want := map[string]bool{}
	for _, id := range ids(fixtures[:StorageTopSessions]) {
		want[id] = true
	}
	for _, project := range report.Projects[:StorageTopProjects] {
		var expected, got []string
		for _, item := range fixtures {
			if item.project == project.ID && len(expected) < StorageProjectSessions {
				expected = append(expected, item.id)
				want[item.id] = true
			}
		}
		for _, item := range report.Sessions {
			if item.ProjectID == project.ID && len(got) < StorageProjectSessions {
				got = append(got, item.ID)
			}
		}
		if !reflect.DeepEqual(got, expected) {
			t.Fatalf("project %q sessions %v, want %v", project.Name, got, expected)
		}
	}
	if len(report.Sessions) != len(want) {
		t.Fatalf("listed %d sessions, want %d", len(report.Sessions), len(want))
	}
	encoded, err := json.Marshal(report)
	if err != nil || len(encoded) > 64<<10 {
		t.Fatalf("reply has %d bytes: %v", len(encoded), err)
	}
}

func TestStorageReportStopsWhenCancelled(t *testing.T) {
	s := testStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.StorageReport(ctx); err == nil {
		t.Fatal("a cancelled report succeeded")
	}
}
