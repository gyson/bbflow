package history

import (
	"cmp"
	"context"
	"errors"
	"io/fs"
	"math"
	"os"
	"slices"
	"time"

	"github.com/ncruces/go-sqlite3"
)

// A storage report reads every event row once. A 1.4 GB archive took about 13 seconds.
const StorageReportTimeout = 10 * time.Minute

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
	Tools     []string `json:"tools"` // The tool of each start event, in start order, without repeats.
	StorageUsage
	Kinds []StorageKind `json:"kinds"`
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
	Format    int              `json:"format"`
	SQLite    string           `json:"sqlite"`
	PageSize  int64            `json:"pageSize"`
	Pages     int64            `json:"pages"`
	FreePages int64            `json:"freePages"`
	WAL       int64            `json:"wal"` // The size of the write-ahead log file.
	Overhead  float64          `json:"overhead"`
	Total     StorageUsage     `json:"total"`
	Columns   StorageColumns   `json:"columns"`
	Kinds     []StorageKind    `json:"kinds"`    // Largest first.
	Days      []StorageDay     `json:"days"`     // Oldest first.
	Projects  []StorageProject `json:"projects"` // Largest first.
	Sessions  []StorageSession `json:"sessions"` // Largest first.
}

// Used returns the bytes in pages that are not free.
func (r StorageReport) Used() int64 { return (r.Pages - r.FreePages) * r.PageSize }

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

	sessions := map[string]*StorageSession{}
	session := func(id string) *StorageSession {
		if sessions[id] == nil {
			// Events of a session row that no longer exists still use space.
			sessions[id] = &StorageSession{ID: id, Title: "(missing session)"}
		}
		return sessions[id]
	}
	err = each(conn, `SELECT s.id, s.title, s.auto_title, s.created, s.archived,
        coalesce(s.project_id,''), coalesce(p.name,'')
        FROM sessions AS s LEFT JOIN projects AS p ON p.id=s.project_id`, func(stmt *sqlite3.Stmt) {
		item := Session{Title: stmt.ColumnText(1), AutoTitle: stmt.ColumnText(2)}
		sessions[stmt.ColumnText(0)] = &StorageSession{
			ID: stmt.ColumnText(0), Title: item.DisplayTitle(), Created: stmt.ColumnText(3),
			Archived: stmt.ColumnBool(4), ProjectID: stmt.ColumnText(5), Project: stmt.ColumnText(6),
		}
	})
	if err != nil {
		return report, err
	}
	err = each(conn, "SELECT session_id, count(*) FROM runs GROUP BY session_id", func(stmt *sqlite3.Stmt) {
		session(stmt.ColumnText(0)).Terminals = stmt.ColumnInt(1)
	})
	if err != nil {
		return report, err
	}
	err = each(conn, "SELECT session_id, data FROM events WHERE kind='start' ORDER BY seq", func(stmt *sqlite3.Stmt) {
		item := session(stmt.ColumnText(0))
		if tool := RunTool(stmt.ColumnRawBlob(1), false, nil); !slices.Contains(item.Tools, tool) {
			item.Tools = append(item.Tools, tool)
		}
	})
	if err != nil {
		return report, err
	}

	// One scan of all events. The groups are small, so the remaining work is in memory.
	type group struct {
		session, kind, day string
		usage              StorageUsage
	}
	var groups []group
	err = each(conn, `SELECT session_id, kind, substr(created,1,10), count(*),
        sum(octet_length(data)), sum(octet_length(text)), sum(octet_length(run_id)), sum(octet_length(created))
        FROM events GROUP BY 1,2,3`, func(stmt *sqlite3.Stmt) {
		item := group{session: stmt.ColumnText(0), kind: stmt.ColumnText(1), day: stmt.ColumnText(2),
			usage: StorageUsage{Events: stmt.ColumnInt64(3), Data: stmt.ColumnInt64(4), Text: stmt.ColumnInt64(5)}}
		groups = append(groups, item)
		report.Columns.SessionID += item.usage.Events * int64(len(item.session))
		report.Columns.Kind += item.usage.Events * int64(len(item.kind))
		report.Columns.RunID += stmt.ColumnInt64(6)
		report.Columns.Created += stmt.ColumnInt64(7)
	})
	if err != nil {
		return report, err
	}
	for _, item := range groups {
		report.Total.add(item.usage)
	}
	report.Columns.Data, report.Columns.Text = report.Total.Data, report.Total.Text
	if report.Total.Events > 0 {
		report.Overhead = math.Max(float64(report.Used()-report.Total.Data-report.Total.Text), 0) / float64(report.Total.Events)
	}
	estimate := func(usage *StorageUsage) {
		usage.Disk = usage.Data + usage.Text + int64(math.Round(float64(usage.Events)*report.Overhead))
	}
	estimate(&report.Total)

	kinds := map[string]*StorageKind{}
	days := map[string]*StorageDay{}
	sessionKinds := map[[2]string]*StorageKind{}
	sessionDays := map[[2]string]bool{}
	for _, item := range groups {
		if kinds[item.kind] == nil {
			kinds[item.kind] = &StorageKind{Kind: item.kind}
		}
		kinds[item.kind].add(item.usage)
		if days[item.day] == nil {
			days[item.day] = &StorageDay{Day: item.day}
		}
		days[item.day].add(item.usage)
		if key := [2]string{item.session, item.day}; !sessionDays[key] {
			sessionDays[key] = true
			days[item.day].Sessions++
		}
		session(item.session).add(item.usage)
		key := [2]string{item.session, item.kind}
		if sessionKinds[key] == nil {
			sessionKinds[key] = &StorageKind{Kind: item.kind}
		}
		sessionKinds[key].add(item.usage)
	}
	for key, item := range sessionKinds {
		estimate(&item.StorageUsage)
		sessions[key[0]].Kinds = append(sessions[key[0]].Kinds, *item)
	}
	for _, item := range kinds {
		estimate(&item.StorageUsage)
		report.Kinds = append(report.Kinds, *item)
	}
	for _, item := range days {
		estimate(&item.StorageUsage)
		report.Days = append(report.Days, *item)
	}
	projects := map[string]*StorageProject{}
	for _, item := range sessions {
		estimate(&item.StorageUsage)
		slices.SortFunc(item.Kinds, func(a, b StorageKind) int { return byDisk(a.StorageUsage, b.StorageUsage, a.Kind, b.Kind) })
		report.Sessions = append(report.Sessions, *item)
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
	slices.SortFunc(report.Sessions, func(a, b StorageSession) int { return byDisk(a.StorageUsage, b.StorageUsage, a.ID, b.ID) })
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
