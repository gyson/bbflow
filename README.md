# bbflow

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/bbflow-dark.svg">
  <img src="docs/images/bbflow-light.svg" width="64" alt="bbflow pixel logo: the letters bb on a 16-pixel grid">
</picture>

bbflow is a local web workspace for agent command-line interface (CLI) tools. The server
owns interactive shells, terminal screens, and history. The browser handles sessions and
terminal input. The server saves original input, output, and run metadata.

**Daily use:** the binary includes database migrations that preserve existing history
and settings during upgrades. Commands and APIs may still change during early
development. Keep the implementation simple and preserve durable user data.

The CLI command and executable use the name `bbflow`. See the
[command reference](docs/COMMANDS.md) for every command, its options, examples, and its
effect on processes and stored data.

## Install on macOS

```sh
curl -fsSL https://github.com/gyson/bbflow/releases/latest/download/install.sh | sh
```

The installer selects the latest build for Apple Silicon or Intel and installs it in
`~/.local/bin`. The installer does not need Go, Node.js, or GitHub CLI. If that
directory is not on your PATH, add `export PATH="$HOME/.local/bin:$PATH"` to your shell
configuration.

Start bbflow:

```sh
bbflow server start
bbflow ui
```

To update:

```sh
bbflow update
```

When ready, run `bbflow server restart`. Restart ends active sessions. The new server
applies pending database migrations before it accepts requests. `bbflow update` itself
only replaces the executable and leaves the database alone.

## Build and run

Builds require Go 1.27.3+, Node.js 22+, and npm. The binary includes the web UI and
terminal libraries. It does not need Node.js or Go to run. To use an agent, install its
CLI on PATH and sign in normally. Start the server before using `ui` or `query`.

```sh
npm --prefix web ci --ignore-scripts
make build
./bin/bbflow server start
./bin/bbflow ui
```

Local builds (`make build`, plain `go build`, and `go run`) use `~/.bbflow-dev`. For a
production build, use:

```sh
make release
./bin/release/bbflow server start
./bin/release/bbflow ui
```

The release binary uses `~/.bbflow`. The build sets this default. The executable
location and working directory do not change it. Each server chooses an available local
port and writes connection information to `server.json` in its instance directory. All
commands select the instance with a global `--dir` option before the command, then
`BBFLOW_DIR`, then the build's default. Clients discover the port automatically.

```sh
./bin/bbflow --dir ~/bbflow-experiment server start
./bin/bbflow --dir ~/bbflow-experiment ui
```

`--dir` selects bbflow's files. Choose the agent workspace when creating a session in
the UI. There are no `--port` or `--data-dir` options.

```sh
./bin/bbflow server stop
./bin/bbflow server restart
```

The server continues after its launch terminal closes. Repeated start leaves the
existing server active. Stop waits for active agents and recording to finish. Restart
stops the server and starts the executable that received the command. To use new code,
rebuild the executable and restart the server.

The server writes logs to `server.log` in the data directory. Client commands do not
start a server automatically.

The CLI is limited to opening the UI, managing the server, and read-only SQL queries.
Session creation, selection, terminal interaction, and stop are available in the UI.
There is no `bbflow session` command or terminal attachment through the CLI.

## macOS menu bar

On macOS, `bbflow server start` also launches the bbflow icon in the menu bar. **Open UI**
opens the home page in the default browser. A separator divides it from **Quit bbflow**,
which shows the running version. Quit bbflow stops the server and all active sessions,
saves their final history, and closes the menu. Closing a browser tab leaves work running.

The menu is a separate process launched from the same `bbflow` executable. It calls
AppKit through `gogpu/systray` and builds with `CGO_ENABLED=0`. The server's lifetime
pipe closes the menu after shutdown and also when the server crashes.

A repeated start keeps the existing server and menu. Restart replaces both. Quit
remembers and verifies its original server connection, even if `server.json` is missing
or replaced.

Use `server start --no-menubar` or `server restart --no-menubar` for a headless Mac or
automated checks. Linux starts no menu. A repeated start does not change an existing
server's menu choice. The menu needs a logged-in macOS desktop. If the menu fails or
stops unexpectedly, sessions continue in the server.

The server writes diagnostics to `server.log`. To restore a lost menu, restart the
server. This ends active sessions. Menu actions that fail show a retry label.
Notifications, settings, launch at login, and global shortcuts are not implemented.

## Web UI

Run `bbflow ui` to open the home page in your default browser:

```sh
./bin/bbflow server start
./bin/bbflow ui
```

Use global `--dir` or `BBFLOW_DIR` to choose the instance, as with other commands. `ui`
verifies the running server before opening `http://127.0.0.1:PORT/`, with no session
selected. It does not start a server or agent. It uses `open` on macOS and `xdg-open` on
Linux. If the browser launcher fails, it prints an error with the URL to open manually.

You can also open the URL printed by `server start` yourself. Running `server start`
again prints the existing server's URL without opening a browser or replacing the
server. After a build, use `server restart` to serve the new embedded assets. Restart
stops active sessions. Ports can change after restart, so use the newly printed URL.
This version uses protocol `bbflow/24`.

`server restart` can replace a server using a different session protocol when it
supports the same verified shutdown request. UI and query commands still require the
current protocol. SQLite format 8 adds the instance appearance setting.
The new server automatically upgrades formats 3–7 at startup. You do not need a fresh
`--dir`. See [database upgrades](#database-upgrades) for details.

The sidebar groups sessions and drafts under saved projects, with 100 items per page,
newest terminal activity first. Search matches session names, IDs, folders, and project
names across the whole selected collection. Previous and Next reach older items. Input,
output, and run state changes affect the order. View changes, size changes, session
names, and draft saves do not affect the order.

Use **Add project** to save an existing folder, with an optional name that defaults to
its basename. Git is optional. Click **＋** beside a project to create and select a new
draft in the sidebar.

In **Settings → Appearance**, choose **System**, **Light**, or **Dark**. Click
**Save settings** to apply the theme. System follows your device appearance.
Browsers without CSS `light-dark()` support use the Light palette.

The session toolbar has three icons for the workspace pane: changes, files, and
terminal. Click an icon to show its view. Click the pressed icon to close the pane.
**Changes** and **Files** are read-only. **Terminal** is a shell in the session
workspace that bbflow does not record. In Changes, choose **Since worktree base** or
**Uncommitted changes**, and **Split** or **Unified**. **Files** shows the workspace as
a folder tree and the current files. Type in the filter box to find a file by its path.
The pane does not edit files. It does not watch files. Click **Refresh** or return to
the window to read them again. A folder that is not a Git repository has no changes.

Click the search icon in the session toolbar to search recorded output in SQLite. Its
tooltip is **Search history**. Command+Shift+F on macOS
or Ctrl+Shift+F opens the same dialog. The default scope includes every terminal of the
selected session. Choose **This project** or **All sessions** for a broader search.
Archived sessions are included. Without a selected session, the dialog starts with
**All sessions** and waits for search text.

Results appear from oldest to newest. Select a result to read its surrounding context
in the right pane. **Show more before** and **Show more after** expand that context.
**Copy context** copies the displayed text. Search leaves the active terminal running.
Submit the search again to include new output.

**Show more results** loads the next page when additional matches exist. The status says
**results loaded** while more matches remain. Otherwise, it reports the final match count
and hides that button.

Search uses literal text and ignores case unless **Match case** is selected. It finds
phrases across recording chunks within one terminal. Derived output can contain repeated
text or missing spaces after terminal redraws. It is not an exact conversation transcript.

When a scan reaches its limit, **Continue search** keeps the results and scans newer
output. If no progress is possible before the time limit, the dialog asks for a smaller
scope. **Retry search** keeps the attempted cursor and recording cutoff. Context loads
separately, so a context error leaves results available. Display and copied context
preserve intentional blank lines. See [SPEC.md](docs/SPEC.md#history-search) for
resource limits and large-archive limitations.

Each project can have several drafts. Click a draft entry to reopen it. Starting keeps
the same session entry and ID. Project names are plain text. Use the small arrow to
expand or collapse sessions.

Each session shows one status: **Draft**, **running**, **idle**, or **ended**. A running
session had terminal output in the last 3 seconds. An idle session has a live terminal
without recent output. Idle does not mean that the agent completed its task. The agent
can also wait for an answer, or work without output. The echo of your typed input does
not count as output.

Use **⋯** to rename or remove a custom project. Removing a project moves its sessions
and unfinished drafts to **Standalone** and keeps their history, files, and processes.
**More actions** (⋯) in the session toolbar has the actions that you need less often.
**Rename** in this menu changes the session title.

**Archive** in the same menu hides a draft or finished session and preserves all data
and files. Stop a
running session before archiving it. Open **Archived** to search or browse saved items,
read recorded output, and edit saved drafts. **Restore** returns the item to its project
(or Standalone if the project was removed). Restore never launches a process.

Before you start an archived draft, restore it. Archiving saves the current editor first
and returns to the welcome view. Other windows retain their views.

**General** is always available for work across projects. Its working folder is
`<instance>/workspaces/general`. You cannot rename or remove General. General and custom
projects persist in SQLite across browser tabs and server restarts. The same canonical
folder cannot be saved twice. Multiple sessions can still share a folder.

Every new session starts from a saved project, including **General**. The project keeps
independent drafts across tabs, project switches, and server restarts. Session names,
launch choices, and each session’s one message editor save automatically, including its
text and attachments before launch. Edit the session name, choose a tool or **Shell**,
and optionally enable a worktree.

The project and folder are fixed. Edit startup commands only in **Settings**. Starting
keeps the message and attachments in the session editor until you send them.

Project folders accept an absolute path or `~/project` (`~` alone selects the server's
home directory). bbflow expands this using the server's `HOME` from startup and records
the canonical absolute path. bbflow does not support other relative paths, `~user`, or
environment-variable expansion. Every session opens the server's `$SHELL -i`, falling
back to `/bin/sh -i`. Shell submits no preset command. Type any command in the terminal.

Browser launches use the server's environment from startup, with `TERM=xterm-256color`.
Restart the server from the desired shell after changing PATH or environment settings.
The shell reads its normal startup files. Commands keep their own arguments,
authentication, configuration, and permissions.

bbflow submits the configured startup command once, while the message editor waits for
an explicit Send. Exiting an agent returns to the shell. Exiting the shell ends the
session.

Multiple sessions can use the same or overlapping workspace. Their terminals and
histories are independent. The sessions share files. bbflow does not coordinate edits.
Enable **Use worktree** to create independent files under
`<instance>/worktrees/YYYYMMDD-HHMMSS-XXXXXXXX`.

Choose a starting branch or commit (default HEAD) and optionally name the new branch.
bbflow copies only committed files. It does not copy local changes, ignored files, or
dependencies. Git must be installed. Submodules are not supported. Worktree files are
outside the SQLite archive.

**Settings** configures defaults for new sessions and named startup commands, for
example **Codex** → `codex` and **Codex 6 Astra** → `codex --model=gpt-6-astra`.
Commands use the shell's syntax. bbflow does not validate model names or install the
tools. Shell is always available.

Commands must be a single line, at most 1,000 bytes. Edit commands in Settings or choose
Shell and type directly in the terminal. Changing defaults does not change existing
drafts.

New sessions save their launch settings, message drafts, and attachments before running
anything. **Start session** opens the terminal above the editor and submits only the
startup command. **Send** explicitly pastes your composed message. Reopening never
repeats a startup command. bbflow reports conflicting edits from another browser.

**Continue in new terminal** appears after the latest terminal of a session ended, for
example after **Stop session**, an agent exit, or a server restart. It starts a new
terminal in the same session, workspace, and worktree. Only one terminal can be live.
The session keeps its ID, message draft, and history.

Before the start, bbflow writes a read-only handoff folder at
`<instance>/handoff/<session-id>/`. It contains a README, the text of each earlier
terminal, and the messages sent through the editor. bbflow rebuilds the folder from
SQLite for each new terminal. A tool's optional **Continue command** submits a short
prompt that points the new agent to this folder. Without a continue command, bbflow
starts the tool with its normal command. Copy the prompt from the dialog and send it
when the agent is ready. Later, **Handoff prompt** in the message editor shows the
prompt again. It can copy the prompt or put it in an empty editor. The new agent does
not get the internal state of the earlier agent.

A transcript keeps only the last screen of a program that uses the alternate screen.
Run agents in the normal screen to keep their full output in the handoff folder. These
settings passed a live check:

| Tool | Command | Continue command |
| --- | --- | --- |
| Codex CLI 0.160.0 | `codex --no-alt-screen` | `codex --no-alt-screen {prompt}` |
| Claude Code 2.1.312 | `claude` | `claude {prompt}` |

Codex uses the alternate screen by default. Do not turn on the fullscreen renderer of
Claude Code.

**Remove worktree** in the **More actions** menu is explicit. It refuses active sessions and modified, untracked, or
ignored files, keeps the branch, and preserves history. Stopping a session or removing a
project does not remove its worktree. Repositories must remain available for Git
cleanup.

The terminal supports keyboard input, paste, resizing, and the agent's own prompts.
Switching sessions or closing a tab removes that view and leaves the process running.
Multiple tabs can show the same session. Every tab can type and send messages
immediately. The terminal size follows the tab that most recently sent input. Other tabs
keep their own view size.

**Stop session** ends the process for every view. Smaller views show the bottom of the
terminal and put clipped top rows in scrollback. They clip columns beyond their width
without application reflow.

Refreshing a selected page resumes its session by ID. The browser reconnects after
transport failures. Reconnecting does not change the terminal size while another tab
owns it. Input remains disabled until the current screen arrives. The browser never
retries uncertain input or session creation. Switching sessions cancels pending browser
reconnection.

The Go server owns the terminal emulator as well as the PTY. It sends a current screen
snapshot followed by rendered changes, with one acknowledged frame at a time. A slow
view skips intermediate redraws. The server still records every original event in
SQLite. The server answers terminal queries even when no client is attached.

Stopped sessions retain a derived final screen in SQLite. The server reconstructs
recordings that have no final screen. Ended views retain their recorded size and styles.
Views retain up to 10,000 normal-screen scrollback rows and up to 8 MiB of rendered
rows. Rows with many colors or styles use more space, so fewer rows remain. Erased
content and exited alternate screens may only remain in the original archive.

Terminal sizes are bounded to 2–512 columns and 1–256 rows. Advanced graphics,
hyperlinks and extended keyboard protocols are not forwarded to the view. Use
**Search history** or `bbflow query` to inspect recorded output beyond the restored
terminal view. There is no file browser or diff view.

The message editor stays below the terminal. Drag the small divider between them to
adjust their heights. You can also focus the divider and use Up/Down arrows or Home/End.
The chosen editor size stays while switching sessions in this tab and resets on reload.
Edit text normally. Enter adds a line.

**Send** pastes the message into the current terminal prompt and presses Enter. Direct
terminal input still works. First, examine the current prompt.

bbflow cannot tell whether an arbitrary CLI is ready for a message. It does not clear
existing text at the prompt. Multiline text and tabs require the CLI to enable bracketed
paste. Application handling still depends on that CLI.

Drafts save per session through the server to SQLite, including across browser reloads
and server restarts. The editor waits for saves before switching sessions. All tabs that
show a session share its draft. An edit in one tab appears in the other tabs about half a
second after you stop typing. If you type in two tabs at the same time, the last save
wins. A tab never replaces a message that another tab is sending. A failed or
uncertain submission retains the draft and requires you to check the terminal before
editing and submitting again. A receipt confirms terminal delivery. It does not confirm
agent acceptance or completion. bbflow never resends input automatically.

Use **Attach files**, paste clipboard files/images, or drop files into the editor.
bbflow archives copies in SQLite and appends quoted local file paths to the message.
These paths are file references. bbflow does not upload the files or images through a
native agent interface.

The CLI must support file reads. It may need permission to read outside its workspace.
Limits are 64 KiB of draft text, 8 files per draft, and 4 MiB per file. Removing a file
from a draft does not delete its archived copy. Unsent draft revisions are also retained
in the archive.

## Frontend development

Frontend sources are under `web/`. They include `index.html`, TypeScript and CSS in
`src/`, and tests. The UI uses [xterm.js](https://xtermjs.org/) for terminals and
[CodeMirror 6](https://codemirror.net/) for the read-only Changes pane. Both come from
pinned npm dependencies. The server uses the pure-Go
[xterm-go](https://github.com/gitpod-io/xterm-go) core. The UI loads no libraries from a
content delivery network (CDN).

Install dependencies after cloning or changing the lockfile:

```sh
npm --prefix web ci --ignore-scripts
make build
make web-check
```

`make build` and `make release` type-check TypeScript, bundle the UI with esbuild, then
compile Go. The frontend produces one `app.js` and one `app.css`, plus HTML, logo
assets, and dependency license notices, under `internal/webui/dist/`. The build reads
the esbuild metafile and adds the license notices of every bundled npm package. Go
embeds that
directory. The shared logo source is `web/src/bbflow.svg`. It draws the letters "bb" on a 16-unit
pixel grid. The npm build uses `@resvg/resvg-js` to render its transparent menu bar PNG
at 2 pixels per grid unit. GitHub shows README images without the page text color, so
the README uses fixed-color copies in `docs/images/` for its light and dark themes.
`web/logo.test.mjs` checks that the copies keep the shape of the source.

The final executable needs no separate renderer or image files. The build also downloads
the pinned Go modules and collects bbflow, Go, and dependency license notices into the
embedded `/assets/licenses.txt` resource. They remain in the executable after
installation and updates. Git ignores build output and `node_modules`. Commit sources
and the npm lockfile only. There is no separate vendor-copy step.

`make web-build` builds only the frontend. `npm --prefix web run typecheck` checks types
without generating files. `make web-check` compiles modules into the ignored `web/dist/`
directory and runs the frontend fixtures. `make test` and `make check` build frontend
assets before Go tests and vet. For direct `go build`, `go run`, `go test`, or `go vet`
commands, run `make web-build` first in a fresh checkout.

After UI edits, run `make build`, restart the server, and reload the page.

## Recorded history

History lives in `~/.bbflow-dev/history.sqlite` for local builds and
`~/.bbflow/history.sqlite` for production builds. An explicit `--dir` or `BBFLOW_DIR`
override can point either build at any directory. The driver is pure Go
(`github.com/ncruces/go-sqlite3`). Builds use `CGO_ENABLED=0`.

The archive contains the resolved command and arguments, working directory, terminal
size changes, raw input/output bytes, timestamps, and final run state. bbflow derives
searchable text from output. This text is not a structured conversation. Redraws can
repeat text. Keystrokes do not reliably identify message boundaries.

Input includes terminal control replies and anything typed into the agent, including
secrets. There is no redaction. bbflow creates database files with private permissions.

Browse sessions in the UI. Use read-only SQL for history questions, from any session or
across the whole archive:

```sh
./bin/bbflow query "SELECT id,title,workspace FROM sessions ORDER BY created DESC LIMIT 10"
./bin/bbflow query "SELECT seq,text FROM events WHERE session_id='SESSION_ID' ORDER BY seq LIMIT 100"
./bin/bbflow query "SELECT session_id,seq,text FROM events WHERE text LIKE '%earlier decision%' LIMIT 20"
```

Results are JSON with `columns`, `rows`, and `truncated`. Raw BLOBs use base64. Output
events have derived `text`. SQL chooses the scope. `BBFLOW_SESSION` is available inside
wrapped agents, but it does not add an automatic filter.

`BBFLOW_DIR` points their bbflow commands to the owning instance. Queries run on a
separate read-only connection with a five-second timeout and bounded results. The server
rejects writes, PRAGMAs, attachment of other databases, and multiple statements. See the
[query reference](docs/COMMANDS.md#query-sqlite) for limits, tables, and pagination.

An agent tool can run `bbflow skill` to learn these queries. The command prints a
Markdown guide with the archive tables, event kinds, and examples. See the
[agent guide reference](docs/COMMANDS.md#agent-guide).

Communication uses JSON over WebSocket at `ws://127.0.0.1:PORT/ws`. The browser uses
this for session views and composition. The CLI uses it for server checks, shutdown, and
SQL queries.

The endpoint accepts local hosts and matching browser origins. There is no
authentication token. See the [protocol reference](docs/PROTOCOL.md) for messages and a
JavaScript example. The local archive is not a security boundary against processes
running as you.

After an abrupt server exit, the next startup marks unfinished runs as `interrupted` and
preserves their recorded history. They do not block new sessions. bbflow does not track
or stop processes left behind by a crashed server, and never replays recorded input.

SQLite stores all durable bbflow data:

- Saved projects, session details, and run state.
- Command and workspace metadata.
- Raw terminal recordings and terminal responses.
- Derived searchable text and final terminal screens. There are no separate transcript
  or durable metadata files. `server.json` contains only disposable connection
  information. The server replaces it on startup and removes it on clean shutdown.
  SQLite's `-wal` and `-shm` files are part of its live storage.

A copy of the main file alone can miss committed data while the server runs.
`server.log` is diagnostic output. Process lock files hold no conversation data.
Workspace files, including files created in General, and provider-managed credentials
stay outside bbflow's database. General is a working folder, not a backup of those
files.

Backup and restore are not available in this version. Future cloud backup work is in
[PLAN.md](docs/PLAN.md). No cloud service or replication process is configured or
started.

## Database upgrades

The current SQLite format is 8. Formats 3 (from v0.0.1) through 7 upgrade
automatically to 8 on server start or restart. Format 8 databases need no
migration. Upgrades preserve sessions, runs, original events, drafts, attachments,
project membership, settings, and worktree metadata. Format 3 sessions remain standalone
and keep their recorded workspace paths.

Every binary includes the ordered SQL scripts under `internal/history/migrations/`
through Go embedding. No SQLite CLI, downloaded scripts, or extra files are needed. All
pending steps and their version changes commit in one transaction. A failed migration
rolls back the upgrade and stops startup. Inspect `server.log` for the failed step.
Reopening an upgraded database does not repeat completed migrations. Format 7 builds
indexes for run events, nonempty output, and start events. Startup waits up to two
minutes for readiness, including large index upgrades.
Format 8 adds System appearance to existing settings and preserves other values.

Formats 1 and 2, nonempty unversioned databases, and formats newer than this executable
are rejected without changing their contents. Use a newer executable for a newer format.
Downgrades are not implemented. These migrations do not provide backups. Cloud backup
remains planned separately.

For contributors: keep released migration files unchanged. For each schema or durable
data format change, add the next numbered SQL file (for example, `009.sql`). Increase
`schemaVersion`. This also applies to stored JSON changes. Scripts must stay inside the
migration runner's transaction.

Do not include transaction control, `VACUUM`, or version PRAGMAs. Fresh databases run
the same chain from the format 3 baseline. Keep frozen schemas under
`internal/history/testdata/` independent of migration code. Test record preservation,
skipped versions, rollback, repeat opens, and concurrent upgrades.

## Validation and limits

```sh
make test
make check
make web-check
go test -race ./...
```

The race detector needs CGO for tests. Deployment builds do not need CGO.
Pseudo-terminal (PTY) tests launch interactive shells and synthetic commands. They
verify raw bytes, command arguments, resize, Ctrl+C, and exit codes. They also verify
closed views, background recording, reconnection, explicit stop, recent session lists,
and SQL scope. They cover independent sessions in the same or overlapping workspaces.

Project fixtures cover canonical folder uniqueness, protected General identity,
launching shells in both project types, removal while running, and restart persistence.
These use synthetic shells, not a real agent. Storage tests cover read-only SQL,
cancellation, result limits, and database reopen. They also cover upgrades from frozen
formats 3–7 and preservation of original records and event sequences. Other checks cover
rollback, concurrent upgrades, and rejection of unsupported formats. Server subprocess
fixtures verify startup migration, history queries, and interruption recovery after
upgrade.

Changes pane fixtures use temporary Git repositories. They cover each Git status,
untracked and unusual file names, binary and large files, symlinks, paths outside the
workspace, subfolder sessions, repositories without commits, and worktree baselines.
Folder list fixtures cover ignore marks, symlinks, entry limits, and folders outside
Git.

Side terminal fixtures start real shells through a test server. They check that the
shell runs in the session workspace, that views share it, and that SQLite records none
of it. They also check stop, exit, archive, and reconnection without a new shell.

Native agent resume and fresh continuation with history retrieval are not implemented. A
recording preserves evidence. It does not restore internal model state. Browser views
restore server-rendered screens and supported input modes.

The views do not support graphics or extended keyboard protocols. Copies of positioned
rows do not preserve soft wraps. Forks, Windows, imports, and native agent attachments
are absent. Explicit stop handles the launched process group and an interactive shell's
foreground job.

Other background job groups and provider-owned services have their own lifecycle. A
forced server stop or host crash can prevent process cleanup and lose uncommitted bytes.
bbflow never automatically replays recorded actions.

## Publish a release

Install the locked frontend dependencies, then run the checks and create archives:

```sh
npm --prefix web ci --ignore-scripts
make test
make check
make web-check
make release VERSION=0.0.7
sh scripts/smoke-release.sh "$PWD/bin/release/bbflow" 0.0.7
make release-assets VERSION=0.0.7
```

`make release` without `VERSION` reports `dev`. A release tag supplies `X.Y.Z`.
`make release-assets` requires a full version and builds macOS `arm64` and `amd64` with
`CGO_ENABLED=0`. It writes two archives, `install.sh`, and `checksums.txt` to
`bin/releases/vX.Y.Z/`.

The output directory must not already exist. Generated assets stay ignored by Git.
Frontend assets are built before packaging Go. Each archive includes the executable,
`LICENSE`, and `THIRD_PARTY_NOTICES.txt`. Use the current patched Go version required by
`go.mod` for release builds.

The smoke check uses a temporary instance with the menu bar disabled. It verifies the
embedded UI and a read-only query. It stops the server before it removes temporary
files.

Write release notes in `docs/releases/X.Y.Z.md`. Commit the source. Push an annotated
`vX.Y.Z` tag at that commit. The Release workflow runs the required checks and a native
executable smoke check on Apple Silicon and Intel macOS runners. Only after both pass
does it package and publish the release with those notes. The workflow uses the
repository's GitHub token and does not change repository visibility.

If hosted Actions is unavailable, run the same checks locally and verify the intended
remote tag. Create a release for that tag in GitHub. Copy the version's release notes.
Attach the four generated files from `bin/releases/vX.Y.Z/`.

Use either the workflow or manual publishing for a tag, not both. Never replace
published release assets or retag a published version. Publish a new version for fixes.

Installer fixtures run under `make test` with synthetic binaries and GitHub API
responses. They cover architecture selection, pinned versions, version comparison,
checksum/authentication failures, symlinks, and preservation of existing executables.
For a live installation check, use `--dir` with a temporary directory and run the smoke
check against that installed executable. Do not test against production history.

## License

bbflow is licensed under the [MIT License](LICENSE).
