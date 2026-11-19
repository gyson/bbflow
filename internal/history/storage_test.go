package history

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

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
	empty := create(t, s)
	add := func(sid, rid, kind string, data []byte, text string) {
		t.Helper()
		if _, err := s.Append(sid, rid, kind, data, text); err != nil {
			t.Fatal(err)
		}
	}
	for _, tool := range []string{"Codex", "Codex", "Claude"} {
		run, err := s.NewRun(large.ID)
		if err != nil {
			t.Fatal(err)
		}
		add(large.ID, run.ID, "start", []byte(`{"tool":"`+tool+`"}`), "")
		add(large.ID, run.ID, "output", []byte(strings.Repeat("o", 1000)), strings.Repeat("t", 500))
		add(large.ID, run.ID, "input", []byte("k"), "")
	}
	run, err := s.NewRun(small.ID)
	if err != nil {
		t.Fatal(err)
	}
	add(small.ID, run.ID, "start", []byte(`{"cols":80}`), "")
	add(small.ID, run.ID, "output", []byte("hello"), "hello")

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
	if report.Columns.SessionID != 11*32 || report.Columns.RunID != 11*32 || report.Columns.Data != total.Data || report.Columns.Text != total.Text {
		t.Fatalf("columns: %+v", report.Columns)
	}
	if report.Overhead <= 0 || report.Total.Disk < total.Data+total.Text {
		t.Fatalf("estimate: overhead %v, disk %d", report.Overhead, report.Total.Disk)
	}

	if len(report.Sessions) != 3 {
		t.Fatalf("sessions: %+v", report.Sessions)
	}
	first, second, third := report.Sessions[0], report.Sessions[1], report.Sessions[2]
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
	if third.ID != empty.ID || third.Events != 0 || third.Disk != 0 || len(third.Kinds) != 0 {
		t.Fatalf("empty session: %+v", third)
	}
	var sum int64
	for _, item := range report.Sessions {
		sum += item.Disk
	}
	if diff := sum - report.Total.Disk; diff < -3 || diff > 3 {
		t.Fatalf("session estimates add up to %d, total %d", sum, report.Total.Disk)
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

func TestStorageReportStopsWhenCancelled(t *testing.T) {
	s := testStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.StorageReport(ctx); err == nil {
		t.Fatal("a cancelled report succeeded")
	}
}
