package history

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"os"
	"slices"
	"time"

	"github.com/ncruces/go-sqlite3"
)

// A storage report reads every event row once. A 1.4 GB archive took about 2 seconds.
const StorageReportTimeout = 10 * time.Minute

// The report lists the largest sessions only. These limits keep the reply small for
// any number of sessions.
const (
	StorageTopSessions     = 10 // The largest sessions of the archive.
	StorageTopProjects     = 3  // The projects that list their own largest sessions.
	StorageProjectSessions = 5  // The largest sessions of each of those projects.
)

// StorageUsage counts event rows. Data and Text are exact byte counts of those columns.
// Disk is an estimate. See StorageReport.Overhead.
type StorageUsage struct {
	Events int64 `json:"events"`
	Data   int64 `json:"data"`
	Text   int64 `json:"text"`
	Disk   int64 `json:"disk"`
}

type StorageKind struct {
	Kind string `json:"kind"`
	StorageUsage
}

// StorageDay groups events by the UTC date of their created time.
type StorageDay struct {
	Day      string `json:"day"`
	Sessions int    `json:"sessions"`
	StorageUsage
}

// StorageProject has an empty ID for standalone sessions.
type StorageProject struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Sessions  int    `json:"sessions"`
	Terminals int    `json:"terminals"`
	StorageUsage
}

type StorageSession struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	ProjectID string   `json:"projectId"`
	Project   string   `json:"project"`
	Created   string   `json:"created"`
	Archived  bool     `json:"archived"`
	Terminals int      `json:"terminals"`
	Tools     []string `json:"tools"` // The tool of each terminal, in start order, without repeats.
	StorageUsage
	Kinds []StorageKind `json:"kinds"` // Largest first.
}

// StorageColumns has the exact byte count of each events column.
type StorageColumns struct {
	SessionID int64 `json:"sessionId"`
	RunID     int64 `json:"runId"`
	Kind      int64 `json:"kind"`
	Created   int64 `json:"created"`
	Data      int64 `json:"data"`
	Text      int64 `json:"text"`
}

// StorageReport describes the storage use of the archive at one read snapshot.
// SQLite does not record which pages belong to a session. Thus Disk values are
// estimates: Data + Text + Events × Overhead. Overhead is the used space of the
// database, less all data and text bytes, divided by the number of events. The
// estimates add up to about the used space.
type StorageReport struct {
	Format    int            `json:"format"`
	SQLite    string         `json:"sqlite"`
	PageSize  int64          `json:"pageSize"`
	Pages     int64          `json:"pages"`
	FreePages int64          `json:"freePages"`
	WAL       int64          `json:"wal"` // The size of the write-ahead log file.
	Overhead  float64        `json:"overhead"`
	Total     StorageUsage   `json:"total"`
	Columns   StorageColumns `json:"columns"`

	SessionCount     int `json:"sessionCount"`
	ArchivedSessions int `json:"archivedSessions"`
	EmptySessions    int `json:"emptySessions"` // Sessions with no events.
	Terminals        int `json:"terminals"`

	Kinds    []StorageKind    `json:"kinds"`    // Largest first.
	Days     []StorageDay     `json:"days"`     // Oldest first.
	Projects []StorageProject `json:"projects"` // Largest first.
	// Sessions has the StorageTopSessions largest sessions with events, and the
	// StorageProjectSessions largest sessions with events of each of the
	// StorageTopProjects largest projects. Largest first. Thus the first entries are the
	// largest sessions of the archive. The entries of one project, in order, are the
	// largest sessions of that project.
	Sessions []StorageSession `json:"sessions"`
}

// Used returns the bytes in pages that are not free.
func (r StorageReport) Used() int64 { return (r.Pages - r.FreePages) * r.PageSize }

type storageSession struct {
	StorageSession
	firstRun    string // The first run in run order. Its tool can come from the preparation.
	preparation *Preparation
	kinds       []*StorageKind
}

type storageDay struct {
	StorageDay
	sessions map[string]bool
}

// StorageReport reads the archive with a separate read-only connection. It does not
// block capture. It never reads terminal content into the report.
func (s *Store) StorageReport(ctx context.Context) (report StorageReport, err error) {
	ctx, cancel := context.WithTimeout(ctx, StorageReportTimeout)
	defer cancel()
	conn, err := s.readConnection(ctx)
	if err != nil {
		return report, err
	}
	defer conn.Close()
	// One read transaction gives page counts and event totals from the same snapshot.
	if err = conn.Exec("BEGIN"); err != nil {
		return report, err
	}
	defer conn.Exec("ROLLBACK")
	if info, err := os.Stat(s.Path + "-wal"); err == nil {
		report.WAL = info.Size()
	} else if !errors.Is(err, fs.ErrNotExist) {
		return report, err
	}
	err = each(conn, `SELECT (SELECT user_version FROM pragma_user_version), sqlite_version(),
        (SELECT page_size FROM pragma_page_size), (SELECT page_count FROM pragma_page_count),
        (SELECT freelist_count FROM pragma_freelist_count)`, func(stmt *sqlite3.Stmt) {
		report.Format, report.SQLite = stmt.ColumnInt(0), stmt.ColumnText(1)
		report.PageSize, report.Pages, report.FreePages = stmt.ColumnInt64(2), stmt.ColumnInt64(3), stmt.ColumnInt64(4)
	})
	if err != nil {
		return report, err
	}

	sessions := map[string]*storageSession{}
	session := func(id []byte) *storageSession {
		// The conversion in this map index does not allocate.
		if item := sessions[string(id)]; item != nil {
			return item
		}
		// Events of a session row that no longer exists still use space.
		item := &storageSession{StorageSession: StorageSession{ID: string(id), Title: "(missing session)"}}
		sessions[item.ID] = item
		return item
	}
	err = each(conn, `SELECT s.id, s.title, s.auto_title, s.created, s.archived,
        coalesce(s.project_id,''), coalesce(p.name,'')
        FROM sessions AS s LEFT JOIN projects AS p ON p.id=s.project_id`, func(stmt *sqlite3.Stmt) {
		item := Session{Title: stmt.ColumnText(1), AutoTitle: stmt.ColumnText(2)}
		sessions[stmt.ColumnText(0)] = &storageSession{StorageSession: StorageSession{
			ID: stmt.ColumnText(0), Title: item.DisplayTitle(), Created: stmt.ColumnText(3),
			Archived: stmt.ColumnBool(4), ProjectID: stmt.ColumnText(5), Project: stmt.ColumnText(6),
		}}
	})
	if err != nil {
		return report, err
	}
	err = each(conn, "SELECT session_id, id FROM runs ORDER BY rowid", func(stmt *sqlite3.Stmt) {
		item := session(stmt.ColumnRawText(0))
		if item.Terminals == 0 {
			item.firstRun = stmt.ColumnText(1)
		}
		item.Terminals++
	})
	if err != nil {
		return report, err
	}
	// Start events from bbflow 0.0.4 and earlier have no tool. The terminal list then
	// uses the preparation for the first run. The report does the same.
	err = each(conn, "SELECT session_id, data FROM preparations", func(stmt *sqlite3.Stmt) {
		var preparation Preparation
		if json.Unmarshal(stmt.ColumnRawText(1), &preparation) == nil {
			session(stmt.ColumnRawText(0)).preparation = &preparation
		}
	})
	if err != nil {
		return report, err
	}

	// One plain scan of all events, in sequence order. The lengths come from the record
	// headers, so SQLite does not read or copy the payloads. Only start events return
	// their small data and run ID.
	kinds := map[string]*StorageKind{}
	days := map[string]*storageDay{}
	err = each(conn, `SELECT session_id, kind, created, octet_length(run_id), octet_length(data), octet_length(text),
        CASE WHEN kind='start' THEN run_id END, CASE WHEN kind='start' THEN data END FROM events`, func(stmt *sqlite3.Stmt) {
		id, kind, created := stmt.ColumnRawText(0), stmt.ColumnRawText(1), stmt.ColumnRawText(2)
		usage := StorageUsage{Events: 1, Data: stmt.ColumnInt64(4), Text: stmt.ColumnInt64(5)}
		report.Columns.SessionID += int64(len(id))
		report.Columns.Kind += int64(len(kind))
		report.Columns.Created += int64(len(created))
		report.Columns.RunID += stmt.ColumnInt64(3)
		report.Total.add(usage)

		item := session(id)
		item.add(usage)
		var current *StorageKind
		for _, other := range item.kinds {
			if other.Kind == string(kind) {
				current = other
				break
			}
		}
		if current == nil {
			current = &StorageKind{Kind: string(kind)}
			item.kinds = append(item.kinds, current)
		}
		current.add(usage)
		if kinds[string(kind)] == nil {
			kinds[string(kind)] = &StorageKind{Kind: string(kind)}
		}
		kinds[string(kind)].add(usage)
		day := created[:min(len(created), len("2006-01-02"))]
		if days[string(day)] == nil {
			days[string(day)] = &storageDay{StorageDay: StorageDay{Day: string(day)}, sessions: map[string]bool{}}
		}
		days[string(day)].add(usage)
		if !days[string(day)].sessions[string(id)] {
			days[string(day)].sessions[item.ID] = true
		}

		if bytes.Equal(kind, []byte("start")) {
			first := stmt.ColumnText(6) == item.firstRun
			if tool := RunTool(stmt.ColumnRawBlob(7), first, item.preparation); !slices.Contains(item.Tools, tool) {
				item.Tools = append(item.Tools, tool)
			}
		}
	})
	if err != nil {
		return report, err
	}
	report.Columns.Data, report.Columns.Text = report.Total.Data, report.Total.Text
	if report.Total.Events > 0 {
		report.Overhead = math.Max(float64(report.Used()-report.Total.Data-report.Total.Text), 0) / float64(report.Total.Events)
	}
	estimate := func(usage *StorageUsage) {
		usage.Disk = usage.Data + usage.Text + int64(math.Round(float64(usage.Events)*report.Overhead))
	}
	estimate(&report.Total)

	for _, item := range kinds {
		estimate(&item.StorageUsage)
		report.Kinds = append(report.Kinds, *item)
	}
	for _, item := range days {
		estimate(&item.StorageUsage)
		item.Sessions = len(item.sessions)
		report.Days = append(report.Days, item.StorageDay)
	}
	projects := map[string]*StorageProject{}
	recorded := make([]*storageSession, 0, len(sessions))
	for _, item := range sessions {
		estimate(&item.StorageUsage)
		report.SessionCount++
		report.Terminals += item.Terminals
		if item.Archived {
			report.ArchivedSessions++
		}
		if item.Events == 0 {
			report.EmptySessions++
		} else {
			recorded = append(recorded, item)
		}
		if projects[item.ProjectID] == nil {
			projects[item.ProjectID] = &StorageProject{ID: item.ProjectID, Name: item.Project}
		}
		project := projects[item.ProjectID]
		project.Sessions++
		project.Terminals += item.Terminals
		project.add(item.StorageUsage)
	}
	for _, item := range projects {
		estimate(&item.StorageUsage)
		report.Projects = append(report.Projects, *item)
	}
	slices.SortFunc(report.Kinds, func(a, b StorageKind) int { return byDisk(a.StorageUsage, b.StorageUsage, a.Kind, b.Kind) })
	slices.SortFunc(report.Days, func(a, b StorageDay) int { return cmp.Compare(a.Day, b.Day) })
	slices.SortFunc(report.Projects, func(a, b StorageProject) int { return byDisk(a.StorageUsage, b.StorageUsage, a.ID, b.ID) })
	slices.SortFunc(recorded, func(a, b *storageSession) int { return byDisk(a.StorageUsage, b.StorageUsage, a.ID, b.ID) })

	// Keep the largest sessions of the archive and of each top project. Each kept session
	// is larger than the sessions that are not kept in its list, so the order of the
	// kept sessions also gives each list.
	top := map[string]int{}
	for _, project := range report.Projects[:min(StorageTopProjects, len(report.Projects))] {
		top[project.ID] = StorageProjectSessions
	}
	for i, item := range recorded {
		if i >= StorageTopSessions && top[item.ProjectID] == 0 {
			continue
		}
		if top[item.ProjectID] > 0 {
			top[item.ProjectID]--
		}
		for _, kind := range item.kinds {
			estimate(&kind.StorageUsage)
			item.Kinds = append(item.Kinds, *kind)
		}
		slices.SortFunc(item.Kinds, func(a, b StorageKind) int { return byDisk(a.StorageUsage, b.StorageUsage, a.Kind, b.Kind) })
		report.Sessions = append(report.Sessions, item.StorageSession)
	}
	return report, ctx.Err()
}

func (u *StorageUsage) add(other StorageUsage) {
	u.Events += other.Events
	u.Data += other.Data
	u.Text += other.Text
}

// byDisk orders the largest estimate first. A tie uses the name, for a stable report.
func byDisk(a, b StorageUsage, aName, bName string) int {
	return cmp.Or(cmp.Compare(b.Disk, a.Disk), cmp.Compare(b.Events, a.Events), cmp.Compare(aName, bName))
}

func each(conn *sqlite3.Conn, query string, row func(*sqlite3.Stmt)) error {
	stmt, _, err := conn.Prepare(query)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for stmt.Step() {
		row(stmt)
	}
	return stmt.Err()
}
