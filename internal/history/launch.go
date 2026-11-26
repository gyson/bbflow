package history

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"bbflow/internal/models"
)

// Tool is a named startup command. Type is one of models.Types. A built-in tool has the
// type of its agent. A tool that the user adds is custom. For a type other than custom,
// Model, Effort, and Permission are the defaults of new drafts and new terminals. An
// empty value selects the default of the CLI. Permission is a value of the permission
// modes of the type. See models.Validate.
//
// Builtin marks the one preset of each agent type. The server owns this flag. A save
// cannot remove a built-in tool or change its type. The built-in tools come first in the
// saved list. Enabled turns a tool on or off. A tool that is off is not a choice for new
// drafts and new terminals. A tool that the user adds starts on.
//
// A built-in tool has a fixed name, type, and command. The user sets only its optional
// CLI path, its default model, effort, and permission mode, and whether it is on. Path is the CLI path. The
// server builds Command from it. See models.BuiltinCommand. The server also runs the
// path for the model list, the check for the CLI, and the title tool of the type. An
// empty path selects the plain CLI name. A tool that the user added has no Path.
type Tool struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Command    string `json:"command"`
	Type       string `json:"type"`
	Model      string `json:"model"`
	Effort     string `json:"effort"`
	Permission string `json:"permission"`
	Builtin    bool   `json:"builtin"`
	Enabled    bool   `json:"enabled"`
	Path       string `json:"path"`
}

// Prompt is a saved prompt. The ＋ menu of the message editor puts its text at the cursor
// of the draft. It never sends the text. The prompts are global: every session shows the
// same list, in the saved order. The client gives each new prompt its ID.
type Prompt struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Text string `json:"text"`
}

type Settings struct {
	Revision    int64  `json:"revision"`
	Appearance  string `json:"appearance"`
	DefaultTool string `json:"defaultTool"`
	// ShellOff turns off the built-in Shell, the tool with the empty ID. Shell is then not
	// a choice for new drafts and new terminals, and it cannot be the default tool. A
	// saved settings row without the value has Shell on.
	ShellOff bool   `json:"shellOff"`
	Worktree bool   `json:"worktree"`
	Base     string `json:"base"`
	Tools    []Tool `json:"tools"`
	// TitleTool selects the CLI that makes automatic session titles. It is one of
	// TitleTools. "none" turns automatic titles off. "custom" runs TitleCommand.
	TitleTool string `json:"titleTool"`
	// TitleCommand is the command of the custom title tool. It stays saved when another
	// title tool is selected. The server owns the commands of the other title tools.
	TitleCommand string `json:"titleCommand"`
	// TitleModel and TitleEffort are the model and the thinking effort of a title tool of
	// an agent CLI. An empty value adds no option. Only SetTitleTool changes them.
	TitleModel  string `json:"titleModel"`
	TitleEffort string `json:"titleEffort"`
	// CheckTools tells the server to turn on the built-in tools whose CLI is on PATH, once
	// at its next start. The server owns this flag.
	CheckTools bool `json:"checkTools"`
	// UpdateCheck lets the server read the latest release from GitHub once a day.
	UpdateCheck bool `json:"updateCheck"`
	// Port is the loopback port that the server uses at its next start. 0 selects the
	// automatic port. A change applies only after a server restart.
	Port int `json:"port"`
	// RemoteOn is the switch of remote access. RemoteHost is the Host of the requests that
	// a reverse proxy on this computer, such as Tailscale Serve, forwards to the server.
	// RemoteLogin is the Tailscale login that each of these requests must carry. The
	// switch and the two values are independent. A save of the values does not turn the
	// switch on, and the switch keeps the values when it turns off.
	RemoteOn    bool   `json:"remoteOn"`
	RemoteHost  string `json:"remoteHost"`
	RemoteLogin string `json:"remoteLogin"`
	// Prompts are the saved prompts, in the order of the ＋ menu.
	Prompts []Prompt `json:"prompts"`
}

// RemoteAccess tells if the settings admit remote requests. The switch must be on, and
// both values must be set.
func (s Settings) RemoteAccess() bool { return s.RemoteOn && s.RemoteHost != "" && s.RemoteLogin != "" }

// maxCustomTools is the most tools that the user can add.
const maxCustomTools = 100

// maxPrompts is the most saved prompts. maxPromptText is the byte limit of the text of
// one prompt. The message limit of the editor is 64 KiB, so a prompt leaves room for
// other text in the same message.
const (
	maxPrompts    = 100
	maxPromptText = 16 << 10
)

// validPrompts checks the saved prompts and returns them with trimmed names. Names are
// unique without regard to case, so that the menu items differ. The text keeps its
// spaces and lines. It can have tabs and newlines, but no other control characters,
// because the editor rejects them at Send.
func validPrompts(prompts []Prompt) ([]Prompt, error) {
	if len(prompts) > maxPrompts {
		return nil, fmt.Errorf("at most %d prompts are supported", maxPrompts)
	}
	result := make([]Prompt, 0, len(prompts))
	ids, names := map[string]bool{}, map[string]bool{}
	for _, prompt := range prompts {
		if prompt.ID == "" || len(prompt.ID) > 100 || ids[prompt.ID] {
			return nil, errors.New("prompts need unique IDs")
		}
		ids[prompt.ID] = true
		name, err := validName(prompt.Name)
		if err != nil {
			return nil, err
		}
		if names[strings.ToLower(name)] {
			return nil, fmt.Errorf("another prompt has the name %q; enter a different name", name)
		}
		names[strings.ToLower(name)] = true
		switch {
		case strings.TrimSpace(prompt.Text) == "":
			return nil, fmt.Errorf("the prompt %q has no text", name)
		case len(prompt.Text) > maxPromptText:
			return nil, fmt.Errorf("the text of the prompt %q is longer than 16 KiB", name)
		case !utf8.ValidString(prompt.Text) || strings.ContainsFunc(prompt.Text, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\t' }):
			return nil, fmt.Errorf("the text of the prompt %q has control characters; only tabs and new lines are allowed", name)
		}
		result = append(result, Prompt{ID: prompt.ID, Name: name, Text: prompt.Text})
	}
	return result, nil
}

// The lowest port that Settings accepts. Lower ports are for system services.
const MinPort = 1024

// blockedPorts lists the ports from MinPort that web browsers refuse to open. They are
// the "bad ports" of the port blocking section of the Fetch Standard.
var blockedPorts = []int{1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080}

// TitleTools lists the values of Settings.TitleTool. The server owns the command of each
// CLI, except custom, which runs Settings.TitleCommand.
var TitleTools = []string{"none", "claude", "codex", "code-puppy", "apple", "custom"}

// Preparation stores a snapshot of the selected preset. Preset changes never rewrite a
// prepared or launched session. The server owns this state. ToolType is the type of the
// tool, or empty for Shell. Model, Effort, and Permission are the choices of the draft.
// The launch adds their options to Command. See models.Command.
type Preparation struct {
	Revision   int64  `json:"revision"`
	State      string `json:"state"`
	ToolID     string `json:"toolId"`
	ToolName   string `json:"toolName"`
	ToolType   string `json:"toolType"`
	Command    string `json:"command"`
	Model      string `json:"model"`
	Effort     string `json:"effort"`
	Permission string `json:"permission"`
	Worktree   bool   `json:"worktree"`
	Base       string `json:"base"`
	Branch     string `json:"branch"`
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

// FallbackTool returns the default tool after the default tool turns off or leaves the
// list: Shell when it is on, else the first other tool that is on. It returns false when
// no tool is left.
func FallbackTool(settings Settings, leaving string) (string, bool) {
	if !settings.ShellOff && leaving != "" {
		return "", true
	}
	for _, tool := range settings.Tools {
		if tool.Enabled && tool.ID != leaving {
			return tool.ID, true
		}
	}
	return "", false
}

// validPreparation checks the command, the model, the effort, and the permission mode of
// a draft.
func validPreparation(p Preparation) error {
	if err := ValidateCommand(p.Command); err != nil {
		return err
	}
	return models.Validate(p.ToolType, p.Model, p.Effort, p.Permission)
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
// tool and custom title command, because only SetTitleTool changes them. A title tool
// change between the read of the saved values and the write changes the revision, so
// the write then fails.
func (s *Store) SaveSettings(settings Settings) (Settings, error) {
	switch settings.Appearance {
	case "":
		settings.Appearance = "system"
	case "system", "light", "dark":
	default:
		return settings, errors.New("appearance must be system, light, or dark")
	}
	saved, err := s.Settings()
	if err != nil {
		return settings, err
	}
	builtins, known := map[string]Tool{}, map[string]bool{}
	for _, tool := range saved.Tools {
		known[tool.ID] = true
		if tool.Builtin {
			builtins[tool.ID] = tool
		}
	}
	// The limit counts the custom tools. The built-in tools are always in the list.
	custom := 0
	for _, tool := range settings.Tools {
		if _, builtin := builtins[tool.ID]; !builtin {
			custom++
		}
	}
	if custom > maxCustomTools {
		return settings, fmt.Errorf("at most %d custom tools are supported", maxCustomTools)
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
		original, builtin := builtins[tool.ID]
		tool.Builtin = builtin
		if builtin {
			// The name and the type of a built-in tool stay. The server builds its command
			// from its CLI path.
			if tool.Type != "" && tool.Type != original.Type {
				return settings, fmt.Errorf("the type of the built-in tool %q cannot change", original.Name)
			}
			if err = models.ValidPath(tool.Path); err != nil {
				return settings, err
			}
			tool.Name, tool.Type = original.Name, original.Type
			tool.Command = models.BuiltinCommand(original.Type, tool.Path)
		} else {
			// A tool of the user is a Custom tool. Its command holds all of its options.
			switch {
			case tool.Path != "":
				return settings, errors.New("only a built-in tool has a CLI path; put the path in the startup command")
			case tool.Type != "" && tool.Type != models.Custom:
				return settings, errors.New("only a built-in tool has an agent type; a tool that you add is a Custom tool")
			}
			tool.Type = models.Custom
		}
		if strings.TrimSpace(tool.Command) == "" {
			return settings, errors.New("tool command is required; use Shell for an empty command")
		}
		if err = ValidateCommand(tool.Command); err != nil {
			return settings, err
		}
		// A new tool starts on, also from a client that sends no enabled value.
		if !known[tool.ID] {
			tool.Enabled = true
		}
		if !slices.Contains(models.Types, tool.Type) {
			return settings, errors.New("tool type must be codex, claude, agy, code-puppy, or custom")
		}
		if err = models.Validate(tool.Type, tool.Model, tool.Effort, tool.Permission); err != nil {
			return settings, err
		}
	}
	// A save cannot remove a built-in tool. A save without one keeps the saved tool.
	for _, tool := range saved.Tools {
		if tool.Builtin && !seen[tool.ID] {
			settings.Tools = append(settings.Tools, tool)
			seen[tool.ID] = true
		}
	}
	// The built-in tools come first, in their saved order. The tools that the user added
	// follow. Settings and the tool menus show the two groups in this order.
	slices.SortStableFunc(settings.Tools, func(a, b Tool) int {
		switch {
		case a.Builtin == b.Builtin:
			return 0
		case a.Builtin:
			return -1
		}
		return 1
	})
	if !seen[settings.DefaultTool] {
		return settings, errors.New("default tool does not exist")
	}
	for _, tool := range settings.Tools {
		if tool.ID == settings.DefaultTool && !tool.Enabled {
			return settings, fmt.Errorf("%q is off; turn it on before you make it the default tool", tool.Name)
		}
	}
	if settings.DefaultTool == "" && settings.ShellOff {
		return settings, errors.New("Shell is off, so it cannot be the default tool; choose another default tool, or turn Shell on")
	}
	if settings.Port != 0 && (settings.Port < MinPort || settings.Port > 65535) {
		return settings, fmt.Errorf("port must be from %d to 65535, or 0 for an automatic port", MinPort)
	}
	if slices.Contains(blockedPorts, settings.Port) {
		return settings, fmt.Errorf("web browsers do not open port %d; choose another port", settings.Port)
	}
	if settings.RemoteHost, err = validRemoteHost(settings.RemoteHost); err != nil {
		return settings, err
	}
	if settings.RemoteLogin, err = validRemoteLogin(settings.RemoteLogin); err != nil {
		return settings, err
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
	if settings.Prompts, err = validPrompts(settings.Prompts); err != nil {
		return settings, err
	}
	settings.TitleTool, settings.TitleCommand, settings.CheckTools = saved.TitleTool, saved.TitleCommand, saved.CheckTools
	settings.TitleModel, settings.TitleEffort = saved.TitleModel, saved.TitleEffort
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

// FinishToolCheck turns on the built-in tools whose type installed reports, and it ends
// the check that Settings.CheckTools asks for. It turns no tool off. Without a pending
// check, it changes nothing. The server runs it before it takes requests, so no view has
// read the settings yet. Thus the check keeps the settings revision, as a migration does.
// A settings save between the read and the write fails the revision guard, so the write
// then reads the settings again.
func (s *Store) FinishToolCheck(installed func(kind string) bool) (Settings, error) {
	for {
		settings, err := s.Settings()
		if err != nil || !settings.CheckTools {
			return settings, err
		}
		for i := range settings.Tools {
			tool := &settings.Tools[i]
			if tool.Builtin && !tool.Enabled && installed(tool.Type) {
				tool.Enabled = true
			}
		}
		settings.CheckTools = false
		data, err := json.Marshal(settings)
		if err != nil {
			return settings, err
		}
		result, err := s.db.Exec("UPDATE settings SET data=? WHERE id=1 AND revision=? AND json_extract(data,'$.checkTools')", string(data), settings.Revision)
		if err != nil {
			return settings, err
		}
		if n, err := result.RowsAffected(); err != nil || n == 1 {
			return settings, err
		}
	}
}

// validRemoteHost returns the saved form of Settings.RemoteHost: lower case, without
// surrounding spaces. The host is a DNS name with at least two labels and an optional
// port, in the form that a browser sends in the Host header. An IP address is not a host
// name, and the loopback names are always local.
func validRemoteHost(host string) (string, error) {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return "", nil
	}
	invalid := errors.New("remote host must be a DNS name such as my-mac.example.ts.net, with an optional port")
	name, port, hasPort := strings.Cut(host, ":")
	if hasPort {
		if number, err := strconv.Atoi(port); err != nil || number < 1 || number > 65535 || strconv.Itoa(number) != port {
			return "", invalid
		}
	}
	labels := strings.Split(name, ".")
	if len(name) > 253 || len(labels) < 2 {
		return "", invalid
	}
	numeric := true
	for _, label := range labels {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", invalid
		}
		for _, c := range []byte(label) {
			if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
				return "", invalid
			}
			numeric = numeric && c >= '0' && c <= '9'
		}
	}
	if numeric || labels[len(labels)-1] == "localhost" {
		return "", invalid
	}
	return host, nil
}

// validRemoteLogin returns Settings.RemoteLogin without surrounding spaces. Tailscale
// Serve sends a login of printable ASCII characters as it is, so only such a login can
// match.
func validRemoteLogin(login string) (string, error) {
	login = strings.TrimSpace(login)
	if len(login) > 254 || strings.IndexFunc(login, func(r rune) bool { return r <= ' ' || r > '~' }) >= 0 {
		return "", errors.New("Tailscale login must be at most 254 printable ASCII characters, without spaces")
	}
	return login, nil
}

// TitleChoice is a selected title tool, the saved custom command, and the model and the
// effort. Command is empty for a change to a built-in tool or none, because such a change
// keeps the saved custom command. Only the title tools of an agent CLI take a model and an
// effort.
//
// Path is the CLI path of the built-in tool of the agent type that a test ran, for
// SetTitleTool. Settings.Choice leaves it empty.
type TitleChoice struct {
	Tool    string
	Command string
	Model   string
	Effort  string
	Path    string
}

// BuiltinPath returns the CLI path of the built-in tool of an agent type, or empty.
func (s Settings) BuiltinPath(kind string) string {
	for _, tool := range s.Tools {
		if tool.Builtin && tool.Type == kind {
			return tool.Path
		}
	}
	return ""
}

// Choice returns the title tool, the custom command, and the model and effort of the
// settings.
func (s Settings) Choice() TitleChoice {
	return TitleChoice{Tool: s.TitleTool, Command: s.TitleCommand, Model: s.TitleModel, Effort: s.TitleEffort}
}

// TitleType returns the agent type of a title tool, or empty for a title tool without a
// model choice. The IDs of the agent title tools are their types.
func TitleType(tool string) string {
	if models.Typed(tool) {
		return tool
	}
	return ""
}

// ErrTitleChanged reports that another change of the title tool or the custom command
// saved first. SetTitleTool then saves nothing.
var ErrTitleChanged = errors.New("the title tool changed during the test")

// SetTitleTool saves next, with a new revision, and returns the saved settings. It
// saves only while the settings still have the title tool, the custom command, the
// model, and the effort of from. For a title tool of an agent CLI, it also saves only
// while the built-in tool of that type has the CLI path next.Path, which the test ran. A test can run for 90 seconds, and a later change must not be undone by an
// earlier test. Other settings can change meanwhile. For custom, next.Command is the
// custom command, and it saves too. Other tools take no command. SetTitleTool does not
// test the tool. The server tests it before this call.
func (s *Store) SetTitleTool(next, from TitleChoice) (Settings, error) {
	if !slices.Contains(TitleTools, next.Tool) {
		return Settings{}, fmt.Errorf("title tool must be one of %s", strings.Join(TitleTools, ", "))
	}
	if err := models.Validate(TitleType(next.Tool), next.Model, next.Effort, ""); err != nil {
		return Settings{}, fmt.Errorf("only the title tools of Claude, Codex, and Code Puppy take a model and an effort: %w", err)
	}
	var row *sql.Row
	const program = " AND coalesce((SELECT json_extract(t.value,'$.path') FROM json_each(data,'$.tools') AS t" +
		" WHERE json_extract(t.value,'$.builtin') AND json_extract(t.value,'$.type')=?),'')=?"
	const unchanged = " WHERE id=1 AND json_extract(data,'$.titleTool')=? AND json_extract(data,'$.titleCommand')=?" +
		" AND json_extract(data,'$.titleModel')=? AND json_extract(data,'$.titleEffort')=?" + program + " RETURNING revision,data"
	// A title tool without an agent type matches no built-in tool, so its path is empty.
	from4 := []any{from.Tool, from.Command, from.Model, from.Effort, TitleType(next.Tool), next.Path}
	if next.Tool != "custom" {
		if next.Command != "" {
			return Settings{}, errors.New("only the custom title tool takes a command")
		}
		row = s.db.QueryRow("UPDATE settings SET revision=revision+1,data=json_set(data,'$.titleTool',?,'$.titleModel',?,'$.titleEffort',?)"+unchanged,
			append([]any{next.Tool, next.Model, next.Effort}, from4...)...)
	} else {
		if err := ValidateTitleCommand(next.Command); err != nil {
			return Settings{}, err
		}
		row = s.db.QueryRow("UPDATE settings SET revision=revision+1,data=json_set(data,'$.titleTool',?,'$.titleCommand',?,'$.titleModel','','$.titleEffort','')"+unchanged,
			append([]any{next.Tool, next.Command}, from4...)...)
	}
	settings, err := scanSettings(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Settings{}, ErrTitleChanged
	}
	return settings, err
}

// ValidateTitleCommand checks a custom title command. It follows the rules of a tool
// startup command, and it cannot be empty.
func ValidateTitleCommand(command string) error {
	if strings.TrimSpace(command) == "" {
		return errors.New("enter a command for the custom title tool")
	}
	if len(command) > 1000 || !utf8.ValidString(command) || strings.IndexFunc(command, unicode.IsControl) >= 0 {
		return errors.New("the custom title command must be one line, at most 1000 bytes, without control characters")
	}
	return nil
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
	if err = validPreparation(p); err != nil {
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
	if err := validPreparation(p); err != nil {
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
