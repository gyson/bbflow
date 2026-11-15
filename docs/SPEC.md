# BonBon — Current Specification

BonBon has a separate background server and a browser workspace. The CLI opens the UI,
manages the server, runs read-only SQL queries, and updates the installed executable.
See [GOAL.md](GOAL.md) for continuation, imports, and richer workspace goals.

## Architecture and build

- Go 1.27.3+ core with `github.com/creack/pty` and `golang.org/x/sys`. Only synthetic
  test agents use `golang.org/x/term`.
- SQLite through the pure Go `github.com/ncruces/go-sqlite3` driver. No CGO in
  deployment builds.
- Frontend sources are under `web/`, with strict TypeScript and CSS under `web/src`.
  Source builds require Node.js 22+ and npm. The TypeScript compiler checks types.
  esbuild bundles the application, xterm.js 6.0.0, FitAddon 0.11.0, CodeMirror 6 with
  `@codemirror/merge` 6.12.3, and a fixed set of language modes into one ES2022
  JavaScript file and one CSS file. The build also includes HTML and the licenses of
  every bundled npm package, which it reads from the esbuild metafile. The JavaScript
  file is about 1.1 MB. CodeMirror adds about 290 KB and its language modes about 400
  KB.
- Generated assets are in `internal/webui/dist`, which Go embeds. Git ignores this
  directory, test compiler output in `web/dist`, and npm dependencies. The deployed
  binary needs neither Node.js nor external frontend files.
- The build collects BonBon's license, the Go license, npm runtime licenses, and
  license/notice files from the Go modules required by `go.mod`. It includes the
  Apache-2.0 text referenced by goffi's attribution notice. These are embedded at
  `/assets/licenses.txt`, so the installed standalone executable retains them.
- On macOS, `github.com/gogpu/systray` v0.3.0 implements a menu bar companion. It uses
  Go FFI to load the built-in AppKit frameworks, without CGO. The server launches the
  same executable as a separate menu process. It needs no `.app` bundle or additional
  executable. Other platforms do not load native menu code.
- `make build`, `make release`, `make test`, and `make check` build frontend assets
  before compiling Go. `make web-build` builds only the frontend. `make web-check`
  compiles and runs frontend fixtures. Direct Go commands need frontend assets first.
- The server uses the pinned pure-Go `github.com/gitpod-io/xterm-go` headless emulator.
  It owns terminal screens independently of client connections.
- A detached Go server owns pseudo-terminals (PTYs) and SQLite. Clients use JSON text
  messages over WebSocket at `/ws`, on an HTTP server bound to IPv4 loopback. The Go
  transport uses `github.com/gorilla/websocket`. Byte blobs use base64 encoding. The CLI
  and browser clients share the same protocol. See [PROTOCOL.md](PROTOCOL.md).
- Every new session starts an interactive shell with `-i`, using the server environment.
  The server resolves `$SHELL` from PATH or an absolute path, falling back to `/bin/sh`
  when unset. Workspaces accept absolute paths, `~`, and `~/path`.
- `make build` creates the development binary at `bin/bonbon`.
- `make release` creates the production binary at `bin/release/bonbon`.
- `make release VERSION=X.Y.Z` embeds that version. Unversioned builds report `dev`.
- `make release-assets VERSION=X.Y.Z` builds macOS Apple Silicon and Intel archives, the
  shell installer, and SHA-256 checksums under the ignored `bin/releases/vX.Y.Z/`.
- `make test` and `make check` run Go tests and vet.

The SQLite driver exposes query authorization and cancellation through supported APIs.
This keeps read-only query enforcement in SQLite and avoids a custom SQL parser.

Storage uses format version 8 with projects, sessions, runs, events, settings,
preparations, worktree metadata, archive flags, and run indexes. Embedded SQL migrations
upgrade formats 3–7 automatically at server startup. Format 8 needs no migration.
Settings include the instance appearance. Each tool can have an optional continue command.
Commands and APIs may still change during early development. Database upgrades preserve
durable data.

The history package separates schema and models, session/run operations, event capture,
replay, and read-only SQL. Database access stays inside that package. Server handlers
call its methods. Ordinary client commands do not open the live database.

## Commands

See [COMMANDS.md](COMMANDS.md) for human-readable usage, examples, and effects.

| Command | Implemented behavior |
| --- | --- |
| `bonbon --version` | Print the invoked executable's version without contacting a server or opening an instance. |
| `bonbon update` | Install the latest macOS release at the invoked executable's path without restarting a server. |
| `bonbon server start/stop/restart` | Manage the detached server. Stop/restart finalizes active runs. |
| `bonbon ui` | Verify the selected server and open its home page in the default browser. Requires a running server. |
| `bonbon query SQL` | Run one read-only SQL query and return JSON. SQL chooses the scope. |
| `bonbon skill` | Print the embedded Markdown guide for agents without contacting a server or opening an instance. |

Every command accepts global `--dir DIR` before the command name. It selects the BonBon
instance. The UI selects session workspaces. There are no CLI session operations or
terminal attachments. `bonbon ui` takes no workspace or session arguments.

There is no implicit session filter or `history` command group. Queries return JSON with
`columns`, `rows`, and `truncated`. Raw BLOBs use base64. Requests go through the
server. There is no bearer token or credential exchange.

`bonbon skill` prints `cmd/bonbon/skill.md`, which the executable embeds. The guide
covers the environment variables, `bonbon query`, the archive tables and event kinds,
example queries, and limits. It describes only the newest supported database format.
Fixtures compare its tables and columns with the migrated schema. They also run each
example through a shell against a test server.

The server listens only on `127.0.0.1`. It does not support remote access. Clients
require an explicitly started server.

## Release installation

GitHub Releases provide versioned macOS archives, checksums, and `install.sh` for the
installer and `bonbon update`. Each archive contains `bonbon`, `LICENSE`, and
`THIRD_PARTY_NOTICES.txt`. The installer extracts only the executable. That binary also
embeds all notices. The installer uses curl and macOS plutil, with no GitHub CLI
dependency. Downloads need no credentials.

An optional `GITHUB_TOKEN` environment variable authenticates GitHub API requests. The
installer passes the token to curl through stdin. It does not put the token in process
arguments or a file.

The POSIX shell installer supports macOS `arm64` and `x86_64`. It resolves the latest
published full release once, then downloads the architecture archive and checksum file
from that fixed tag. `--version X.Y.Z` selects a specific release. Other version formats
are rejected. It installs into `~/.local/bin` by default.

`BONBON_INSTALL_DIR` overrides this default. Installer `--dir` overrides both. Each
override must be an absolute path.

For latest-release installs, an existing equal or newer release is left in place,
without downloading binary assets. Explicit version selection can reinstall or
downgrade. The installer verifies SHA-256 before it reads the executable from the
archive. It checks the version before replacement through a rename in the same
directory. Failures before replacement preserve an existing executable.

Existing destination symlinks are rejected. Downloads and staging directories are
removed on exit. It does not edit PATH, require sudo, alter history, or restart a
server.

Installer `--check` compares the installed executable at the selected installation path
with the requested or latest version, including numeric version ordering. It changes no
installed files and downloads no binaries. Development versions cannot be compared.

`bonbon update` runs the embedded copy of `internal/install/install.sh` with the invoked
executable's directory. It resolves invocation symlinks and requires the target filename
`bonbon`. Development builds and unsupported platforms are rejected. The command has no
options and ignores instance and installer directory settings. It uses the same curl
download, verification, and atomic replacement as initial installation. It never
downloads or executes a remote installer script.

The installation directory must be writable. Existing servers and sessions continue.
Users restart them explicitly when ready. Failed downloads or verification preserve the
installed executable. Database migrations run only when the new server starts, not
during `bonbon update`.

There is no UI update action, background check, or automatic update. The executable
version does not identify an already running server's build.

The tag-triggered Release workflow tests Apple Silicon and Intel macOS runners before
publishing assets. Release notes are stored in `docs/releases/`. Linux and Windows
packages, Homebrew packaging, and Apple Developer ID signing/notarization are absent.
The installer and release smoke checks use temporary directories. Installer fixtures use
synthetic binaries and GitHub API responses. They do not access real credentials.

## Server lifecycle

`start` uses the invoked executable to launch a new detached process, with standard
input disconnected and output appended to `server.log`. It waits up to two minutes for a
successful protocol handshake, including database upgrades. A second start leaves the
matching server unchanged. `stop` requests shutdown through the protocol and waits for
the archive lock to be released. `restart` completes stop before launching the invoked
executable again.

Shutdown uses the verified server's advertised protocol version, so rebuilding with a
new session protocol does not block stop or restart. It requires the same greeting and
shutdown envelope, including an explicit `stopping: true` acknowledgment. It does not
retry with other formats or signal a saved PID.

Lifecycle commands serialize within an instance directory. An archive lock prevents
multiple servers from owning it. When the lock is free, lifecycle commands can discard
stale `server.json` information. They never use a saved PID or port to stop another
process.

If the lock is held, lifecycle commands require a verified server connection. Missing,
malformed, or mismatched connection information causes an error instead of starting a
duplicate or stopping an unrelated server. A failed stop does not start a replacement.

Production defaults to `~/.bonbon`. Development defaults to `~/.bonbon-dev`. All
commands select the instance with global `--dir`, then `BONBON_DIR`, then the build's
default. The server binds `127.0.0.1:0` and atomically publishes its assigned port and
random instance ID in `server.json`, with private permissions.

The file also includes protocol version, PID, canonical directory, and executable path.
It is disposable and removed after handlers and agents stop, before releasing the
archive lock. Shutdown leaves the descriptor intact if it belongs to another server
instance.

CLI clients read the connection file and open a WebSocket to its loopback port. The
server sends a `server` greeting first. Before sending any operation, the client
verifies the greeting's protocol, canonical directory, instance ID, PID, and port
against `server.json` on that same connection. This prevents stale metadata from
directing a command to another instance. A stop request also carries the instance ID
from that connection's greeting. Health checks read the greeting and close without
sending an operation.

Session operations and health checks require the current protocol, with no version
fallback. Shutdown uses the version verified above. The current version is `bonbon/23`.
Each WebSocket message has a 16 MiB limit, including all fragments. Each message carries
exactly one JSON object.

The server rejects binary messages and invalid JSON. There is no extra length prefix.
Protocol 15 creates independent project drafts and adds archive/restore, collection
search, and pagination. SQLite format 6 adds a session archive flag.

Settings, preparations, and worktree metadata remain server-owned. Formats 3–7 upgrade
automatically to 8 at server startup. Reload the UI after starting the new server.
Protocol 18 adds `session-continue` and `session-handoff` for a new terminal in an ended
session. Protocol 19 adds `session-terminals` and an optional `run` for
`session-resume`, so a view can show an earlier terminal. SQLite format 6 does not
change.

Protocol 20 adds `history-search` and `history-context`. These operations read existing
recordings. SQLite format 7 adds run indexes through migration 7 without changing
records.

Protocol 22 adds the derived [session status](#session-status) to session summaries and
session details. It also adds the `status` message of a live terminal stream, the
`status-watch` stream, and the run status and run ID in the `exit` message. The SQLite
format does not change.

Protocol 23 adds `workspace-folders` for the Files tree of the
[Changes pane](#changes-pane). `workspace-file` also reads a file in a folder that is
not a Git repository. The SQLite format does not change.

HTTP serves `GET /ws` for the WebSocket upgrade, `/` for the embedded UI, `/assets/` for
its static files, and `GET /client-config` for browser connection information. All
session operations and history reads use WebSocket. There is no separate UI API. The
request Host must be `127.0.0.1:PORT` or `localhost:PORT`. If present, Browser Origin
must match the request host and port.

The server rejects foreign and opaque origins. CLI connections omit Origin. This is an
origin policy, not user authentication. HTTP headers, the upgrade, and the first
protocol message have five-second timeouts. Attached sessions require traffic within 30
seconds.

Clients send heartbeats every five seconds. Frames have a 30-second acknowledgment
deadline. Writes time out after five seconds. Shutdown closes HTTP connections and waits
for upgraded handlers and agent cleanup before releasing the archive. An upgraded peer
that sends no request can delay shutdown until its five-second request timeout.

### macOS menu bar

New servers launch a menu companion by default on macOS. `server start --no-menubar` and
`server restart --no-menubar` disable it for that server process. A repeated start keeps
the existing server and its menu choice. Restart replaces both processes.

The menu contains **Open UI**, a separator, and **Quit BonBon**. The Quit BonBon label
shows the running version, such as **Quit BonBon (0.0.5)** or **Quit BonBon (dev)**.
Preview builds can set a version label at build time, such as **Quit BonBon (0.0.5
dev-1af9)**. Open UI calls the same verified home-page opener as the CLI.

The build renders the menu icon from `web/src/bonbon.svg` and embeds it in the
executable. The icon shows a candy wrapper with a terminal prompt and uses macOS
template coloring.

Quit retains the connection information verified when the companion starts. It
reconnects to that endpoint and verifies the original server identity on the shutdown
connection, without rereading `server.json`. It requests graceful shutdown and waits for
the server's lifetime pipe to close. Missing or replaced connection files do not prevent
Quit. A replacement instance, including one reusing the original port, cannot be stopped
by an old menu.

BonBon accepts one menu action at a time. During shutdown, the menu shows
**Quitting BonBon…**. If an action fails, the menu shows a retry label and writes
diagnostics to the server log. Actions run outside the native UI thread.

The server owns an inherited pipe to its menu. On normal shutdown it finishes session
cleanup and closes SQLite, closes the pipe, waits for the companion, then releases the
archive lock. A companion that does not exit within three seconds is killed through its
original process handle. Server crashes also close the pipe and remove the icon. This
does not prove that agent processes from the crashed server stopped.

The companion verifies its parent before entering the AppKit event loop. It requires a
logged-in macOS desktop. A failed or killed companion does not stop the server or its
sessions.

The server does not automatically relaunch it. To restore it, restart the server. There
are no native notifications, login items, settings, or global shortcuts. No protocol or
storage format change was needed.

## Web client

The sidebar and browser favicon use the same wrapped-terminal logo as the macOS menu
bar. The visible product name is BonBon. The favicon adapts to light and dark browser
appearances. The sidebar mark uses its text color.

Server start and repeated start print a clickable HTTP URL without opening a browser.
`bonbon ui` verifies the selected instance through the same WebSocket health check as
the other CLI commands, then opens the home page at `http://127.0.0.1:PORT/`. It uses
`open` on macOS and `xdg-open` on Linux. It starts no server or agent. Missing or
mismatched server information prevents browser launch.

Launcher failures include the URL for manual opening. Global directory selection applies
as usual. The UI uses that same origin, reads its `ServerInfo` from `/client-config`,
and checks protocol, instance ID, directory, and port against every WebSocket greeting.

A changed server requires a reload using its current URL. Assets and configuration
disable caching. Host checks apply to every route. A content security policy restricts
scripts and network access to the local origin and blocks framing. Terminal libraries
are served locally.

The sidebar lists saved projects and groups sessions, including drafts, in pages of 100
through `project-list` and `session-list`. General appears first. Custom projects follow
in name order. Groups can be collapsed in each view.

A vertical divider on the right edge of the sidebar changes its width. Drag it with a
mouse or touch. Or focus it and use Left/Right to resize. Use Home/End to reach the
limits. A double-click restores the default width. The default width is 278 pixels, or
240 pixels below a window width of 950 pixels. The width stays from 240 to 480 pixels,
and the main area keeps at least 400 pixels.

The toolbar button at the left of the session title hides or shows the sidebar.
Command-B does the same on macOS. Ctrl+B stays available to terminal programs. Width
and visibility stay with the browser view across session switches and reset on reload.
Below 620 pixels, the sidebar is above the main area and the divider is not available.

Server-side search matches project names and paths, or session titles, workspaces, and
IDs, before pagination. It uses SQLite's case-insensitive ASCII matching and treats
wildcard characters literally. This UI does not search message or terminal contents.
Previous and Next reach older results. Each page reflects current activity. Activity
changes can move items between pages.

The list refreshes every five seconds while visible. Project names are plain text. The
small arrow expands or collapses a group. Each project's **＋** creates and selects a new
draft entry. A click on an existing entry reopens it by session ID. The URL keeps that
ID as `/sessions/<id>` through reload and launch. The welcome view is the home page at
`/`. The BonBon logo in the sidebar returns to it.

The browser tab title shows the session or draft name. Settings shows `Settings`, and
the home page shows `BonBon`.

**Archive** saves the current launch choices and message editor. It hides a draft or
finished session from the normal list and returns to the welcome view. **Archived**
provides the same search and pagination across all archived sessions. **Restore**
returns an item to its project, or Standalone if that project was removed, without
launching it.

The archive flag is separate from draft/run status. Archiving preserves all SQLite
records, draft revisions, attachments, workspace files, and worktree metadata. BonBon
rejects archive requests for active sessions and unfinished launch claims. Stop the
session first. Archive changes and launches share the server launch lock.

Archived drafts can be edited and finished output can be read. Start requires restoring
the draft first. Other open views retain their selection and see archive changes on
refresh. The server also checks archive state at Start. Read-only SQL includes archived
data unless filtered explicitly. There is no permanent delete action.

The UI renders titles, errors, and recorded output as text. It never treats them as
HTML. Each tab has its own selected session. Tabs can share a session. Every tab can
type and send messages. The PTY uses the size of the tab that most recently sent input.

### Session preparation, settings, and worktrees

Settings is an instance-wide page at `/settings`. Its URL has no session ID.
**Appearance** offers **System**, **Light**, and **Dark**. System is the default and
follows the device appearance. **Save settings** applies the theme to the current view
and stores it in SQLite. Other views read the saved theme on reload or when they open
Settings without unsaved edits. The server includes the theme in each page so it applies
before the first render. If the server cannot read the settings, the page uses System.

The theme covers the workspace, dialogs, terminal, and Changes pane. Dark uses charcoal
surfaces, a near-black terminal, and blue for primary actions and focus. The terminal
renders the colors supplied by each program. Light also uses a dark terminal. A browser
without CSS `light-dark()` support uses the Light palette.

Settings also has a default tool, default worktree choice, default Git base, and an
ordered list of named commands. Shell is built in and sends no startup command.
Users can add, edit, reorder, and remove other presets. A command is one line of shell
syntax, at most 1,000 UTF-8 bytes, without control characters. Each preset can have a continue
command for [Continue in a new terminal](#continue-in-a-new-terminal). It has the same
limits and contains `{prompt}` once, without quotes around it. BonBon does not install
tools, choose models, or check provider-specific arguments. Commands may contain secrets
and are stored locally in the same unencrypted archive as terminal input.

The server copies defaults when it creates a preparation. Non-Git folders do not enable
the worktree default. A preparation stores its chosen tool name and command
independently of later preset changes, including deletion. Startup commands are edited
only in Settings. When the user selects a different tool, the server copies its current
command. Shell clears the command.

The preparation keeps its project and workspace. Message drafts and attachments work
before a run exists. Each project supports multiple independent drafts, including
General. Each draft keeps its own name, tool snapshot, worktree choices, message text,
and attachments across views and server restarts. **＋** always creates a new draft.

A reopened sidebar entry keeps its choices and message. Launch settings use optimistic
revisions, separately from message revisions. A launch settings conflict preserves the
local edits and reports an error. Message drafts sync between views, as described in
[Message editor](#message-editor). Unsent edits warn before unload.

Start claims the saved revision before creating files or a process. Duplicate starts and
edits to an already claimed preparation fail. Reopening or reconnecting never resubmits
the startup command. Failed preflight checks keep the preparation editable.

The server preserves an uncertain checkout or launch and marks it interrupted. It does
not retry automatically, including after server restart. Start creates an interactive
shell and records the configured command as input before writing it once to the PTY. The
shell remains after an ordinary command exits. Shell startup files that read or discard
stdin can affect queued input. BonBon does not detect prompt readiness or retry this
input.

The server uses the installed Git executable to detect repositories, including linked
worktrees and repository subfolders. Creating a worktree requires an existing commit.
Repositories and bases containing submodules are rejected.

The chosen base (default HEAD) resolves to a commit at Start, without fetching. BonBon
creates a fresh branch (user-named or generated as bonbon/TIMESTAMP-SUFFIX) and checkout
under `<instance>/worktrees/YYYYMMDD-HHMMSS-XXXXXXXX`, using UTC and a random suffix.
Repository subfolder projects launch in the corresponding subfolder. Missing or escaping
subfolders fail the launch and preserve the checkout for inspection and explicit
cleanup.

SQLite records the checkout path, repository, requested base, resolved commit, creation
branch, and lifecycle state. Sessions retain their actual launch paths. The sidebar
shows the creation branch. It does not track later branch changes in the shell.

Only committed files are checked out. Uncommitted changes, untracked/ignored files,
dependencies, and local environment files are not copied. Worktree files remain outside
SQLite and outside the planned database backup. Git worktrees share repository metadata.
They provide independent working files. They are not a security sandbox.

Closing views, stopping sessions, and removing projects preserve worktrees. **Remove
worktree** checks all live BonBon session paths and refuses active or overlapping
workspaces. It also refuses detached HEADs, replaced repositories, and modified,
untracked, or ignored files, and uses Git removal without force. It preserves the branch
and all session history.

External processes and concurrent edits outside BonBon are not coordinated. Git manages
its locks and linked-worktree metadata. Missing or moved repositories cause explicit
errors.

### Projects and launches

`project-add` saves an existing canonical directory and a name, defaulting to the folder
basename. Git is not required. Canonical paths are unique across saved projects. Parent
and child folders remain allowed. Project IDs are independent of their names and paths.

Names contain 1–200 characters without control characters. Custom projects can be
renamed and removed. Removal sets their sessions' `project_id` to NULL. The UI shows
these sessions under Standalone. Removal preserves recorded workspace paths, runs,
recordings, drafts, and files. `session-rename` changes a session title without changing
its ID or recorded activity.

On startup the server creates the General project with ID `general` and a private
`<instance>/workspaces/general` folder. General cannot be renamed or removed. The folder
is created only after opening a supported database. At startup, its saved path uses the
selected instance location.

Old sessions retain their original workspace paths. Project metadata is authoritative in
SQLite. Files created in General are ordinary workspace files outside the database, like
files in custom projects.

Clicking **＋** beside a project opens its saved preparation without launching a process.
There is no global New session button. The main area has the session name, tool, and
worktree choices above a persistent message editor. **Start session** replaces the upper
form with its terminal and adds the session to the project's list.

The message and attachments remain in that session. Clicking **＋** again creates its
next draft. Launch settings and message drafts save separately. Project removal
preserves unfinished drafts and sessions under Standalone. It does not associate them
with another project.

The server resolves its `$SHELL` and starts it with `-i`, using `/bin/sh` when unset.
The server rejects a nonempty relative shell path. It accepts names on PATH and absolute
paths. Requests cannot override the shell or environment.

A selected tool supplies an optional startup command to submit through that shell. The
server inherits its startup environment and sets `TERM=xterm-256color`. An empty title
defaults to the selected tool name and workspace basename.

Workspaces accept absolute paths, `~`, and `~/path`. Home expansion uses the server's
`HOME` from startup, before canonicalization. Other relative paths, `~user`, and
environment-variable expansion are unsupported. The directory must exist. History stores
its canonical absolute path. Multiple sessions may share it.

The shell reads its normal startup files. Agents retain their arguments, authentication,
and permissions. BonBon submits only the configured startup command. It does not submit
the message draft automatically. After an agent exits, the shell remains available.
After the shell exits, the session ends.

xterm.js displays server-rendered frames and forwards keyboard input, paste and resize
requests through the shared stream. The server uses the saved tool command without
adding provider flags or prompts. Source terminal queries are answered by the server,
including while detached. Generated frames exclude hyperlinks, clipboard requests and
other non-display source escape sequences.

Selecting another session closes the old view before opening the selected one. Closing
or refreshing the tab leaves work and recording running. Refresh reopens the project
draft or session identified in the URL path, or Settings at `/settings`. Transport
failures trigger automatic reconnect with increasing delays from 0.5 to 30 seconds. The
last screen stays visible and input is disabled until a fresh frame is rendered.

A session connection owns its peer, rendered-frame state, and retry timer. Closing that
view cancels retries and ignores late callbacks from the old connection. Protocol and
instance mismatches require explicit recovery. A changed server port requires reopening
the UI. Input and session creation are never retried automatically.

The server sends a full current screen and up to 10,000 normal-buffer scrollback rows,
then generated row changes. Each frame is acknowledged after xterm finishes parsing it.
Each view has at most one outstanding frame, so slow rendering coalesces intermediate
redraws while capture continues. Partial source escape sequences and UTF-8 remain inside
the server's emulator. Clients receive complete render operations.

A view keeps at most 8 MiB of rendered scrollback rows, so rows with many styles lower
the row count. A frame carries at most 11 MiB of rendered data. A full frame always
includes the visible screen and omits the oldest rows that do not fit. A view narrower
than the terminal keeps its own cache of cropped rows. Each of its frames renders only
new rows.

Frames preserve visible cells, colors, cursor position, bracketed paste, application
cursor/keypad and mouse modes. Advanced terminal graphics and extended keyboard
protocols are not forwarded. Rendered rows visually preserve recorded wrapping. Client
rows do not preserve soft wraps during copy or reflow. Normal scrollback remains
available while an alternate screen is visible. Erased output and exited alternate
screens remain in the original recording.

Ended sessions display the saved final view of their latest terminal with its recorded
dimensions. A normal exit or stop writes a derived `terminal-screen` event for that run
to SQLite. Interrupted recordings without a final screen are reconstructed on the server
from the events of that run only, in pages of 64 original display events. Historical
queries are discarded and recorded input is never sent to a process.

Large interrupted recordings can take longer to reconstruct. This restores a display,
not a process or native agent context. Terminal dimensions are limited to 2–512 columns
and 1–256 rows to bound emulator memory.

Session views show the server-rendered terminal and message editor. The UI also provides
sent messages, recorded-output search, and a read-only Changes pane. There is no browser
SQL client. The `bonbon query` command reads archived events. There is no semantic chat
transcript.

### History search

**Search history** opens a modal dialog with a result list and a context pane.
Command+Shift+F on macOS and Ctrl+Shift+F open the same dialog. Ctrl+F remains available
to terminal programs. The dialog does not send input, resize the PTY, or change
sessions. Closing it leaves recording and the active session connection running.

The selected session is the default scope. This scope includes all its earlier
terminals. **This project** uses current project membership. **All sessions** includes
standalone sessions and other projects. Every scope includes archived sessions. Without
a selected session, the dialog selects **All sessions** and waits for search text.

Search matches literal text of 1–256 Unicode characters. It ignores case through simple
Unicode folding unless **Match case** is selected. It does not expand characters or
normalize Unicode. Wildcards, SQL syntax, and markup have no special meaning.

The history service uses parameterized SQLite reads on a separate read-only connection.
It streams existing `output` event text through bounded matching state for each run.
Matches can cross any number of event boundaries. They never cross terminals or
sessions. Original events remain unchanged. Format 7 supplies event indexes for
run-scoped reads. There is no full-text search index.

Results follow recording order, from oldest to newest. A match uses the event that
completes its text. Each result identifies its session, terminal number, recorded tool,
and time. Search and the terminal selector use the same tool-name fallback. For an older
first terminal without a recorded tool, they use the saved preparation. Other missing
names appear as **Tool not recorded**. The initial page has at most 20 results. **Show
more results** appends the next page below them.

The status says **results loaded** while more matches remain. Otherwise, it reports the
final count and hides that button.

The first page fixes the highest event sequence. Later pages and context reads use that
same cutoff, so new output does not move existing results. A new search includes later
output. Each page scans at most 32 MiB or 100,000 nonempty output events, with a
five-second deadline. Empty text does not consume the event limit.

Search reads fixed ranges of 4,096 event sequences in primary-key order. Project scope
cannot sort the whole project before returning its first row. Each completed range
advances the cursor, including ranges with only empty or out-of-scope events.

A bounded scan returns its results, an `incomplete` flag, and a cursor for the next
character when progress permits continuation. The status shows **Search incomplete**,
and **Continue search** reads forward from that cursor. If the deadline permits no
progress, search replaces continuation with **Retry search**. Retry keeps the attempted
cursor and fixed recording cutoff. A changed query or scope starts a new search. It
preserves the incomplete state and any results. An empty partial page remains
incomplete. A later page restores bounded lookbehind per terminal, so split phrases and
overlapping matches survive the boundary. Completed scans report the final count. Caller
cancellation stops the request.

The service bounds matcher storage to 262,144 source positions. Evicted state is rebuilt
from recorded lookbehind. Requests allow at most 50 results. There is no result-offset
limit or rescan of the whole prefix. Large-archive performance remains unverified.

Each result includes a snippet with the complete match, up to 120 preceding characters,
and up to 180 following characters across output events of the same terminal.
Following-text and display reads share a separate one-second budget per page. A failed
snippet read preserves the available text. Selecting a result loads its full initial
context separately. A context error preserves the snippet and results. **Show more
before** and **Show more after** add 512 characters on their respective side. Each side
stops at 8,192 characters with an explicit limit label. Context reads skip empty text
and stay within the selected run's output bounds and recording cutoff. They have a
five-second timeout. Source references retain session, run, sequence, and character
offsets.

Each read caches metadata only for the runs it uses. First and last nonempty output and
the first start event use direct indexed lookups. Context and lookbehind queries use
those bounds. Search does not aggregate all events of a session. Terminal lists and
handoff run bounds use the same run indexes.

Changing the query or scope, closing the dialog, or selecting another result cancels
obsolete requests. The client closes their WebSockets. The server cancels their SQLite
work on disconnect and stops its disconnect reader after a reply.

The result list and context pane render text nodes with a highlighted match. They never
execute terminal escapes or interpret HTML or Markdown. **Copy context** copies only the
displayed text. Late replies cannot replace a newer search or a different selected
result. On narrow screens, the result list appears above the context pane.

Display text removes the second line break only for verified original CRLF pairs. It
also recognizes pairs split across output events. A verified CRCRLF sequence hides the
redundant CR. Literal blank lines remain visible. Forward verification respects the
recording cutoff. Stored derived text and match offsets remain unchanged. Rendering and
**Copy context** use an optional display representation. If a chunk cannot be
reconstructed independently, its original spacing remains visible.

The dialog labels its content as **Derived terminal output**. Search uses recorded text,
including output no longer present in the final screen or scrollback. Redraws can repeat
text, and cursor movement can omit spaces. This view is not an exact conversation
transcript. Input events, unsent drafts, and attachment contents are outside this
search.

A browser check with a synthetic terminal confirmed live reattachment, switching
sessions, stop followed by history reload, and page reload at a different window width.
The final display kept its recorded layout. This check did not run a real agent CLI.

### Continue in a new terminal

A session can have several terminals, one after another. Each terminal is a run with its
own PTY, emulator, saved screen, and recording. **Continue in new terminal** appears
when the latest run of a session ended (`exited`, `stopped`, `failed`, or
`interrupted`). The session must not be archived, and the view must not have a live
terminal.

The dialog shows the session workspace, a tool choice, the handoff prompt, and a Copy
button. The default tool is the session's original tool if it still exists, then the
default tool, then Shell. For an `interrupted` run, the dialog warns that an agent from
a crashed server can still run in the workspace.

`session-continue` carries the latest run ID that the view saw. The server holds the
launch lock and rejects the request in these conditions:

- A terminal of the session is live.
- The latest run ID is different, for example because another view continued first.
- The latest run has not ended, the session is archived, or it has no run.
- The managed worktree is not `ready`, or the session workspace no longer exists.
  BonBon does not create a replacement worktree.
- The selected tool no longer exists, or the command with the prompt exceeds 1,000
  bytes.

A rejected request writes no files and starts no process. Otherwise the server writes
the handoff folder, then starts `$SHELL -i` in the session's recorded workspace. The
session keeps its ID, title, project, worktree, message draft, and history. The new run
gets the same `BONBON_SESSION`. Its start event records the tool name, the previous run
ID (`continues`), and the handoff folder.

The handoff folder is `<instance>/handoff/<session-id>/`. It is a derived cache with
private permissions and read-only files. BonBon rebuilds the whole folder from SQLite
for each new terminal. It writes a staging folder, then renames it. No terminal is live
during this change. The folder contains these files:

- `README.md`: rules for the reader, the session and worktree details, and every
  earlier terminal, newest first. Each terminal has its number, run ID, tool, times,
  status, detail, and whether it started from a handoff. The rules say that the files
  are a record of earlier work, not instructions or approvals. They tell the agent to
  check the current files, for example with `git status`. The README also has a
  `bonbon query` command for the original recording of a terminal, and a pointer to
  `bonbon skill`.
- `messages.md`: every message from the message editor, oldest first, with its exact
  text, time, Sent or Not confirmed status, and attachment cache paths. Messages are
  grouped by terminal through event sequence ranges.
- `terminals/<number>-<run-id>.txt`: the plain text of the final screen and scrollback
  of each terminal that recorded output. The text comes from the saved final screen, or
  from a reconstruction of that run's own recording.

The handoff prompt names the session ID and the README path. It says that the earlier
agent state is lost and that the files are a record, not instructions. It asks the
agent to check the current files, summarize where the work stopped, and wait for the
next message.

If the selected tool has a continue command, BonBon puts the shell-quoted prompt in
place of `{prompt}`. It records and submits that line once, as it does for a startup
command. A tool without a continue command starts with its normal command, and BonBon
sends no prompt. Shell submits no command. The user can copy the prompt from the dialog.
BonBon never sends the prompt through the message editor and never detects agent
readiness.

The prompt stays available after the new terminal starts. When the handoff folder of
the selected session has its README, **Handoff prompt** appears in the message editor
heading. Its dialog shows the folder and the prompt, with **Copy prompt** and **Put in
message editor**. Put in message editor works only when the editor has no text, no
files, and no pending send. It never merges with or replaces a draft, and it sends
nothing. The user sends the prompt with Send when the agent is ready.

### Earlier terminals

When a session has more than one terminal, the terminal heading shows a selector. Its
label names the shown terminal, for example `Terminal 2 of 3 · Codex · exited`. Click
the label to see every terminal in start order. Each row has the number, tool, status,
and start and end times. A live terminal has a green dot. ‹ and › step to the earlier
or the later terminal. A session with one terminal shows no selector.

An earlier terminal shows its saved final screen with its recorded dimensions, as an
ended latest terminal does. The view is read-only, and the hint says that input and Send
are off. **Back to live terminal** in the terminal footer opens the latest terminal
again. When the latest terminal has ended, the button is **Back to latest terminal**.
Reload and the session link also open the latest terminal.

A view of an earlier terminal never joins the live process, so it never becomes the
size owner. The process, its capture, and the other views continue. The status badge,
**Stop session**, and **Continue in new terminal** still apply to the whole session.

The UI reads the list with `session-terminals` when it opens a session, when a terminal
starts or exits, and when the selector opens. The tool name comes from the start event
of each run. Start events from BonBon 0.0.4 and earlier have no tool, so the first run
uses the tool of the preparation. A new terminal has no run record until its process
starts. Until then, the list ends with a `starting` terminal without a run ID. The UI
reads the list again every five seconds until that terminal has a run.

### Changes pane

The pane icon in the session toolbar has the tooltip **Show changes and files**. It
opens a read-only pane to the right of the terminal and the message editor. It shows
the changes and the files of the session workspace. Drafts have no Changes pane. The
pane never changes files, the Git index, or SQLite. Ended sessions keep the pane while
their workspace exists.

- **Compare with** selects the baseline. **Since worktree base** compares the recorded
  commit of a ready managed worktree with the current files. It includes commits that
  the agent made, and it is the default for a managed worktree. **Uncommitted changes**
  compares `HEAD` with the current files. A repository without commits uses the empty
  tree. The labels do not claim that one session made the changes, because other
  sessions and tools can share a workspace.
- **Split** shows the old and new file side by side. **Unified** shows one column with
  removed and added lines. When the editor area is narrower than 520 pixels, the pane
  shows Unified and marks it as pressed. Split keeps a dashed border until the pane is
  wide enough. Unchanged regions fold into bars. Click a bar to show its lines.
- Both layouts use green for added lines and red for removed lines. Stronger fills mark
  changed text. Split shows a gutter marker for each changed line. Unified shows one
  `−` per block of removed lines and one `+` per added line. Syntax colors, line numbers,
  and folded regions follow Appearance. The file view uses the same syntax colors.
- **Changed** lists the changed files with Git status letters A, M, D, R, and T. An
  untracked file has A. After `git rm --cached`, the path has one row with M. An
  untracked nested repository shows as one folder row. The filter box matches any part
  of a path without case. A long path keeps its file name in view and shortens its
  folder.
- **Files** shows the workspace folder as a tree. Click a folder to open or close it.
  The pane reads a folder when it opens. The tree puts folders first and sorts names
  without case. It omits `.git`. It includes the entries that Git ignores, in a muted
  color. A changed file shows its status letter. A folder with a change below it shows
  a dot. A deleted file is not in the tree. An open folder without entries shows
  "Empty folder".
- With text in the filter box, **Files** shows a list in place of the tree. The list has
  the paths that match, from the paths that Git tracks or does not ignore, and from the
  deleted files.
- A file that you select in **Files** opens in the file view. A file that you select in
  **Changed** opens as a diff. A symlink opens as a file with its target text.
- The file header shows the path and the line counts. For a changed file, **View file**
  and **View diff** change between the file view and the diff. An unchanged file has
  only the file view. **Copy path** copies the path relative to the workspace.
- The pane reads its lists when it opens, on **Refresh**, on a click on **Changed** or
  **Files**, and when the window gets focus. It does not watch files. A refresh reads
  each open folder again. It closes a folder that is gone. A refresh keeps the shown
  file when its content is the same.
- Only the latest request for a folder changes its entries. A reply or a failure of an
  earlier request does nothing, also after the folder closes and opens again.
- The keyboard focus stays on its row when the list changes. Thus Tab moves from an
  opened folder to its entries.
- A folder that is not a Git repository shows **Files** only. **Changed**, **Compare
  with**, and the filter box are off there, and the file view shows the current file.
  When the server has no Git executable, **Files** and the file view work in the same
  way, and **Changed** shows the error.

A drag on the divider or the Left and Right arrow keys change the pane width. The pane
width, the layout, the scope, the baseline, the open folders, and the selected file
belong to the view.
Other browser tabs keep their own state. A visit to Settings or the home page keeps the
state. A different session or a reload resets it.

The server resolves the workspace and the baseline commit from the session ID. It never
accepts a workspace path from the client. A repository subfolder session sees only its
own folder, with paths relative to it. The server reads current files through `os.Root`.
`..`, absolute paths, and symlinks that leave the workspace are refused. A symlink shows
its target text on both sides, as in Git, and is not followed. Special files are not
opened. A folder list has a symlink as one entry. The server does not list a path that
is a symlink or that goes through a symlink.

Git runs with `GIT_OPTIONAL_LOCKS=0`. Thus it does not take `index.lock` from a live
agent. It also runs with literal pathspecs, `core.fsmonitor=false`, `--no-ext-diff`,
`--no-textconv`, and a 10-second timeout. A client disconnect cancels the Git work, and
the scan of untracked files stops at the file limit. Clean filters from the repository
configuration, such as Git LFS, still run when Git compares work files. Git messages use
the C locale. Only a "not a git repository" message from Git shows "Not a Git
repository." Other failures, such as a missing Git executable or a `safe.directory`
refusal, show their error.

For the ignore marks of the tree, the server runs `git check-ignore` in each listed
folder. Thus a submodule and a nested repository use their own ignore rules. This
command does not support literal pathspecs. The server sends each name with a `./`
prefix through standard input, so that Git reads it as a path. When this command fails,
the tree shows the entries without ignore marks, and the pane shows the error.

Limits:

- Each side of a file holds at most 1 MiB. A larger side shows a note instead of text.
- A side with a NUL byte in its first 8000 bytes, or with invalid UTF-8, is binary. The
  pane shows a note instead of its content.
- The changed list holds at most 5,000 files, and the filter list of **Files** at most
  20,000 paths. A longer list shows a note.
- One reply of folder lists holds at most 20,000 entries. A folder with more entries
  shows a note and an arbitrary part of its entries. One request names at most 200
  folders. A refresh closes the open folders above this number.
- The open folders of a refresh share this entry limit. When the limit cuts the list of
  a folder, the pane keeps the shown entries of that folder. It then reads the folder
  again in a request of its own.
- A failed request for one folder shows its error. A folder with shown entries stays
  open and keeps them. A folder that opened without entries closes.
- Line counts of untracked files use at most 32 MiB of reads for each list. Later
  untracked files show no count.
- A folder that is not a Git repository has no changes and no filter. The tooltip of
  **Changed** is "Not a Git repository."

### Message editor

The multiline composer stays visible below preparation and terminal views. A horizontal
divider with a centered grip resizes the terminal and editor after launch. Drag it with
a mouse or touch. Or focus it and use Up/Down to resize.

Use Home/End to reach the limits. Both panes keep a minimum height. Editor contents
scroll when needed. The editor size stays with the browser view across session switches
and resets on reload. Size changes use the existing terminal viewport updates.

A viewport change resizes the PTY only from the size owner view. Direct terminal
interaction remains available.
Enter inserts a newline. Send sends one `input` control to the attached PTY with the
message followed by Enter. When the application enables bracketed paste, the message
uses its paste delimiters. Newlines are normalized to carriage returns, matching
terminal paste.

The editor rejects multiline text and tabs without bracketed paste. It rejects other
terminal control characters. Existing input at the terminal prompt is not cleared.
BonBon does not infer readiness or completion, and a shell still treats submitted text
as shell input.

Drafts save 400 ms after an editing pause and before session switches. The shared
`composer-draft` operation stores immutable `draft` events in SQLite with no run ID. The
event sequence is a revision. Draft text is limited to 64 KiB and 8 attachment
references. Drafts are not sent messages and never appear in terminal frames.

All views of a session show the same draft. Each view keeps one `composer-watch` stream
for its selected session and loads the draft from it. After each save, the server
pushes the whole draft to every view of that session. A view without unsaved edits
applies a newer pushed draft. A view with unsaved edits keeps them, and its next save
wins. Earlier revisions stay in the archive.

An older view never replaces a pending draft. The server does not store a save from an
older revision when that revision or a later one is pending. That view then shows the
latest draft and reports that its last edit was not saved. A view also applies a pushed
pending draft at once, even over unsaved edits. A send stops when a draft from the
server replaces the draft during that send.

The watch reconnects after a transport failure and loads the latest draft again. While
it reconnects, the editor still saves through `composer-draft`. A changed server
identity stops the watch until the page reloads.

Before submission the editor saves `pending: true`. An optional input ID requests an
`input-ack` after recording and PTY write. The browser clears the draft only after a
successful receipt. This does not confirm application acceptance. A lost receipt, failed
write, or reload during submission retains the draft without retrying it.

The user must check the terminal and explicitly unlock that draft before editing and
submitting again. Users can edit drafts before launch, while detached, or after the
process ends. Send is disabled in these states.

**Sent messages** in the editor heading opens a list of the session's sent messages.
The oldest message is at the top and the newest is at the bottom. The list opens
scrolled to the bottom and shows the newest 20 messages. **Show older messages** at the
top loads 20 more and keeps the visible messages in place. The `composer-sent` operation
derives this list from the existing pending draft revisions. Thus the list also includes
sends from before this feature. Direct terminal input is not listed.

Each message shows its time, text, and attached file names. **Sent** means that the
editor got an input receipt and then cleared the draft. **Not confirmed** means that
there was no receipt, or the user unlocked the draft. This status is derived. It does
not confirm that the application accepted the message.

**Copy** puts the message text on the system clipboard. Users can then paste it into
any session. Copy does not include attachments or their file paths. It is not available
for a message without text. The list does not change the draft or send input.

The editor accepts file selection, drag/drop, and clipboard files, including images when
supplied by the browser. `composer-attach` copies original bytes into an `attachment`
event in SQLite. Its text field holds the filename, media type, and size. Files are
limited to 4 MiB each. Filenames cannot contain path separators or control characters.

A draft can reference only attachments from its own session. Removal of draft references
preserves archived copies. It also preserves draft revision history.

The server materializes private, read-only copies in
`<instance>/attachment-cache/<event-sequence>/<filename>` on upload, draft load, and
submission preparation. Ordinary draft autosaves read metadata without rewriting files.
Atomic replacement avoids partial file reads. The server can regenerate the cache from
SQLite.

The cache is not authoritative. HTTP does not serve it. Send appends quoted local paths
to the user's text. This is not a native provider or multimodal upload. File access
depends on the agent's capabilities and workspace permissions. BonBon does not change
permissions for the agent.

## Terminal runtime

Before launching a shell, BonBon records its resolved command, arguments, workspace, and
terminal size. The server launches it in a new PTY and process group. Commands retain
their normal authentication, terminal interface, and permissions.

Input bytes are committed before PTY delivery. Output bytes and derived text are
committed before updating the server emulator. Input records describe attempted
delivery. They do not prove application acceptance. Terminal replies, control bytes,
escape sequences, and redraws are retained.

Resize controls update the PTY and append a resize event. Ctrl+C bytes reach the child
terminal. The protocol's SIGINT control signals its foreground process group.

Normal exit drains output, stops the launched process group and foreground shell job,
records final state, and sends the exit status to connected views. Signal exits use 128
plus the signal number. Explicit session stop and server shutdown send SIGHUP and
escalate to SIGKILL after two seconds. Capture failures stop the process and report an
error. Server shutdown allows five seconds for view completion before closing stalled
connections.

Closing a view or losing its connection leaves work and capture running. Server
stop/restart cancels every run, including sessions without viewers, and waits for
cleanup and recording. Other shell background groups and deliberately detached processes
are outside the shutdown guarantee.

## Session views

The server holds a registry of live sessions. Each run owns its PTY, terminal emulator,
controls, and durable capture independently of clients. Multiple views share the run.
Every view can send input and signals. There is no controller role or Take control
button.

The PTY uses the viewport size of one view, the size owner. A view becomes the size owner
when it joins and no view owns the size. A view that sends input becomes the size owner
before the server writes that input. Terminal focus and mouse reports are input too.
Signals do not change the size owner.

A socket closing only removes that view. When the size owner leaves, the PTY keeps its
size. The next view that sends input or a new viewport size becomes the size owner. Stop
ends work for all views. There is no Detach button.

Each view has its own viewport size. Smaller views crop columns and show the bottom
screen rows, putting clipped top rows in scrollback. Larger views pad unused space.

Only a size owner resize reaches the shared emulator and PTY. The server orders accepted
input with size owner changes. A size change reaches the PTY before the input that caused
it. The server sends receipts to their original view. Input that two views send at the
same time can interleave.

Committed output and size events update the emulator in order. Terminal query responses
are recorded as `terminal-response` before PTY delivery. One notification combines
render requests. There is no per-client queue of raw output. Each attachment has its own
immutable render baseline and one outstanding frame.

After its acknowledgment, the server computes changes from the latest state, at most 20
times per second. Final output is acknowledged before exit. Input receipts use a
separate bounded queue.

A new attachment always starts with a full frame. Reconnecting does not change the PTY
size while another view owns it. The server updates PTY size when the size owner's
dimensions change. Reattaching at the same size uses the saved screen without requesting an
application redraw. An ended view never starts another process or invokes native
provider resume. Only an explicit `session-continue` starts a new terminal in an ended
session.

The protocol defaults to ten session entries. It accepts a limit of 1–1000 and a
nonnegative offset. It also accepts an archive collection flag and an optional search
query.

The UI requests 101 to display 100 entries and detect another page. Normal listing
excludes archived sessions. Archived listing includes only archived sessions. Ordering
follows the latest terminal input, output, or run lifecycle event (`start`, `run`, or
interruption `notice`), newest first. Sessions without these events use their creation
time.

Timestamps compare in whole milliseconds. For equal timestamps, the higher event
sequence comes first. Sessions without these events sort after sessions with them.
Remaining ties use creation order, newest first. The order is deterministic, so offset
pages do not overlap while the list is unchanged.

Viewing, resizing, renaming, saving drafts, attachments, terminal replies, and saved
screens do not change recency. Fresh application output still counts, including output
while detached or after a real size change. Summaries contain ID, title, project ID
(empty for standalone), workspace, update time, status, archive flag, and view count.

### Session status

Each session shows one status. The server derives it. SQLite keeps the run status and
the preparation state without change, so `bonbon query` results do not change.

| Status | Meaning |
| --- | --- |
| `draft` | The session did not start. |
| `running` | The live terminal had application output in the last 3 seconds. Worktree creation and process start also show as `running`. |
| `idle` | The live terminal had no application output in the last 3 seconds. |
| `ended` | No terminal is live. The latest run `exited`, `stopped`, `failed`, or was `interrupted`. |

The server records the time of each output of a live terminal in memory. It does this
without views too. Output in the 300 milliseconds after an input, a PTY size change, or
a signal from a view does not count. Thus the echo of typed input and the redraw after a
size change do not make a session `running`. A view that joins or reconnects sends its
size again. The PTY ignores an unchanged size, so that size does not hide the output
that follows. The detection does not depend on the tool.

`idle` means only that there was no recent output. The application can be complete, can
wait for an answer or a permission, or can work without output. A spinner or other
repeated output shows as `running`, also without progress. No completion, readiness, or
message boundaries are inferred from silence. BonBon never sends input because of a
status.

The sidebar shows the status of each session with a dot: filled for `running`, a ring
for `idle`, and gray for `draft` and `ended`. Each page keeps one `status-watch` stream
open. The server pushes the statuses of all live terminals on it, at most 200
milliseconds after a change. Thus the sidebar shows brief activity of each session,
also without a view of that session. The `session-list` refresh every five seconds
supplies all other session data. It also supplies the statuses while the watch
reconnects. When a terminal starts or ends, the page reads the list at once.

A status change updates the dot and the status text of a session button in place. The
button stays, so the keyboard focus stays on it. Other list changes replace the buttons
of the list. The page then moves the keyboard focus to the new button of the same
session or project control.

The session header shows **Running**, **Idle**, or **Ended**. A live view gets each
status change on its terminal stream. An ended session adds the reason. The `exit`
message carries the recorded run status, so each view shows the same reason:
**Ended · exit 0** for a normal exit with its code, and **Ended · stopped** or
**Ended · failed** for the other ends. A saved terminal shows the stored run status, for
example **Ended · interrupted**.

The `exit` message also carries the run ID. A view shows the reason from an `exit`
message only while that run is the latest run. After another view starts and ends a
later terminal, each view shows the stored status of the later run.

The session toolbar shows the status next to the session title. At the right, a search
icon opens **Search history** and a pane icon shows or hides the Changes pane. The text
buttons after them follow the session status:

- **Stop session** shows when the session has a live terminal. It does not show during
  worktree creation, which shows as `running` without a terminal. When the server
  reports that it stopped no terminal, the page says so and does not show an end.
- **Continue in new terminal** shows for `ended` sessions.
- **Reconnect** shows when a view of a live terminal has no connection. **Stop session**
  stays next to it.

**More actions** (⋯) opens a menu that lists only the actions that apply:

- **Rename** shows for started sessions.
- **Archive** shows for `draft` and `ended` sessions. It changes to **Restore** for an
  archived session.
- **Reload output** shows for an ended session, in a view of its latest terminal.
- **Remove worktree** shows for a session that is not live and has a managed worktree.

The menu button does not show when no action applies. A choice, Escape, or a click
outside the menu closes it. The Up and Down arrow keys move between the items. Tab or
Shift+Tab closes the menu and moves the focus to the control after or before the menu
button. After a choice, the focus is on the menu button. A dialog that the choice opens
returns the focus to that button when it closes.

Each toolbar icon and text button shows a tooltip on hover and on keyboard focus. The
tooltip of an icon gives its name and its keyboard shortcut. Each icon also has an
accessible name. A long title or workspace path shortens before the actions wrap.

The terminal selector shows the stored status of each run, where `running` means a live
process.

## Concurrency and recovery

Workspace paths are canonicalized without locking. Multiple live or detached sessions
can use the same workspace, symlink aliases, or parent and child directories. Each
session has its own PTY, run state, history, and stop operation. Sessions share file
changes. BonBon does not serialize writers or isolate filesystem changes.

SQLite uses WAL, full synchronization, and a busy timeout. Concurrent opens serialize
schema creation and upgrades. Switching journal mode retries lock contention for up to
five seconds because SQLite can skip its busy handler during this lock upgrade. The
server owns the live connection. Reading history does not reset active state. An
exclusive archive lock prevents two servers from owning one data directory, even on
different ports.

After server SIGKILL or a host crash, startup marks saved `starting` and `running` runs
as `interrupted` and appends a notice. These changes use one SQLite transaction.
Repeated startup does not change those records or add more notices. An interrupted
record means there was no recorded exit. It does not prove that its processes stopped.

Interrupted history does not block new sessions. There is no manual recovery step or
persistent workspace block. Processes left behind by a crashed server are not tracked or
controlled. BonBon never treats a stored PID as authority to kill or revive a process
and never replays terminal input. Stopping a session with no process owned by this
server is a no-op.

## History and storage

Local builds default to `~/.bonbon-dev`. Production builds default to `~/.bonbon`. Plain
`go build` and `go run` use the development default. `make release` sets
`main.instanceDirName=.bonbon` through Go's linker. The binary's location and working
directory do not affect this choice.

For all commands, directory selection is `--dir` first, then `BONBON_DIR`, then the
build's default. Explicit overrides can share a directory across builds. Relative paths
resolve from the caller's current directory. Symlinks resolve to the same canonical
instance. No data is moved from previous locations. BonBon creates SQLite
(`history.sqlite`) under the selected directory with private permissions.

The archive stores projects, sessions, runs, settings, preparation choices, worktree
metadata, and append-only events with stable global sequence numbers. New runs set
`BONBON_SESSION` and canonical `BONBON_DIR` for CLI retrieval, overriding inherited
values. `BONBON_SESSION` is a value the caller can use in SQL, not an automatic filter.
No retrieval prompt is automatically added to the agent's conversation. An agent can
run `bonbon skill` to get the retrieval guide.

Original terminal bytes are authoritative. Derived text strips terminal escapes and
handles split UTF-8 sequences. This text conversion is not a screen emulator or message
parser. Redraws can duplicate text.

Cursor movement can omit spaces. SQL predicates such as `LIKE` match individual event
chunks, so phrases spanning chunks may be missed. There is no semantic message search,
fork ancestry, or inherited history yet.

### Database upgrades

`internal/history/migrations/*.sql` is embedded in development and release binaries. The
server opens the archive after acquiring its exclusive instance lock, before
interruption recovery or serving requests. A pinned SQLite connection uses
`BEGIN IMMEDIATE` to serialize the version read and all pending migrations.

`PRAGMA user_version` tracks the last applied format. Scripts and version changes commit
as one transaction after column, index, and foreign-key checks. Any failure rolls back
the entire upgrade and stops startup. A failed SQL step reports its migration number.
WAL is enabled after the schema transaction commits.

- Empty databases run the format 3 baseline, then migrations 4 through 8.
- Format 3, shipped in v0.0.1, gains projects and a nullable session project reference.
  Existing sessions remain standalone, with their original workspace and history.
- Format 4 gains settings, preparations, and managed worktree tables. Defaults use
  Shell, no worktree, base `HEAD`, and an empty tool list. Existing projects and session
  memberships remain intact.
- Format 5 gains the `sessions.archived` flag through migration 6. Existing sessions
  start unarchived so normal listing and restoration preserve their prior visibility.
- Format 6 gains indexes on run event sequences, nonempty output sequences, and start
  events through migration 7. Existing records and allocated sequences remain unchanged.
- Format 7 gains `appearance: "system"` in the settings JSON through migration 8.
  The upgrade preserves the settings revision and existing values.
- Format 8 opens without running scripts or rewriting history, settings, or metadata.

The upgrade preserves IDs, timestamps, event sequences, original blobs, text, drafts,
and attachments. It also preserves the highest allocated event sequence. Migration
starts no agents and replays no input. Startup interruption recovery still runs
afterward. Repeated or concurrent opens see the committed version and skip completed
steps.

Formats 1 and 2 have no known migration path in this repository. They, nonempty
unversioned databases, and formats newer than 8 are rejected without changing their
schema or records. A newer format error asks for a newer executable. There is no
downgrade path, external migration command, or automatic backup.

### Read-only SQL

Each query opens a separate `mode=ro` connection with `query_only` enabled and
`trusted_schema` disabled. The SQLite authorizer permits only reads, selects, recursion,
and functions. It rejects file and extension functions, which BonBon does not install.
All other operations, including PRAGMAs, transactions, schema changes, and ATTACH, are
denied. SQLite prepares the SQL and its remaining text before execution.

The server rejects a second statement. The result must be read-only and have columns. No
SQL parser or prefix-only write check is maintained in BonBon.

The connection uses a five-second cancellation context that applies during preparation
and row stepping. It does not share the terminal capture connection. SQL is limited to
64 KiB, column count to 128, SQLite value/row length to 1 MiB, and the query heap to 64
MiB. The response has at most 1,000 rows and 8 MiB of JSON.

An extra row or a byte limit sets `truncated: true`. SQL, timeout, and SQLite resource
errors fail the request. Columns and row arrays preserve duplicate names, NULLs, and
BLOBs. SQL selects the scope without implicit environment filters. `sqlite_schema`
exposes table definitions.

Input/output and launch arguments can include secrets. No redaction or encryption is
implemented. The local archive is not isolated from other processes running as the same
OS user. BonBon implements no telemetry or cloud storage.

All durable BonBon data is in `history.sqlite`:

- Session and run metadata.
- Original terminal input and output blobs.
- Command and resize events, and interruption notices.
- Draft revisions, attachment bytes and metadata, and derived text. Reopening SQLite is
  enough to read this data without transcript sidecars or in-memory caches.
  `server.json` holds only disposable connection information.

The server log is diagnostic output. Lock files coordinate live processes and do not
hold history. SQLite manages its own WAL and shared-memory files. The main database file
alone is not a consistent copy while writes are active. Workspace contents, provider
credentials, and live process memory are outside this store.

There are no backup or restore commands, snapshot/export helpers, or cloud replication
integrations in this version.

## Validation

Changes pane fixtures use temporary Git repositories. They cover added, modified,
deleted, renamed, binary, and untracked files, and names with spaces, Unicode, and
newlines. They also cover files above 1 MiB, invalid UTF-8, symlinks inside and outside
the workspace, `..` and absolute paths, and folders. Other fixtures cover subfolder
sessions, repositories without commits, folders outside Git, missing workspaces, and
both baselines of a managed worktree after an agent commit. Folder list fixtures cover
the entry order, ignore marks, a nested repository, `.git`, symlinks inside and outside
the workspace, missing folders, the entry limit, a folder outside Git, a missing Git
executable, and a failed ignore check. A WebSocket fixture sends `workspace-file` and
`workspace-folders` through the server. Web fixtures cover the file list, the filter,
the tree rows and their notes and marks, the folders of a refresh, the language choice,
the layout width rule, and late replies. They also cover replies for a folder that
closed or opened again, a refresh at the shared entry limit, a folder that is gone, and
a failed request for one folder.

A browser check used a temporary instance, a fixture repository, and a shell session in
a managed worktree. It checked Split, Unified, folded regions, View file, deleted files,
symlinks, binary files, both baselines, a non-Git General session, and an ended
session. It also checked two tabs with separate selections, a phone width without
horizontal scroll, and an empty browser console. Script text in a file showed as text.

A browser check of the Files tree used a temporary instance, a fixture repository, and
a folder outside Git, each with a shell session. It checked open and closed folders,
ignored entries, status letters, folder dots, a symlink, a binary file, the file view
and the diff of a changed file, the filter list with a deleted file, and a refresh
after a folder was removed. It also checked the folder outside Git, an ended session, a
phone width without horizontal scroll, and an empty browser console. A later check
opened a folder with Enter and moved to its first entry with Tab. It also refreshed the
tree with an open folder of 20,000 files, and each open folder kept its entries.
A simulated connection failure of the request for one folder kept that folder open
with its entries and showed the error.

A browser check of the session toolbar used a temporary instance, a fixture repository,
and a Shell session. It checked the draft, running, and ended states, the tooltips, the
pressed pane icon, and the **More actions** menu with its keys. It also checked a long
workspace path, a 700-pixel window, and an empty browser console. A later check
verified that Tab and Shift+Tab from each menu item close the menu and move the focus
out of it. It also verified that the Rename dialog returns the focus to the menu
button. A review check with a temporary Shell session verified that **Reconnect**
restored the live view after a connection loss. No real agent CLI was used.

History search fixtures cover scope, archived sessions, older terminals, literal wildcard
characters, Unicode folding, split output, overlapping matches, bounded context, and fixed
pagination cutoffs. Reopen checks preserve original recording bytes. A concurrent read
check leaves capture writable. Invalid requests and canceled reads fail explicitly.

Limit fixtures cover more than 100,000 empty updates, nonempty-event and byte limits,
continued scans, split matches at cursors, interleaved terminals, overlaps, and cutoff
preservation. Query plans verify indexed run bounds and start events without a session
event scan. Unused-run fixtures keep unrelated oversized metadata outside a search.

Legacy tool fixtures verify the first-terminal fallback. Disconnect fixtures verify
cancellation and cleanup after a reply. Range fixtures verify project ordering without a
temporary sort and matches across range boundaries. Deadline fixtures reject unchanged
continuation cursors. Display fixtures preserve original bytes and offsets, CRLF pairs
across events, and intentional blank lines.

Frontend fixtures verify oldest-first page appends, plain-text rendering of markup, and
explicit scope changes. They also verify rejection of stale search and context replies.
A real temporary server check searches two synthetic shell terminals while the latest
terminal remains writable. It reads earlier context, archives the session, restarts the
server, and searches the same recordings again. No real agent CLI is used.

A compiled server upgraded an 8.5-million-event synthetic archive from format 6 to 7.
Search pagination, context, terminal lists, and newest-result reads passed. Reopen checks
preserved event counts, sequence allocation, and original byte lengths. The temporary
server was stopped. No user archive or real agent was used.

A browser check with synthetic history verified session, project, and all-session scopes.
It verified archived results, oldest-first pagination, context expansion, case matching,
and plain-text rendering of markup. A live synthetic shell remained usable after search.
The dialog also fit a 390-pixel viewport. The browser reported no errors or warnings.
The temporary shell and server were stopped after validation.

Archive fixtures cover more than 100 saved drafts, search before pagination, and literal
wildcard characters. They cover restoration after project removal and preservation of
draft revisions and original attachment bytes. They also verify rejection of active runs
and unfinished launch claims.

A real temporary server test creates two drafts in General and saves independent
messages. It archives one draft, restarts the server, then finds and restores that
draft. It starts a synthetic shell and verifies rejection of an archive request while
the shell is active. Then it stops the shell, archives the session, and replays its
output. Restoration starts no process.

Browser checks with a temporary instance verified separate sidebar drafts and saved
session names and multiline messages before launch. They verified session changes, exact
draft reload, archive and restore, and disabled launch for archived drafts. They also
verified preservation of the unsent editor after launch and stop. They also verified
archived search, page 2 with over 100 synthetic archived items, search for an item
outside page 1, and narrow-layout search. No browser errors were reported. The tests
used synthetic shells, not a real agent CLI.

A Chrome check with a temporary shell verified divider movement, arrow keys, size
limits, and terminal dimension updates. It also verified preservation of editor size and
text across a project draft change. A narrow layout at 250% zoom kept the editor
controls reachable. Reloading a stopped session restored its draft and reset the divider
size. Touch devices and real agent CLIs were not used for this check. The temporary
shell and server were stopped.

Launch fixtures cover persistent defaults, stale settings and configuration saves,
command snapshots after preset removal, and interrupted launch claims. They cover Git
subfolder and linked-checkout detection, clean creation, and rejection of removal for
active or dirty worktrees. Synthetic sh, bash, and zsh runs verify one startup input,
shell availability afterward, reconnect without replay, and an untouched composer draft.
These shell fixtures do not establish model availability or agent CLI compatibility.

Browser checks with a temporary instance verified settings, project drafts, saved
preparations after refresh, and startup in a timestamped worktree. They verified
preservation of the message draft and worktree after stop. No browser errors were
reported.

The UI-only workflow passes `CGO_ENABLED=0 go test ./...`, `go vet ./...`,
`go test -race ./...`, `make build`, and `make web-check` on macOS. A browser smoke test
used a compiled binary to create a shell and type a command. It opened a second view and
closed that view. Then it reconnected, stopped the session, and
reloaded its readable final screen. The test used a temporary instance and workspace,
with no real agent CLI.

A clean frontend dependency install and bundle build also pass. The bundled UI was
checked with direct terminal input, message submission, automatic reconnect after
pausing the server, and stopped-session reload. The browser reported no
errors. The temporary server and shell exited after validation.

Go integration tests use temporary instances, real server processes, synthetic shell
commands, and WebSocket views. They cover raw bytes, arguments, resize, Ctrl+C, exit
status, closed views, and background capture. They also cover reconnect to the same PID,
explicit stop, foreground job cleanup, shared workspaces, and SQL scope. They verify
interrupted runs without input replay. They also verify that input from either of two
views moves the real PTY size to that view. Two draft watches on a real server receive
each save and a pending send, and a stale save gets the latest draft back.

Activity fixtures check stable ordering across same-size reattachment, real PTY resize
notifications, and promotion by detached output. History tests exclude drafts and
display events from recency and its timestamp tie-break. They also check creation order
for equal timestamps. Server tests cover start/stop/restart, instance isolation, stale
or tampered metadata, protocol checks, idle peers, and shutdown with stalled views.

Frame fixtures cover independent viewport sizes, size owner changes, input from every
view, receipt routing, slow views, final-frame ordering, and ended-screen
reconstruction. Terminal tests cover the scrollback size budget, frames at the message
limit, and the narrower-view row cache. Cross-engine fixtures compare Go-generated
frames with xterm.js for cells, styles, cursor, scrollback, resize, split escapes,
Unicode, and alternate screens.

TypeScript fixtures cover reconnect delays, canceled retries, uncertain session starts,
identity checks, binary input, and input guards for inactive views. They also cover
ended views, slow sends, disconnects without input retry, frame parsing and
acknowledgments, paste boundaries, and file references. Draft watch fixtures cover the
watch request, keepalive, reconnect, identity errors, and the rule for applying a pushed
draft. Go tests check embedded assets and browser origin
restrictions. CLI fixtures check the home-page opener, instance selection, invalid
arguments, removed session commands, and opener failures.

Menu fixtures cover repeated start, restart, headless mode, server crashes, shutdown
with an active session, and protection against stopping a replacement instance. A manual
macOS check confirmed Open UI and Quit BonBon from the standalone executable. The shared
logo was checked in wide and narrow browser layouts and in 22-point light and dark
previews. The updated native companion also launched and exited with its server.

Project fixtures cover General and custom launches, canonical folder uniqueness,
protected General identity, renaming, removal while a session runs, and restart
persistence. Draft fixtures cover concurrent creation of independent drafts, preserved
tool snapshots, Shell selection, attachment persistence, and starting a fresh draft
after launch. Browser checks verified that project names are plain text without click
actions. They verified that separate arrows expand or collapse groups and **＋** creates
draft entries. They also verified that a new project leaves the current view unchanged.
They also verified draft restoration after switching, reload and server restart, Shell
launch in a worktree, and separate drafts for subsequent sessions.

No real agent CLI was used for these project checks.

Frozen schemas from repository history test upgrades from formats 3–7 to format 8 and
verify that reopen preserves the upgraded data. Fixtures compare original blobs, archive
flags, metadata, and event allocation state. They test rollback of the entire upgrade
after SQL, schema, or foreign-key failures. They also cover repeated opens, concurrent
upgrades, and unsupported formats. Server subprocess fixtures test migration before
queries, interruption recovery, and restart without duplicate notices. These checks use
temporary synthetic databases.

Appearance fixtures verify the System default, successful Dark saves, and rejection of
an invalid value. The migration tests preserve other settings and verify rollback and
concurrent opens. A Chrome check with a synthetic Shell session verified Light, Dark,
and System, saved appearance on reload, terminal replay, dialogs, and both diff layouts.

A compiled release binary also passed startup, SQL queries, restart, and shutdown with
temporary format 3–6 fixtures, running outside the repository. Checks confirmed format
6, preserved original event bytes and archive flags, and one interruption notice after
restart. All temporary servers were stopped. No user database or real agent CLI was used
for these upgrade checks.

Storage and composer tests cover read-only queries, cancellation and limits, format
rejection, persistence, and original bytes. They also cover the latest-save rule,
rejected saves after a send, draft watch pushes, pending submissions, attachment limits,
and cache reconstruction after database reopen.

Earlier browser checks with synthetic terminals verified creation, direct input,
multiline composition, file selection, and clipboard images. They also verified saved
drafts, session changes, stopped-screen reload, and reconnection after a paused server.
Two-tab checks verified shared output and stop for all views. Those
checks do not establish compatibility with real agent approval flows or untested agent
CLI versions.

A browser check without the controller role used a temporary instance and a synthetic zsh
shell. Two tabs with 82 × 15 and 156 × 38 terminals shared one session. Each tab typed
`stty size` with no control step. The shell reported the size of the tab that typed.
Send from the larger tab reached the shell. The recorded PTY size changed only when the
other tab sent input. No browser errors were reported. No real agent CLI was used.

A browser check of live draft sync used a temporary instance and two tabs on one draft.
Text typed in either tab appeared in the other tab within two seconds, with no reload.
After a synthetic zsh session started, Send from one tab ran the message. The editor in
the other tab cleared at the same time. The archive held four draft revisions: two edits,
the pending send, and the cleared draft. No browser errors were reported.

Continuation fixtures cover per-run replay, where an interrupted second run does not
show the saved screen of the first run. They cover handoff folders with three terminals,
newest-first order, tool names from start events and preparations, and exact messages
grouped by terminal. They also cover Sent and Not confirmed states, fenced text,
read-only files, rebuilds without leftover staging folders, and continue command
validation. Request fixtures reject live terminals, old run IDs, running records,
archived sessions, removed worktrees, missing workspaces, unknown tools, and long
commands. A rejected request writes no handoff folder. sh, bash, and zsh each receive
the quoted prompt as one exact argument.

A real temporary server test starts a worktree session with a synthetic tool and sends
one editor message. It stops the session and continues it with a continue command that
prints the prompt. It verifies the worktree path, the handoff files, and the rejection
of a second continue request. Then it restarts the server and continues again with
Shell. The README then lists both earlier terminals, newest first. The ended view shows
only the latest terminal. Each startup command and message was recorded once, in its own
run. These checks use synthetic shells, not a real agent CLI.

A browser check with a temporary instance and a synthetic zsh tool started a worktree
session, sent one editor message, and stopped the session. **Continue in new terminal**
showed the worktree, the tool, the hint, and the prompt. The new terminal received the
prompt as one argument in the same worktree. After a second stop and a server restart,
the handoff README listed both earlier terminals, newest first, with no staging folders
left. A change of the tool to Shell updated the hint. After a page reload, **Handoff
prompt** showed the same prompt. Put in message editor filled the empty editor and saved
the draft. A second attempt with text in the editor was refused and left the text
unchanged. No browser errors were reported.

Earlier-terminal fixtures cover the terminal list with tools from start events and from
the preparation, a `starting` terminal without a run record, and the change to its run.
They cover a resume of an earlier run while a later run is live. That view gets the
saved screen of its own run and `history-end`, and the live run gets no new view. A run
of another session is rejected before any frame. Browser fixtures cover the selected
run, steps at both ends, labels, local times, and a reconnect that keeps an earlier run.

A browser check with a temporary instance and `/bin/sh` made three Shell terminals in
one session. The selector was hidden for one terminal. The list showed three terminals
in start order. Terminal 1 and terminal 2 showed their own output with input and Send
off. The sidebar did not count those views of the live session. **Back to live
terminal** joined the third terminal, and Send then reached it. After a server restart,
the button was **Back to latest terminal**, and Escape closed the list. **Continue in
new terminal** then started a fourth terminal. **Stop session** from a view of an
earlier terminal stopped it and changed the button to **Back to latest terminal**. No
browser errors were reported. No real agent CLI was used.

`codex sandbox` from Codex CLI 0.160.0, with default settings, read the handoff
`README.md` from outside its working directory. In the same sandbox, `bonbon query`
failed with "connect: operation not permitted". These checks ran no model.

A live check used a temporary instance, a Git worktree session, and the real agent
CLIs with models. The server started with a clean environment that had only `HOME`,
`PATH`, and a plain zsh. One session had six terminals:

1. Codex CLI 0.160.0 got a task from the message editor. It wrote a codename into an
   uncommitted file.
2. A continue with `codex {prompt}` started Codex with the prompt as its first message.
   Codex reported the codename and the uncommitted file, then waited.
3. A continue with the Claude CLI that is bundled in the desktop app stopped at its
   login screen.
4. A continue with `codex --no-alt-screen {prompt}` read the README, `messages.md`, and
   the transcript of terminal 3. It ran `git status`, `git log`, and `git diff`, and
   summarized all earlier terminals.
5. A Shell continue only rebuilt the handoff folder.
6. A continue with `claude {prompt}` and Claude Code 2.1.312 summarized terminals 1–5
   and the uncommitted file, then waited.

Neither agent asked for approval to read the handoff folder. Claude ran in its auto
permission mode, which allowed the reads. Its default permission mode was not checked.
Codex uses the alternate screen by default. The transcript of terminal 1 kept only its
last 12 lines. With `--no-alt-screen`, the transcript of terminal 4 kept the full
output, including each command. Claude Code ran in the normal screen, and its transcript
kept the full reply, with some repeated rows from dialog redraws. The agents also showed
their own folder trust questions and, for Codex, a shared background server question.
These are agent behavior, not BonBon behavior.

Session status fixtures use fixed times and a real PTY. Time fixtures cover the start of
a terminal, background output, the idle delay, typed input at short intervals, and
output after the echo window. A server fixture covers `draft`, worktree creation, a
launch without a process, a starting terminal, recent and old output, each stored end
status, and a new terminal in an ended session. A PTY fixture starts an application that
writes on a trigger file. It checks `running` and `idle` in the list and on the stream,
that typed input keeps `idle`, that a later view gets the current status, and `ended`
after stop. A status watch in the same fixture gets each change and then loses the
session after stop. A second PTY fixture sends an unchanged size and then triggers
output. It checks that the application got no size change and that the session shows
`running`. A server fixture checks the same rule and a changed size with fixed state.
A PTY fixture with three shells checks that a view that did not stop a terminal gets
`stopped` with code 129, and `exited` with code 3. It also checks that each `exit`
message carries the ID of its run. Web fixtures cover the status text, the continue
rule, the terminal rule for **Stop session**, the priority of a pushed status, the
status line of a list entry, the end reason and its run, and the reconnection of a
watch stream.

A live check used a temporary instance and a Shell session in the browser UI. A shell
loop that wrote a line each half second showed `running` from 0.6 seconds after Send
until 3 seconds after its last line. Claude Code 2.1.312 at its folder trust question
and Codex CLI 0.160.0 at its background server question both showed `idle` for 14
seconds. Stop session showed **Ended · stopped**. The check sent no prompt to a model,
so `running` during agent work is not verified.

A second live check used a temporary instance and two browser tabs. A shell loop wrote
one line each 7 seconds in a session that no tab showed. Its sidebar dot showed
`running` for 3.0 seconds after each line, in three cycles. One tab then stopped the
session, and both tabs showed **Ended · stopped**. Stop session during worktree
creation has fixture coverage only.

A third live check used a temporary instance and the same shell loop. The keyboard
focus was on the sidebar button of a session that the tab did not show. In 30 seconds,
nine pushed status changes updated the dot without new buttons. Six list refreshes
replaced the buttons, and the focus stayed on the button of that session.

In the same check, one tab showed **Ended · exit 3** for the first terminal. A second
tab continued the session and stopped the new terminal. Both tabs then showed
**Ended · stopped**.

## Limitations

The session status uses output times only. It cannot tell a completed task from a
permission question, and it shows `idle` for a command that works without output. An
application that writes output while it waits shows as `running`. Typed input at short
intervals for more than 3 seconds can show `idle` while the application works. While
the status watch reconnects, the sidebar can show a status change up to five seconds
late. A start
screen that an application draws in the 300 milliseconds after its command does not
show `running`. The 3 second and 300 millisecond values are not verified with an agent
that works on a task.

Native session mapping/resume, forks, imports, native agent attachments, and Windows
support are absent. Recording bytes does not preserve hidden agent state or guarantee
complete semantic messages. Host crashes and server SIGKILL can lose uncommitted bytes
and prevent cleanup. Provider-owned daemons retain their lifecycle.

BonBon stops the launched group and a shell's foreground job. It does not track other
background groups. Linux runtime behavior and large archives are unverified.

A session has at most one live terminal. The UI shows an earlier terminal only as its
saved final screen, one terminal at a time. It cannot show two terminals side by side.
The terminal list reads every start event of the session, so a long session makes the
list slower to load.

Search history can read matching output and bounded context from earlier terminals.
Their saved transcripts remain available in the handoff folder, and `bonbon query` reads
their original events.

A handoff transcript has at most the newest 10,000 scrollback rows of a terminal.
The server rebuilds the handoff folder while it holds the launch lock. A large interrupted
recording can delay other launches during this rebuild. A transcript keeps
only the last screen of a program that uses the alternate screen, such as Codex CLI
0.160.0 without `--no-alt-screen`.

The session header shows the tool of the original launch, also after a continue with
another tool. The prompt gives the new agent a record of earlier work. It does not
restore the internal state of the earlier agent.

The Changes pane reads files only when it opens, on Refresh, and on window focus. It
shows one file at a time and has no commit list. It shows images as binary files. It
cannot show changes in a folder that is not a Git repository. The filter of **Files**
needs a Git repository, and it does not find ignored files. The tree has no arrow key
navigation. Use Tab and Enter. Git detects a rename only
between tracked files with similar content. An untracked new file and its deleted
original show as two changes.

Each session has one shared draft. Other views update after each save, about half a
second after typing stops. They do not show each keystroke. When two views edit at the
same time, the latest save wins. The earlier text then stays only in archived draft
revisions. The draft does not merge edits from two views.
