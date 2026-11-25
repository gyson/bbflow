package history

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

// ListedSession is a session in a sidebar page. Context is true for a top-level session
// that shows only as the parent of listed sub-sessions: it is not in the archive
// collection of the page, or it does not match the search.
type ListedSession struct {
	Session
	Updated string
	Context bool
}

// SessionFilter selects sessions for the sidebar. Sessions form one group for each saved
// project. Sessions without a saved project form the Standalone group, with the key "".
// In the list that is not archived, pinned families form the Pinned group, with the key
// PinnedGroup, and they are not in the group of their project. A family is a top-level
// session and its sub-sessions. The page lists the most recent families of each selected
// group. With Offset, the page lists one window of one group.
type SessionFilter struct {
	Limit    int      // The number of families in each group. Zero selects 10.
	Groups   []string // The group keys to list. Nil selects all groups.
	Offset   int      // The families to skip. It needs exactly one group.
	Include  string   // A session ID whose family is listed outside its group limit. It needs no Offset.
	Archived bool
	Query    string
	// Bounds keeps output out of the order until its quiet flag is final. Nil counts all
	// output.
	Bounds *OutputBounds
}

// OutputBounds keeps output out of the session order until its quiet flag is final. The
// server records output before it sets the flag. The output of a session counts up to
// its Classified sequence, or up to Recorded when it has no entry.
type OutputBounds struct {
	// Recorded is the latest event sequence before the server read Classified, or 0 when
	// the archive had no event.
	Recorded int64
	// Classified gives, for a live terminal, the sequence of the latest event whose quiet
	// flag is final.
	Classified map[string]int64
}

// SessionPage lists matching families, most recent first. Each family lists its
// top-level session first, then its sub-sessions in creation order. More holds the keys
// of the groups that have more matching families after the listed ones.
type SessionPage struct {
	Sessions []ListedSession
	More     []string
}

// MaxSessionLimit keeps each reply small. Limit times the number of groups must not be
// larger. More families need more pages.
const MaxSessionLimit = 100

// PinnedGroup is the group key of the pinned families. A project ID is hexadecimal, so
// it cannot be this key.
const PinnedGroup = "pinned"

// MaxPinned is the largest number of pinned sessions. Thus one page with this limit lists
// the whole Pinned group.
const MaxPinned = 20

// pinFormat gives each pin time the same width in UTC. Thus the text order of the times
// is their time order, in nanoseconds. Two pins in one millisecond keep their order.
const pinFormat = "2006-01-02T15:04:05.000000000Z07:00"

// ListSessions orders families by the terminal input, output, and run lifecycle activity
// of their members in the archive collection. This includes output while detached. View
// changes, quiet events, unsent drafts, and output after its OutputBounds do not count.
// SQLite compares these times in whole
// milliseconds. For equal times, the event sequence and then the creation order decide.
// The rowid keeps the creation order. The Pinned group orders its families by the time
// of the pin, newest first, and activity does not change that order. Search and archive filters apply to each member
// before the group limits, including to old sessions. A family is listed when one of its
// members in the collection matches. A match of the top-level session lists all members
// in the collection. Otherwise the top-level session shows as context for the matching
// sub-sessions. A sub-session in the collection can thus list a top-level session from
// the other collection.
func (s *Store) ListSessions(filter SessionFilter) (SessionPage, error) {
	if filter.Limit == 0 {
		filter.Limit = 10
	}
	// Division keeps the check free of integer overflow.
	valid := filter.Limit >= 1 && filter.Limit <= MaxSessionLimit/max(1, len(filter.Groups)) && filter.Offset >= 0 &&
		(filter.Offset == 0 || (len(filter.Groups) == 1 && filter.Include == "")) &&
		len(filter.Include) <= 200 && len(filter.Query) <= 800
	for _, group := range filter.Groups {
		valid = valid && len(group) <= 200
	}
	if !valid {
		return SessionPage{}, errors.New("invalid session filter: limit times groups must be 1–100, offset needs one group and no include, and query must be at most 800 bytes")
	}
	groups, err := json.Marshal(filter.Groups)
	if err != nil {
		return SessionPage{}, err
	}
	// Without bounds, a NULL recorded bound counts all output.
	var recorded any
	classified := []byte("{}")
	if filter.Bounds != nil {
		recorded = filter.Bounds.Recorded
		if filter.Bounds.Classified != nil {
			if classified, err = json.Marshal(filter.Bounds.Classified); err != nil {
				return SessionPage{}, err
			}
		}
	}
	// Each group reads one family more than its limit to report more families.
	rows, err := s.db.Query(listSessionsSQL, filter.Archived, strings.TrimSpace(filter.Query), filter.Offset, filter.Limit,
		filter.Groups == nil, string(groups), filter.Include, string(classified), recorded)
	if err != nil {
		return SessionPage{}, err
	}
	type listedRow struct {
		item   ListedSession
		group  string
		beyond bool
	}
	var listed []listedRow
	included := ""
	for rows.Next() {
		var row listedRow
		item := &row.item
		if err = rows.Scan(&item.ID, &item.Title, &item.AutoTitle, &item.Workspace, &item.Created, &item.ProjectID, &item.Archived,
			&item.Updated, &item.ParentID, &item.Pinned, &item.Context, &row.group, &row.beyond); err != nil {
			rows.Close()
			return SessionPage{}, err
		}
		if item.ID == filter.Include {
			included = family(item.Session)
		}
		listed = append(listed, row)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return SessionPage{}, err
	}
	page := SessionPage{Sessions: []ListedSession{}, More: []string{}}
	more := map[string]bool{}
	for _, row := range listed {
		if row.beyond {
			more[row.group] = true
			if included == "" || family(row.item.Session) != included {
				continue
			}
		}
		page.Sessions = append(page.Sessions, row.item)
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

// family returns the ID of the top-level session of the family of a session.
func family(session Session) string {
	if session.ParentID != "" {
		return session.ParentID
	}
	return session.ID
}

// The parameters are ?1 archived, ?2 query, ?3 offset, ?4 limit, ?5 all groups, ?6 the
// group keys as JSON, and ?7 the included session ID.
//
// listed holds the sessions of the collection and the top-level sessions of its
// sub-sessions. A member is in the collection and matches, or its top-level session
// matches. A family with a member is listed. Its latest member in the collection gives
// its position in its group. The top-level session always shows with a listed family.
// In the list that is not archived, a pinned top-level session puts its family in the
// Pinned group. There, the time of the pin gives the position. pin is NULL in the other
// groups, so it does not change their order. pinFormat makes the text order exact.
const listSessionsSQL = `WITH listed AS (
        SELECT sessions.id,title,auto_title,workspace,sessions.created,COALESCE(project_id,'') AS project,archived,
            COALESCE(parent_id,'') AS parent,COALESCE(parent_id,sessions.id) AS family,
            COALESCE(activity.created,sessions.created) AS updated,julianday(COALESCE(activity.created,sessions.created)) AS day,
            COALESCE(activity.seq,0) AS activity,sessions.rowid AS creation,pinned_at IS NOT NULL AS pinned,
            CASE WHEN NOT ?1 THEN pinned_at END AS pin,
            CASE WHEN NOT ?1 AND pinned_at IS NOT NULL THEN '` + PinnedGroup + `'
                WHEN EXISTS (SELECT 1 FROM projects WHERE projects.id=project_id) THEN project_id ELSE '' END AS grp,
            archived=?1 AS shown,
            (?2='' OR instr(lower(title),lower(?2))>0 OR instr(lower(auto_title),lower(?2))>0
                OR instr(lower(workspace),lower(?2))>0 OR instr(lower(sessions.id),lower(?2))>0
                OR EXISTS (SELECT 1 FROM projects WHERE projects.id=project_id
                    AND (instr(lower(projects.name),lower(?2))>0 OR instr(lower(projects.workspace),lower(?2))>0))) AS hit
        FROM sessions LEFT JOIN json_each(?8) AS classified ON classified.key=sessions.id
        LEFT JOIN events AS activity ON activity.seq=(
            SELECT seq FROM events WHERE session_id=sessions.id
            AND kind IN ('start','run','input','output','notice') AND quiet=0
            AND (kind<>'output' OR seq<=COALESCE(classified.value,?9,seq)) ORDER BY seq DESC LIMIT 1
        )
        WHERE archived=?1 OR sessions.id IN (SELECT parent_id FROM sessions WHERE archived=?1 AND parent_id IS NOT NULL)
    ), members AS (
        SELECT *,shown AND (hit OR MAX(parent='' AND hit) OVER (PARTITION BY family)) AS member FROM listed
    ), ranked AS (
        SELECT *,MAX(member) OVER (PARTITION BY family) AS listed_family,
            MAX(CASE WHEN parent='' THEN grp END) OVER (PARTITION BY family) AS family_group,
            MAX(CASE WHEN parent='' THEN pin END) OVER (PARTITION BY family) AS family_pin,
            ROW_NUMBER() OVER (PARTITION BY family ORDER BY shown DESC,day DESC,activity DESC,creation DESC) AS latest
        FROM members
    ), positions AS (
        SELECT family,family_group,family_pin AS pin,day,activity,creation,
            ROW_NUMBER() OVER (PARTITION BY family_group ORDER BY family_pin DESC,day DESC,activity DESC,creation DESC) AS position
        FROM ranked WHERE latest=1 AND listed_family
    )
    SELECT r.id,r.title,r.auto_title,r.workspace,r.created,r.project,r.archived,r.updated,r.parent,r.pinned,NOT r.member,
        p.family_group,p.position>?3+?4
    FROM ranked AS r JOIN positions AS p ON p.family=r.family
    WHERE (r.member OR r.parent='') AND (?5 OR p.family_group IN (SELECT value FROM json_each(?6)))
        AND p.position>?3 AND (p.position<=?3+?4+1 OR r.family IN (SELECT COALESCE(parent_id,id) FROM sessions WHERE id=?7))
    ORDER BY p.pin DESC,p.day DESC,p.activity DESC,p.creation DESC,r.parent<>'',r.creation`

// SetSessionArchived archives or restores a session and returns the IDs of the changed
// sessions. Archive changes affect visibility only.
//
//   - Archive of a top-level session also archives its sub-sessions.
//   - Archive removes the pin of a session. Restore does not pin it again.
//   - Restore of a top-level session also restores its archived sub-sessions.
//   - Restore of a sub-session also restores its archived parent.
//
// The transaction rejects archive for recorded active runs or an unfinished launch claim
// in any of these sessions. live reports a live terminal that the server owns. It can be
// nil. members are the sub-sessions that the user confirmed for the archive. Nil confirms
// no sub-sessions. Each archive fails with ErrFamilyChanged unless the sub-sessions of
// the session that are not archived are exactly these. A sub-session has none. Thus a
// view that listed the family earlier cannot archive a sub-session that another view
// added.
func (s *Store) SetSessionArchived(id string, archived bool, live func(id string) bool, members []string) ([]string, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var parent string
	err = tx.QueryRow("SELECT COALESCE(parent_id,'') FROM sessions WHERE id=?", id).Scan(&parent)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	ids := []string{id}
	var rows *sql.Rows
	if parent == "" {
		rows, err = tx.Query("SELECT id FROM sessions WHERE parent_id=? AND archived<>? ORDER BY rowid", id, archived)
	} else if !archived {
		rows, err = tx.Query("SELECT id FROM sessions WHERE id=? AND archived", parent)
	}
	if err != nil {
		return nil, err
	}
	if rows != nil {
		for rows.Next() {
			var member string
			if err = rows.Scan(&member); err != nil {
				rows.Close()
				return nil, err
			}
			ids = append(ids, member)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	if archived {
		// ids holds only the session itself for a sub-session.
		confirmed := slices.Clone(members)
		children := slices.Clone(ids[1:])
		slices.Sort(confirmed)
		slices.Sort(children)
		if !slices.Equal(slices.Compact(confirmed), children) {
			return nil, ErrFamilyChanged
		}
	}
	if archived {
		for _, member := range ids {
			var active bool
			err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM runs WHERE session_id=?1 AND status IN ('starting','running'))
            OR EXISTS(SELECT 1 FROM preparations WHERE session_id=?1 AND
                (state='creating' OR (state='launched' AND NOT EXISTS(SELECT 1 FROM runs WHERE session_id=?1))))`, member).Scan(&active)
			if err != nil {
				return nil, err
			}
			if active || (live != nil && live(member)) {
				if len(ids) > 1 {
					return nil, errors.New("stop every session of this family before archiving it")
				}
				return nil, errors.New("stop the session before archiving it")
			}
		}
	}
	for _, member := range ids {
		if _, err = tx.Exec("UPDATE sessions SET archived=?1,pinned_at=CASE WHEN ?1 THEN NULL ELSE pinned_at END WHERE id=?2", archived, member); err != nil {
			return nil, err
		}
	}
	return ids, tx.Commit()
}

// SetSessionPinned pins or unpins a top-level session that is not archived. A new pin
// puts the family first in the Pinned group: its time is after the latest pin, also when
// the clock moved back. A pin of a pinned session and an unpin of a session without a
// pin change nothing. At most MaxPinned sessions have a pin.
func (s *Store) SetSessionPinned(id string, pinned bool) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var parent, pin sql.NullString
	var archived bool
	err = tx.QueryRow("SELECT parent_id,archived,pinned_at FROM sessions WHERE id=?", id).Scan(&parent, &archived, &pin)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return ErrNotFound
	case err != nil:
		return err
	case pin.Valid == pinned:
		return nil
	case !pinned:
		_, err = tx.Exec("UPDATE sessions SET pinned_at=NULL WHERE id=?", id)
	case parent.Valid:
		return errors.New("a sub-session cannot have a pin; pin its top-level session")
	case archived:
		return errors.New("restore the session before you pin it")
	default:
		var count int
		var latest sql.NullString
		if err = tx.QueryRow("SELECT count(pinned_at),MAX(pinned_at) FROM sessions").Scan(&count, &latest); err != nil {
			return err
		}
		if count >= MaxPinned {
			return fmt.Errorf("at most %d sessions can have a pin; unpin a session first", MaxPinned)
		}
		now := time.Now().UTC()
		if last, err := time.Parse(time.RFC3339Nano, latest.String); err == nil && !now.After(last) {
			now = last.Add(time.Nanosecond)
		}
		_, err = tx.Exec("UPDATE sessions SET pinned_at=? WHERE id=?", now.Format(pinFormat), id)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

// ErrFamilyChanged reports that the sub-sessions of a family are not the ones that the
// user confirmed for an archive.
var ErrFamilyChanged = errors.New("the sub-sessions of this family changed; check the list again")

// checkParent accepts a top-level session that is not archived and is in the project.
func checkParent(tx *sql.Tx, parent string, project sql.NullString) error {
	var parentProject, grandparent sql.NullString
	var archived bool
	err := tx.QueryRow("SELECT project_id,parent_id,archived FROM sessions WHERE id=?", parent).Scan(&parentProject, &grandparent, &archived)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return errors.New("parent session not found")
	case err != nil:
		return err
	case grandparent.Valid:
		return errors.New("a sub-session cannot have sub-sessions; choose a top-level session")
	case archived:
		return errors.New("restore the parent session first")
	case parentProject != project:
		return errors.New("choose a parent session in the same project")
	}
	return nil
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
