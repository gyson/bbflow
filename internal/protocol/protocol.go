// Package protocol defines messages between bbflow's local clients and server.
package protocol

import (
	"bbflow/internal/history"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const Version = "bbflow/31"
const Path = "/ws"
const maxMessage = 16 << 20

var ErrMessageTooLarge = errors.New("protocol message exceeds 16 MiB")

type Size struct {
	Rows uint16 `json:"rows"`
	Cols uint16 `json:"cols"`
}

type Run struct {
	Command   string `json:"command,omitempty"`
	Workspace string `json:"workspace"`
	Title     string `json:"title"`
	Size      Size   `json:"size"`
}

// The server owns command and workspace snapshots. Forms cannot supply these fields.
type PreparationConfig struct {
	Revision int64  `json:"revision"`
	ToolID   string `json:"toolId"`
	Worktree bool   `json:"worktree"`
	Base     string `json:"base"`
	Branch   string `json:"branch"`
}

type Request struct {
	Archived    bool               `json:"archived,omitempty"`
	Query       string             `json:"query,omitempty"`
	Settings    *history.Settings  `json:"settings,omitempty"`
	Preparation *PreparationConfig `json:"preparation,omitempty"`
	Revision    int64              `json:"revision,omitempty"`
	Project     string             `json:"project,omitempty"`
	Parent      string             `json:"parent,omitempty"` // A top-level session. Empty means the top level.
	// Members are the sub-sessions that the user confirmed for an archive. Nil confirms
	// none. The archive fails if the session has other sub-sessions.
	Members   []string `json:"members,omitempty"`
	Name      string   `json:"name,omitempty"`
	Workspace string   `json:"workspace,omitempty"`
	Protocol  string   `json:"protocol"`
	Operation string   `json:"operation"`
	Instance  string   `json:"instance,omitempty"`
	SQL       string   `json:"sql,omitempty"`
	Session   string   `json:"session,omitempty"`
	LatestRun string   `json:"latestRun,omitempty"` // The latest run that the view saw.
	Run       string   `json:"run,omitempty"`       // An earlier run to show. Empty shows the latest run.
	Shell     string   `json:"shell,omitempty"`     // A side terminal shell. Empty selects the live shell.
	Tool      string   `json:"tool,omitempty"`      // A tool ID from Settings. Empty selects Shell.
	Limit     int      `json:"limit,omitempty"`
	Groups    []string `json:"groups,omitempty"` // Session list group keys. "" is Standalone.
	Offset    int      `json:"offset,omitempty"` // The sessions of the group to skip.
	Size      Size     `json:"size,omitempty"`
	Draft     *Draft   `json:"draft,omitempty"`
	Upload    *Upload  `json:"upload,omitempty"`
	Text      string   `json:"text,omitempty"`    // A sample message for title-test.
	Version   string   `json:"version,omitempty"` // The release of the offer that update-start confirms.

	Search  *history.SearchFilter   `json:"search,omitempty"`
	Context *history.ContextRequest `json:"context,omitempty"`
	Diff    *DiffRequest            `json:"diff,omitempty"`
}

// DiffRequest selects a baseline and a file in the workspace of the request session.
// Baseline is "base" for the managed worktree commit, "head" for HEAD, or "commit"
// for the changes from the From commit. An empty baseline selects "base" when it is
// available. Path and OldPath are relative to the session workspace. OldPath names the
// old side of a rename. Folders names the folders of a folder list. An empty folder
// path names the workspace folder.
type DiffRequest struct {
	Baseline string   `json:"baseline,omitempty"`
	From     string   `json:"from,omitempty"`
	Path     string   `json:"path,omitempty"`
	OldPath  string   `json:"oldPath,omitempty"`
	Folders  []string `json:"folders,omitempty"`
}

// Baseline identifies the commit that a diff compares with the current files. Commit
// is the empty tree in a repository without commits. For the "commit" kind, From is
// the first commit that the diff includes, and Commit is its first parent.
type Baseline struct {
	Kind   string `json:"kind"`
	Label  string `json:"label"`
	Commit string `json:"commit"`
	From   string `json:"from,omitempty"`
}

// Commit is one commit that a "commit" baseline can start from.
type Commit struct {
	ID      string `json:"id"`
	Subject string `json:"subject"`
}

// WorkspaceChanges lists the changed files of a session workspace. Repository is
// false, with a reason, for a folder that Git does not manage. Base reports that the
// "base" baseline is available. Commits lists the commits for a "commit" baseline,
// newest first. MoreCommits reports that older commits are not in the list. Added and
// Removed are -1 when they are unknown.
type WorkspaceChanges struct {
	Repository  bool          `json:"repository"`
	Reason      string        `json:"reason,omitempty"`
	Base        bool          `json:"base"`
	Baseline    Baseline      `json:"baseline"`
	Commits     []Commit      `json:"commits"`
	MoreCommits bool          `json:"moreCommits,omitempty"`
	Files       []ChangedFile `json:"files"`
	Truncated   bool          `json:"truncated"`
}

// ChangedFile is one changed path. Status is the Git status letter: A, M, D, R, or T.
// An untracked file has Untracked. Its status is A, or M when the baseline has the
// path, for example after `git rm --cached`.
type ChangedFile struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"`
	Status    string `json:"status"`
	Added     int    `json:"added"`
	Removed   int    `json:"removed"`
	Binary    bool   `json:"binary,omitempty"`
	Untracked bool   `json:"untracked,omitempty"`
}

// WorkspaceFiles lists the paths that Git tracks or does not ignore.
type WorkspaceFiles struct {
	Repository bool     `json:"repository"`
	Reason     string   `json:"reason,omitempty"`
	Paths      []string `json:"paths"`
	Truncated  bool     `json:"truncated"`
}

// WorkspaceFolders lists the entries of the requested folders, in request order.
// IgnoreError holds the first Git failure that kept the server from marking ignored
// entries. The entries are still complete.
type WorkspaceFolders struct {
	Folders     []WorkspaceFolder `json:"folders"`
	IgnoreError string            `json:"ignoreError,omitempty"`
}

// WorkspaceFolder lists one folder. Missing reports that the path is not a folder now.
// Truncated reports that the folder has more entries than the reply holds.
type WorkspaceFolder struct {
	Path      string        `json:"path"`
	Missing   bool          `json:"missing,omitempty"`
	Entries   []FolderEntry `json:"entries"`
	Truncated bool          `json:"truncated,omitempty"`
}

// FolderEntry is one name in a folder. Kind is "folder", "file", "symlink", or "other"
// for a special file. Ignored reports that Git ignores the entry.
type FolderEntry struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Ignored bool   `json:"ignored,omitempty"`
}

// WorkspaceFile holds both sides of one file. Old comes from the baseline commit. New
// comes from the current workspace files. Without Git, Baseline is empty and Old is
// missing.
type WorkspaceFile struct {
	Path     string   `json:"path"`
	Baseline Baseline `json:"baseline"`
	Old      FileSide `json:"old"`
	New      FileSide `json:"new"`
}

// FileSide is one version of a file. State is "text", "missing", "binary", "tooLarge",
// or "other" for a directory, a submodule, or a special file. Text is set only for
// "text". A symlink holds its target text, as in Git.
type FileSide struct {
	State   string `json:"state"`
	Text    string `json:"text,omitempty"`
	Size    int64  `json:"size"`
	Symlink bool   `json:"symlink,omitempty"`
}

// Drafts contain editable text and attachments. They are not agent messages. Pending
// means that an input write may have occurred. Clients must never retry it
// automatically.
type Draft struct {
	Revision    int64   `json:"revision"`
	Text        string  `json:"text"`
	Attachments []int64 `json:"attachments"`
	Pending     bool    `json:"pending"`
}

type Upload struct {
	Name      string `json:"name"`
	MediaType string `json:"mediaType"`
	Data      []byte `json:"data"`
}

type Attachment struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	MediaType string `json:"mediaType"`
	Size      int    `json:"size"`
	Path      string `json:"path"`
}

// Composer holds a whole draft and its attachment metadata. Rejected is set only in a
// save reply. It reports that the server kept a send from another view and did not
// store the save. The reply then holds the latest draft.
type Composer struct {
	Draft       Draft        `json:"draft"`
	Attachments []Attachment `json:"attachments"`
	Rejected    bool         `json:"rejected,omitempty"`
}

// SentMessage is one send from the message editor. It is derived from the pending draft
// revision that the editor saves before it writes input. Confirmed reports that the
// editor got an input receipt and then cleared the draft. A receipt does not confirm
// that the application accepted the message.
type SentMessage struct {
	Revision    int64        `json:"revision"`
	Created     string       `json:"created"`
	Text        string       `json:"text"`
	Attachments []Attachment `json:"attachments"`
	Confirmed   bool         `json:"confirmed"`
}

// SentPage lists sent messages, newest first. More reports older messages.
type SentPage struct {
	Messages []SentMessage `json:"messages"`
	More     bool          `json:"more"`
}

// Handoff identifies the folder that bbflow writes before it starts a new terminal in
// an ended session, and the prompt that points a new agent to it. Available reports
// that the folder has a README, so the prompt can be used now.
type Handoff struct {
	Folder    string `json:"folder"`
	Prompt    string `json:"prompt"`
	Available bool   `json:"available"`
}

// Terminal is one terminal of a session. Each terminal is one run. Number counts from 1
// in start order. A new terminal has no run ID until its process starts. Tool is empty
// when the start event of an older run has no tool.
type Terminal struct {
	Number  int    `json:"number"`
	Run     string `json:"run"`
	Tool    string `json:"tool"`
	Status  string `json:"status"`
	Started string `json:"started"`
	Ended   string `json:"ended"`
}

// SessionDetail is a session with its Status.
type SessionDetail struct {
	history.Session
	Status string `json:"status"`
}

// SessionPage lists the most recent sessions of the requested project groups, or one
// window of one group. More holds the keys of the groups that have more sessions.
type SessionPage struct {
	Sessions []SessionInfo `json:"sessions"`
	More     []string      `json:"more"`
}

// SessionInfo is a session summary. Status is draft, running, idle, or ended. The
// server derives it. Running means that a live terminal had application output in the
// last seconds, or that the session starts. Idle means a live terminal without recent
// output. It does not mean that the application is ready for input.
type SessionInfo struct {
	Archived    bool                 `json:"archived"`
	ParentID    string               `json:"parentId"`
	Context     bool                 `json:"context,omitempty"`
	Preparation *history.Preparation `json:"preparation,omitempty"`
	Worktree    *history.Worktree    `json:"worktree,omitempty"`
	ProjectID   string               `json:"projectId"`
	ID          string               `json:"id"`
	Title       string               `json:"title"`
	AutoTitle   string               `json:"autoTitle"`
	Workspace   string               `json:"workspace"`
	Updated     string               `json:"updated"`
	Status      string               `json:"status"`
	RunStatus   string               `json:"runStatus,omitempty"` // The stored status of the latest run. Empty without a run.
	Viewers     int                  `json:"viewers"`
}

// TitleTool is an agent CLI that can make automatic session titles. The server owns its
// command.
type TitleTool struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Command string `json:"command"`
}

// Update offers a newer bbflow release to the server. Revision identifies the offer.
// It changes when a check finds another release or another action. Version is the
// version of the running server. Available is the newer release. Installed reports that
// the executable already has that release, so the update only restarts the server.
// State is "available", "updating", or "failed". Error tells why the last update failed.
type Update struct {
	Revision  int64  `json:"revision"`
	Version   string `json:"version"`
	Available string `json:"available"`
	Installed bool   `json:"installed,omitempty"`
	State     string `json:"state"`
	Error     string `json:"error,omitempty"`
}

type ServerInfo struct {
	Protocol   string `json:"protocol"`
	Instance   string `json:"instance"`
	PID        int    `json:"pid"`
	DataDir    string `json:"dataDir"`
	Port       int    `json:"port"`
	Executable string `json:"executable"`
}

// Message carries one request, reply, or terminal event. Set only the fields that its
// Type needs. Input bytes and rendered frames use base64 in JSON. Statuses holds running
// or idle for each session that has a live terminal. In a statuses message, Revision
// counts session title changes, and Update offers a newer release. Run identifies the
// run that an exit message is about.
type Message struct {
	Type     string            `json:"type"`
	Revision int64             `json:"revision,omitempty"`
	Full     bool              `json:"full,omitempty"`
	ID       string            `json:"id,omitempty"`
	Request  *Request          `json:"request,omitempty"`
	Server   *ServerInfo       `json:"server,omitempty"`
	Session  string            `json:"session,omitempty"`
	Active   bool              `json:"active,omitempty"`
	Status   string            `json:"status,omitempty"`
	Statuses map[string]string `json:"statuses,omitempty"`
	Data     []byte            `json:"data,omitempty"`
	Size     Size              `json:"size,omitempty"`
	Signal   int               `json:"signal,omitempty"`
	Code     int               `json:"code,omitempty"`
	Run      string            `json:"run,omitempty"`
	Shell    string            `json:"shell,omitempty"` // Identifies a side terminal shell.
	Error    string            `json:"error,omitempty"`
	Notice   string            `json:"notice,omitempty"` // A warning for the view that started a session.
	Composer *Composer         `json:"composer,omitempty"`
	Update   *Update           `json:"update,omitempty"`
	Result   json.RawMessage   `json:"result,omitempty"`
}

type Conn struct {
	socket *websocket.Conn
	mu     sync.Mutex
}

func Wrap(socket *websocket.Conn) *Conn {
	socket.SetReadLimit(maxMessage)
	return &Conn{socket: socket}
}

func (c *Conn) Close() error {
	// Try to send a close frame so browser peers see a normal close. Keep the timeout
	// short. Slow peers must not delay recording or process cleanup.
	c.socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(100*time.Millisecond))
	return c.socket.Close()
}

// Set deadlines on the underlying socket. Then connection shutdown can interrupt
// Receive without concurrent calls to the WebSocket reader's methods.
func (c *Conn) SetReadDeadline(deadline time.Time) error {
	return c.socket.NetConn().SetReadDeadline(deadline)
}

// Send permits output and terminal control to share a connection. A stalled
// peer cannot block process cleanup indefinitely.
func (c *Conn) Send(message Message) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	if len(data) > maxMessage {
		return ErrMessageTooLarge
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.socket.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return c.socket.WriteMessage(websocket.TextMessage, data)
}

func (c *Conn) Receive() (Message, error) {
	kind, data, err := c.socket.ReadMessage()
	if err != nil {
		return Message{}, err
	}
	if kind != websocket.TextMessage {
		return Message{}, errors.New("protocol requires JSON text messages")
	}
	var message *Message
	err = json.Unmarshal(data, &message)
	if err != nil {
		return Message{}, err
	}
	if message == nil {
		return Message{}, errors.New("protocol requires a JSON object")
	}
	return *message, nil
}
