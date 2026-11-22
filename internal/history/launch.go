package history

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Tool is a named startup command.
type Tool struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Command string `json:"command"`
}

type Settings struct {
	Revision    int64  `json:"revision"`
	Appearance  string `json:"appearance"`
	DefaultTool string `json:"defaultTool"`
	Worktree    bool   `json:"worktree"`
	Base        string `json:"base"`
	Tools       []Tool `json:"tools"`
	// TitleTool selects the CLI that makes automatic session titles. It is one of
	// TitleTools. "none" turns automatic titles off.
	TitleTool string `json:"titleTool"`
	// UpdateCheck lets the server read the latest release from GitHub once a day.
	UpdateCheck bool `json:"updateCheck"`
	// Port is the loopback port that the server uses at its next start. 0 selects the
	// automatic port. A change applies only after a server restart.
	Port int `json:"port"`
}

// The lowest port that Settings accepts. Lower ports are for system services.
const MinPort = 1024

// blockedPorts lists the ports from MinPort that web browsers refuse to open. They are
// the "bad ports" of the port blocking section of the Fetch Standard.
var blockedPorts = []int{1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080}

// TitleTools lists the values of Settings.TitleTool. The server owns the command of each
// CLI.
var TitleTools = []string{"none", "claude", "codex", "code-puppy", "apple"}

// Preparation stores a snapshot of the selected preset. Preset changes never rewrite a
// prepared or launched session. The server owns this state.
type Preparation struct {
	Revision int64  `json:"revision"`
	State    string `json:"state"`
	ToolID   string `json:"toolId"`
	ToolName string `json:"toolName"`
	Command  string `json:"command"`
	Worktree bool   `json:"worktree"`
	Base     string `json:"base"`
	Branch   string `json:"branch"`
}

type Worktree struct {
	Path       string `json:"path"`
	Repository string `json:"repository"`
	Base       string `json:"base"`
	Commit     string `json:"commit"`
	Branch     string `json:"branch"`
	State      string `json:"state"`
}

func ValidateCommand(command string) error {
	// One submitted shell line, below common canonical PTY input limits.
	if len(command) > 1000 || !utf8.ValidString(command) || strings.IndexFunc(command, unicode.IsControl) >= 0 {
		return errors.New("startup command must be one line, at most 1000 bytes, without control characters")
	}
	return nil
}

func (s *Store) Settings() (Settings, error) {
	return scanSettings(s.db.QueryRow("SELECT revision,data FROM settings WHERE id=1"))
}

// scanSettings reads the revision and the data of the settings row.
func scanSettings(row *sql.Row) (Settings, error) {
	var settings Settings
	var data string
	var revision int64
	err := row.Scan(&revision, &data)
	if err == nil {
		err = json.Unmarshal([]byte(data), &settings)
	}
	settings.Revision = revision
	if settings.TitleTool == "" {
		settings.TitleTool = "none"
	}
	return settings, err
}

// SaveSettings saves the settings from their current revision. It keeps the saved title
// tool, because only SetTitleTool changes it. A title tool change between the read of
// the saved tool and the write changes the revision, so the write then fails.
func (s *Store) SaveSettings(settings Settings) (Settings, error) {
	switch settings.Appearance {
	case "":
		settings.Appearance = "system"
	case "system", "light", "dark":
	default:
		return settings, errors.New("appearance must be system, light, or dark")
	}
	if len(settings.Tools) > 100 {
		return settings, errors.New("at most 100 tools are supported")
	}
	seen := map[string]bool{"": true}
	for i := range settings.Tools {
		tool := &settings.Tools[i]
		var err error
		tool.Name, err = validName(tool.Name)
		if err != nil {
			return settings, err
		}
		if tool.ID == "" || len(tool.ID) > 100 || seen[tool.ID] {
			return settings, errors.New("tools need unique IDs")
		}
		seen[tool.ID] = true
		if strings.TrimSpace(tool.Command) == "" {
			return settings, errors.New("tool command is required; use Shell for an empty command")
		}
		if err = ValidateCommand(tool.Command); err != nil {
			return settings, err
		}
	}
	if !seen[settings.DefaultTool] {
		return settings, errors.New("default tool does not exist")
	}
	if settings.Port != 0 && (settings.Port < MinPort || settings.Port > 65535) {
		return settings, fmt.Errorf("port must be from %d to 65535, or 0 for an automatic port", MinPort)
	}
	if slices.Contains(blockedPorts, settings.Port) {
		return settings, fmt.Errorf("web browsers do not open port %d; choose another port", settings.Port)
	}
	if len(settings.Base) > 250 || strings.ContainsAny(settings.Base, "\x00\r\n") {
		return settings, errors.New("invalid default Git base")
	}
	if settings.Base == "" {
		settings.Base = "HEAD"
	}
	if settings.Tools == nil {
		settings.Tools = []Tool{}
	}
	saved, err := s.Settings()
	if err != nil {
		return settings, err
	}
	settings.TitleTool = saved.TitleTool
	data, err := json.Marshal(settings)
	if err != nil {
		return settings, err
	}
	result, err := s.db.Exec("UPDATE settings SET revision=revision+1,data=? WHERE id=1 AND revision=?", string(data), settings.Revision)
	if err = revisionChanged(result, err); err != nil {
		return settings, err
	}
	settings.Revision++
	return settings, nil
}

// SetTitleTool saves the title tool alone, with a new revision, and returns the saved
// settings. It does not test the tool. The server tests it before this call.
func (s *Store) SetTitleTool(tool string) (Settings, error) {
	if tool == "" {
		tool = "none"
	}
	if !slices.Contains(TitleTools, tool) {
		return Settings{}, fmt.Errorf("title tool must be one of %s", strings.Join(TitleTools, ", "))
	}
	return scanSettings(s.db.QueryRow("UPDATE settings SET revision=revision+1,data=json_set(data,'$.titleTool',?) WHERE id=1 RETURNING revision,data", tool))
}

func revisionChanged(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n == 0 {
		return errors.New("settings changed or session already started; keep your edits and reload before saving")
	}
	return err
}

func (s *Store) CreatePreparation(title, workspace, project string, p Preparation) (Session, error) {
	return s.createPreparation(title, workspace, project, "", p)
}

// CreateSubPreparation creates a sub-session draft of a top-level session. The draft has
// the project of its parent. Its workspace is the source of a new worktree. Without a
// worktree, the launch uses the workspace of the parent.
func (s *Store) CreateSubPreparation(parent, workspace, project string, p Preparation) (Session, error) {
	if parent == "" {
		return Session{}, errors.New("choose a parent session")
	}
	return s.createPreparation("", workspace, project, parent, p)
}

func (s *Store) createPreparation(title, workspace, project, parent string, p Preparation) (Session, error) {
	if project == "" {
		return Session{}, errors.New("choose a project before preparing a session")
	}
	var err error
	if title != "" {
		title, err = validName(title)
		if err != nil {
			return Session{}, err
		}
	}
	if err = ValidateCommand(p.Command); err != nil {
		return Session{}, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Session{}, err
	}
	defer tx.Rollback()
	if parent != "" {
		if err = checkParent(tx, parent, sql.NullString{String: project, Valid: true}); err != nil {
			return Session{}, err
		}
	}
	session := Session{ID: ID(), Title: title, Workspace: workspace, ProjectID: project, ParentID: parent, Created: Now()}
	p.Revision, p.State = 1, "draft"
	data, err := json.Marshal(p)
	if err != nil {
		return session, err
	}
	_, err = tx.Exec("INSERT INTO sessions(id,title,workspace,created,project_id,parent_id) VALUES(?,?,?,?,NULLIF(?,''),NULLIF(?,''))",
		session.ID, title, workspace, session.Created, project, parent)
	if err == nil {
		_, err = tx.Exec("INSERT INTO preparations VALUES(?,1,'draft',?)", session.ID, string(data))
	}
	if err != nil {
		return session, err
	}
	session.Preparation = &p
	return session, tx.Commit()
}

func (s *Store) SavePreparation(id, title string, p Preparation) (Session, error) {
	if len(title) > 800 || !utf8.ValidString(title) || strings.IndexFunc(title, unicode.IsControl) >= 0 {
		return Session{}, errors.New("invalid session name")
	}
	if strings.TrimSpace(title) != "" {
		var err error
		title, err = validName(title)
		if err != nil {
			return Session{}, err
		}
	}
	if err := ValidateCommand(p.Command); err != nil {
		return Session{}, err
	}
	if len(p.ToolName) > 200 || len(p.Base) > 250 || len(p.Branch) > 250 || strings.ContainsAny(p.Base+p.Branch, "\x00\r\n") {
		return Session{}, errors.New("invalid launch settings")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Session{}, err
	}
	defer tx.Rollback()
	p.State = "draft"
	data, err := json.Marshal(p)
	if err != nil {
		return Session{}, err
	}
	result, err := tx.Exec("UPDATE preparations SET revision=revision+1,data=? WHERE session_id=? AND revision=? AND state='draft'", string(data), id, p.Revision)
	if err = revisionChanged(result, err); err != nil {
		return Session{}, err
	}
	_, err = tx.Exec("UPDATE sessions SET title=? WHERE id=?", title, id)
	if err != nil {
		return Session{}, err
	}
	if err = tx.Commit(); err != nil {
		return Session{}, err
	}
	return s.Session(id)
}

func (s *Store) launchMetadata(session *Session) error {
	var data, state string
	var revision int64
	err := s.db.QueryRow("SELECT revision,state,data FROM preparations WHERE session_id=?", session.ID).Scan(&revision, &state, &data)
	if err == nil {
		var p Preparation
		if err = json.Unmarshal([]byte(data), &p); err != nil {
			return err
		}
		p.Revision, p.State = revision, state
		session.Preparation = &p
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var w Worktree
	err = s.db.QueryRow("SELECT path,repository,base,commit_id,branch,state FROM worktrees WHERE session_id=?", session.ID).Scan(&w.Path, &w.Repository, &w.Base, &w.Commit, &w.Branch, &w.State)
	if err == nil {
		session.Worktree = &w
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return nil
}

func (s *Store) SetPreparationState(id string, revision int64, from, to string) error {
	result, err := s.db.Exec("UPDATE preparations SET state=? WHERE session_id=? AND revision=? AND state=?", to, id, revision, from)
	return revisionChanged(result, err)
}

// SetLaunchWorkspace records the launch workspace and the default derived title. Each
// launch sets it, also under a user title.
func (s *Store) SetLaunchWorkspace(id, autoTitle, workspace string) error {
	_, err := s.db.Exec("UPDATE sessions SET auto_title=?,workspace=? WHERE id=?", autoTitle, workspace, id)
	return err
}

// SetAutoTitle replaces the derived title. It never changes the user title.
func (s *Store) SetAutoTitle(id, title string) error {
	return changedRow(s.db.Exec("UPDATE sessions SET auto_title=? WHERE id=?", title, id))
}

func (s *Store) SaveWorktree(id string, w Worktree) error {
	_, err := s.db.Exec(`INSERT INTO worktrees VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(session_id) DO UPDATE SET path=excluded.path,repository=excluded.repository,base=excluded.base,commit_id=excluded.commit_id,branch=excluded.branch,state=excluded.state`, id, w.Path, w.Repository, w.Base, w.Commit, w.Branch, w.State)
	return err
}
