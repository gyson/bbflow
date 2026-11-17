package history

import (
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
)

type ListedSession struct {
	Session
	Updated string
}

// SessionFilter selects sessions for the sidebar. Sessions form one group for each saved
// project. Sessions without a saved project form the Standalone group, with the key "".
type SessionFilter struct {
	Limit    int            // The number of sessions in each group. Zero selects 10.
	Limits   map[string]int // Limits for specified groups, by group key. They replace Limit.
	Include  string         // A session ID to list outside its group limit, if it matches.
	Archived bool
	Query    string
}

// SessionPage lists the most recent matching sessions of each group, most recent first.
// More holds the keys of the groups that have more matching sessions.
type SessionPage struct {
	Sessions []ListedSession
	More     []string
}

// ListSessions orders sessions by terminal input, output, and run lifecycle activity.
// This includes output while detached. View changes and unsent drafts do not count.
// SQLite compares these times in whole milliseconds. For equal times, the event sequence
// and then the creation order decide. The rowid keeps the creation order.
// Search and archive filters apply before the group limits, including to old sessions.
func (s *Store) ListSessions(filter SessionFilter) (SessionPage, error) {
	if filter.Limit == 0 {
		filter.Limit = 10
	}
	// A group limit has no upper bound, so Show more can reach each session of a group.
	// A result never has more rows than the matching sessions.
	valid := filter.Limit >= 1 && len(filter.Include) <= 200 && len(filter.Query) <= 800
	for key, limit := range filter.Limits {
		valid = valid && len(key) <= 200 && limit >= 1
	}
	if !valid {
		return SessionPage{}, errors.New("invalid session filter: limits must be at least 1, and query at most 800 bytes")
	}
	limits, err := json.Marshal(filter.Limits)
	if err != nil {
		return SessionPage{}, err
	}
	if filter.Limits == nil {
		limits = []byte("{}")
	}
	query := strings.TrimSpace(filter.Query)
	// Each group reads one session more than its limit to report more sessions.
	rows, err := s.db.Query(`WITH listed AS (
            SELECT sessions.id,title,workspace,sessions.created,COALESCE(project_id,'') AS project,archived,
                COALESCE(activity.created,sessions.created) AS updated,COALESCE(activity.seq,0) AS activity,
                sessions.rowid AS creation,
                CASE WHEN EXISTS (SELECT 1 FROM projects WHERE projects.id=project_id) THEN project_id ELSE '' END AS grp
            FROM sessions LEFT JOIN events AS activity ON activity.seq=(
                SELECT seq FROM events WHERE session_id=sessions.id
                AND kind IN ('start','run','input','output','notice') ORDER BY seq DESC LIMIT 1
            )
            WHERE archived=? AND (?='' OR instr(lower(title),lower(?))>0
                OR instr(lower(workspace),lower(?))>0 OR instr(lower(sessions.id),lower(?))>0
                OR EXISTS (SELECT 1 FROM projects WHERE projects.id=project_id
                    AND (instr(lower(projects.name),lower(?))>0 OR instr(lower(projects.workspace),lower(?))>0)))
        ), ranked AS (
            SELECT *,ROW_NUMBER() OVER (PARTITION BY grp ORDER BY julianday(updated) DESC,activity DESC,creation DESC) AS position,
                COALESCE((SELECT value FROM json_each(?) WHERE key=grp),?) AS group_limit
            FROM listed
        )
        SELECT id,title,workspace,created,project,archived,updated,grp,position>group_limit FROM ranked
        WHERE position<=group_limit+1 OR id=?
        ORDER BY julianday(updated) DESC,activity DESC,creation DESC`,
		filter.Archived, query, query, query, query, query, query, string(limits), filter.Limit, filter.Include)
	if err != nil {
		return SessionPage{}, err
	}
	page := SessionPage{Sessions: []ListedSession{}, More: []string{}}
	more := map[string]bool{}
	for rows.Next() {
		var item ListedSession
		var group string
		var beyond bool
		if err = rows.Scan(&item.ID, &item.Title, &item.Workspace, &item.Created, &item.ProjectID, &item.Archived, &item.Updated, &group, &beyond); err != nil {
			rows.Close()
			return SessionPage{}, err
		}
		if beyond {
			more[group] = true
			if item.ID != filter.Include {
				continue
			}
		}
		page.Sessions = append(page.Sessions, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return SessionPage{}, err
	}
	for group := range more {
		page.More = append(page.More, group)
	}
	slices.Sort(page.More)
	for i := range page.Sessions {
		if err = s.launchMetadata(&page.Sessions[i].Session); err != nil {
			return SessionPage{}, err
		}
		page.Sessions[i].Run, err = s.LatestRun(page.Sessions[i].ID)
		if err != nil {
			return SessionPage{}, err
		}
	}
	return page, nil
}

// Archive changes affect visibility only. The transaction also prevents archive changes
// for recorded active runs or an unfinished launch claim.
func (s *Store) SetSessionArchived(id string, archived bool) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if archived {
		var active bool
		err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM runs WHERE session_id=? AND status IN ('starting','running'))
            OR EXISTS(SELECT 1 FROM preparations WHERE session_id=? AND
                (state='creating' OR (state='launched' AND NOT EXISTS(SELECT 1 FROM runs WHERE session_id=?))))`, id, id, id).Scan(&active)
		if err != nil {
			return err
		}
		if active {
			return errors.New("stop the session before archiving it")
		}
	}
	if err = changedRow(tx.Exec("UPDATE sessions SET archived=? WHERE id=?", archived, id)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) Session(id string) (Session, error) {
	session, err := scanSession(s.db.QueryRow("SELECT "+sessionColumns+" FROM sessions WHERE id=?", id))
	if err == nil {
		err = s.launchMetadata(&session)
	}
	if err == nil {
		session.Run, err = s.LatestRun(id)
	}
	return session, err
}

func (s *Store) LatestRun(id string) (*Run, error) {
	r, err := scanRun(s.db.QueryRow("SELECT "+runColumns+" FROM runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1", id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &r, err
}

// RunRecord describes one run of a session. First and Last are the sequence numbers of
// its first and last events, or zero when it has no events. Start holds the data of its
// start event.
type RunRecord struct {
	Run
	First int64
	Last  int64
	Start []byte
}

// Runs returns the runs of a session in start order. A session has one live run at most.
// Later runs continue the same session in a new terminal.
func (s *Store) Runs(sid string) ([]RunRecord, error) {
	rows, err := s.db.Query(runsSQL, sid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []RunRecord
	for rows.Next() {
		var r RunRecord
		if err = rows.Scan(&r.ID, &r.SessionID, &r.Status, &r.Started, &r.Ended, &r.PID, &r.Detail, &r.First, &r.Last, &r.Start); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

const runsSQL = `SELECT runs.id,runs.session_id,status,started,ended,pid,detail,
        COALESCE((SELECT seq FROM events WHERE run_id=runs.id AND session_id=runs.session_id ORDER BY seq LIMIT 1),0),
        COALESCE((SELECT seq FROM events WHERE run_id=runs.id AND session_id=runs.session_id ORDER BY seq DESC LIMIT 1),0),
        COALESCE((SELECT data FROM events WHERE run_id=runs.id AND session_id=runs.session_id AND kind='start' ORDER BY seq LIMIT 1),x'')
        FROM runs WHERE session_id=? ORDER BY rowid`

// RunStart is one run of a session and the data of its start event. Start is empty when
// the run has no start event.
type RunStart struct {
	Run
	Start []byte
}

// RunStarts lists runs in start order. Each start event uses an indexed run lookup.
func (s *Store) RunStarts(sid string) ([]RunStart, error) {
	rows, err := s.db.Query(runStartsSQL, sid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []RunStart
	for rows.Next() {
		var run RunStart
		if err := rows.Scan(&run.ID, &run.SessionID, &run.Status, &run.Started, &run.Ended, &run.PID, &run.Detail, &run.Start); err != nil {
			return nil, err
		}
		result = append(result, run)
	}
	return result, rows.Err()
}

const runStartsSQL = `SELECT ` + runColumns + `,
        COALESCE((SELECT data FROM events WHERE run_id=runs.id AND session_id=runs.session_id AND kind='start' ORDER BY seq LIMIT 1),x'')
        FROM runs WHERE session_id=? ORDER BY rowid`

// SessionRun returns one run of a session. It returns ErrRunNotFound when the session
// has no run with this ID.
func (s *Store) SessionRun(sid, id string) (Run, error) {
	r, err := scanRun(s.db.QueryRow("SELECT "+runColumns+" FROM runs WHERE id=? AND session_id=?", id, sid))
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrRunNotFound
	}
	return r, err
}

func (s *Store) CreateSession(title, workspace, projectID string) (Session, error) {
	session := Session{ID: ID(), Title: title, Workspace: workspace, Created: Now(), ProjectID: projectID}
	_, err := s.db.Exec("INSERT INTO sessions(id,title,workspace,created,project_id) VALUES(?,?,?,?,NULLIF(?,''))", session.ID, session.Title, session.Workspace, session.Created, projectID)
	return session, err
}

func (s *Store) NewRun(sid string) (*Run, error) {
	r := &Run{ID: ID(), SessionID: sid, Status: "starting", Started: Now()}
	_, err := s.db.Exec("INSERT INTO runs(id,session_id,status,started) VALUES(?,?,?,?)", r.ID, sid, r.Status, r.Started)
	return r, err
}

func (s *Store) SaveRun(r *Run) error {
	_, err := s.db.Exec("UPDATE runs SET status=?,ended=?,pid=?,detail=? WHERE id=?", r.Status, r.Ended, r.PID, r.Detail, r.ID)
	return err
}

// MarkInterrupted runs once at server startup, before the server accepts session
// requests. Missing exits remain unknown. This changes only history metadata. It does
// not change process state.
func (s *Store) MarkInterrupted() error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := Now()
	if _, err = tx.Exec("UPDATE preparations SET state='interrupted' WHERE state IN ('creating','launched') AND session_id NOT IN (SELECT session_id FROM runs)"); err != nil {
		return err
	}
	detail := "Run has no recorded exit. Process state is unknown."
	if _, err = tx.Exec(`INSERT INTO events(session_id,run_id,kind,data,text,created)
        SELECT session_id,id,'notice',?,'',? FROM runs WHERE status IN ('starting','running')`, []byte(detail), now); err != nil {
		return err
	}
	if _, err = tx.Exec(`UPDATE runs SET status='interrupted',ended=?,detail=?
        WHERE status IN ('starting','running')`, now, detail); err != nil {
		return err
	}
	return tx.Commit()
}

// RunTool reads a recorded tool name. The first run uses its preparation when older
// start events have no tool name.
func RunTool(start []byte, first bool, preparation *Preparation) string {
	var event struct {
		Tool string `json:"tool"`
	}
	if len(start) > 0 {
		json.Unmarshal(start, &event)
	}
	if event.Tool == "" && first && preparation != nil {
		return preparation.ToolName
	}
	return event.Tool
}
