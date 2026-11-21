# bbflow — Current Specification

bbflow has a separate background server and a browser workspace. The CLI opens the UI,
manages the server, edits settings, runs read-only SQL queries, prints a storage report,
and updates the installed executable.
See [GOAL.md](GOAL.md) for continuation, imports, and richer workspace goals.

## Architecture and build

- Go 1.27.3+ core with `github.com/creack/pty`, `golang.org/x/sys`, and
  `golang.org/x/term`. `bbflow update` uses `golang.org/x/term` to find out if standard
  input is a terminal for its question. Synthetic test agents also use it.
- SQLite through the pure Go `github.com/ncruces/go-sqlite3` driver. No CGO in
  deployment builds.
- Frontend sources are under `web/`, with strict TypeScript and CSS under `web/src`.
  Source builds require Node.js 22+ and npm. The TypeScript compiler checks types.
  esbuild bundles the application, xterm.js 6.0.0, FitAddon 0.11.0, CodeMirror 6 with
  `@codemirror/merge` 6.12.3, a fixed set of language modes, and markdown-it 15.0.3
  into one ES2022 JavaScript file and one CSS file. The build also includes HTML and
  the licenses of every bundled npm package, which it reads from the esbuild metafile.
  The JavaScript file is about 1.2 MB. CodeMirror adds about 290 KB, its language modes
  about 400 KB, and markdown-it about 100 KB.
- Generated assets are in `internal/webui/dist`, which Go embeds. Git ignores this
  directory, test compiler output in `web/dist`, and npm dependencies. The deployed
  binary needs neither Node.js nor external frontend files.
- The build collects bbflow's license, the Go license, npm runtime licenses, and
  license/notice files from the Go modules required by `go.mod`. It includes the
  Apache-2.0 text referenced by goffi's attribution notice. These are embedded at
  `/assets/licenses.txt`, so the installed standalone executable retains them.
- On macOS, `github.com/gogpu/systray` v0.3.0 implements a menu bar companion. It uses
  Go FFI to load the built-in AppKit frameworks, without CGO. The server launches the
  same executable as a separate menu process. It needs no `.app` bundle or additional
  executable. Other platforms do not load native menu code.
- The server uses the pinned pure-Go `github.com/eugenioenko/xterm-go` headless
  emulator. It owns terminal screens independently of client connections. This fork of
  `github.com/gitpod-io/xterm-go` fixes a panic when a narrower size reflows more rows
  than the scrollback holds (gitpod-io/xterm-go issue 61). The reflow drops the oldest
  rows.
- A detached Go server owns pseudo-terminals (PTYs) and SQLite. Clients use JSON text
  messages over WebSocket at `/ws`, on an HTTP server bound to loopback. The Go
  transport uses `github.com/gorilla/websocket`. Byte blobs use base64 encoding. The CLI
  and browser clients share the same protocol. See [PROTOCOL.md](PROTOCOL.md).
- Every new session starts an interactive shell with `-i`, using the server environment.
  The server resolves `$SHELL` from PATH or an absolute path, falling back to `/bin/sh`
  when unset. Workspaces accept absolute paths, `~`, and `~/path`.
- `cmd/bbflow-demo` is a developer tool for the demo-instance project skill. It adds
  simulated data to a new instance through the same Go client and protocol types as the
  CLI, and removes that instance. Releases do not include it.
- [DEVELOPMENT.md](DEVELOPMENT.md) gives the build, check, and release commands.

The SQLite driver exposes query authorization and cancellation through supported APIs.
This keeps read-only query enforcement in SQLite and avoids a custom SQL parser.

Storage has projects, sessions, session parents, runs, events, settings, preparations,
worktree metadata, archive flags, and run indexes. Embedded SQL migrations upgrade older
formats at server startup. See [database upgrades](#database-upgrades) for the format
numbers. Commands and APIs may still change during early development. Database upgrades
preserve durable data.

The history package separates schema and models, session/run operations, event capture,
replay, and read-only SQL. Database access stays inside that package. Server handlers
call its methods. Ordinary client commands do not open the live database.

## Commands

[COMMANDS.md](COMMANDS.md) is the reference for each command, its options, its output,
and its effects. The CLI opens the UI, manages the server, edits tools and settings,
runs read-only SQL queries, prints a storage report and the agent guide, and updates the
executable. It has
no session operations, terminal attachment, or `history` command group.

`bbflow skill` prints `cmd/bbflow/skill.md`, which the executable embeds. Fixtures
compare its tables and columns with the migrated schema. They also run each example
through a shell against a test server.

The server listens only on the loopback addresses `127.0.0.1` and `::1`. It does not
support remote access. The UI URL uses `localhost`, and a browser can resolve
`localhost` to either address. Thus the server holds its port at both addresses, and no
other program can take the requests for `localhost` while bbflow runs. A system without
IPv6 loopback uses `127.0.0.1` only. The CLI connects to `127.0.0.1`.

At start, the server tries the `port` from Settings, then the last port in the `server`
table. Port `0` in Settings skips the first step. A port is usable only when it is free
at both addresses. When other programs hold both ports, the server uses a free port from
the operating system. It saves the port that it uses in the `server` table. Settings
keeps its port, so the next start tries that port again.

A save of a new port in Settings fails when another program holds that port at that
time. Settings also rejects the ports from 1024 that browsers refuse to open, such as
6000 and 10080. These are the bad ports of the Fetch Standard. A saved port does not
move the running server.

A local program that takes the port while bbflow is stopped gets the requests of
open tabs. The greeting check cannot authenticate that program. The directory in a
greeting is only what the program claims. A program that gives another directory, or
an incomplete greeting, fails the check, and the tab does not reload.

## Release installation

GitHub Releases provide versioned macOS archives, checksums, and `install.sh` for the
installer and `bbflow update`. Each archive contains `bbflow`, `LICENSE`, and
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

`BBFLOW_INSTALL_DIR` overrides this default. Installer `--dir` overrides both. Each
override must be an absolute path.

For latest-release installs, an existing equal or newer release is left in place,
without downloading binary assets. Explicit version selection can reinstall or
downgrade. The installer verifies SHA-256 before it reads the executable from the
archive. It checks the version before replacement through a rename in the same
directory. Failures before replacement preserve an existing executable.

Existing destination symlinks are rejected. Downloads and staging directories are
removed on exit. The installer does not edit PATH, require sudo, alter history, or
restart a server. `bbflow update` restarts a server, as described below.

Installer `--check` compares the installed executable at the selected installation path
with the requested or latest version, including numeric version ordering. It changes no
installed files and downloads no binaries. Development versions cannot be compared.

The tag-triggered Release workflow tests Apple Silicon and Intel macOS runners before
publishing assets. Release notes are stored in `docs/releases/`. Linux and Windows
packages, Homebrew packaging, and Apple Developer ID signing/notarization are absent.
The installer and release smoke checks use temporary directories. Installer fixtures use
synthetic binaries and GitHub API responses. They do not access real credentials.

### Update

`bbflow update` runs the embedded copy of `internal/install/install.sh` with the invoked
executable's directory. It uses the same curl download, verification, and atomic
replacement as initial installation. It never downloads or executes a remote installer
script. Unsupported platforms and development builds are rejected. Failed downloads or
verification preserve the installed executable. See
[COMMANDS.md](COMMANDS.md#update-bbflow) for its usage, prompt, and options.

The command first runs the installer with `--check` and reads the installed and
available versions. If the installed executable is current or newer, the command stops.
It does not contact the server, ask a question, or change files.

Then the command looks for a live server in the selected instance directory. A live
server holds the archive lock and passes identity verification for any protocol
version. The server does not report its release version. The command does not compare
it with the new version.

The command behaves differently in these cases:

| State of the instance | Question | Executable | Server |
| --- | --- | --- | --- |
| A live server runs. | It asks once. The question says that the server restarts and that all live sessions stop. | Replaced after `y` or `yes`. Unchanged after any other answer. | Stopped and started with the new version after `y` or `yes`. Unchanged after any other answer. |
| No server runs. | None. | Replaced. | None started. The command prints the new version, that no server runs, and the hint `bbflow server start`. |
| A server is shutting down. | None. The command waits up to 15 seconds for the shutdown to finish. If it does not finish, the command stops with an error. | Replaced after the shutdown finishes. | Handled as "no server runs". |
| A server holds the lock but fails verification. | None. | Unchanged. | Unchanged. The command stops with an error. |

`--yes` answers the question in advance. Without a terminal on standard input and
without `--yes`, the command stops with an error before the download. When no server
runs, the command does not create the instance directory.

After the question, the command locks the directory of the executable with `flock`. The
lock creates no file. Updates that share the executable run one at a time, also for
different instance directories. A second update waits and says so. Under the lock, the
command runs the executable with `--version` again. If the version is no longer the
version from the check, another command changed the executable. Then the command stops
with an error and changes nothing.

The command passes its open directory to the updater as file 3. The lock belongs to that
open directory, so it continues until both processes close it. The updater holds it
until it ends, also when the command ends early, for example after Ctrl+C or when its
terminal closes. The updater marks file 3 close-on-exec at once, so the new server, its
menu companion, and its sessions never inherit the lock. An updater without that file
stops with an error.

Hints and recovery commands always name the selected instance, for example
`bbflow --dir '/path/to/instance' server start`. The directory is quoted for a POSIX
shell. A hint without `--dir` could select the default instance and stop its sessions.

The updater environment does not contain `GITHUB_TOKEN`. The new server passes its
environment to each session, and the token is only for release requests. All other
variables of the update command reach the new server, as with `server restart`.

The question comes before the download. After `y` or `yes`, the command does these steps
in order:

1. Download and verify the release while the server continues.
2. Rename the new executable over the old one. Installation uses exactly the version
   from the check, with `--no-next-steps`. Then the command runs the installed
   executable with `--version`. If it reports a different version, the command stops
   with an error.
3. Start the new executable as an updater. The updater runs in a new session (`Setsid`)
   and ignores SIGHUP and SIGINT. Its output goes to `update.log` in the instance
   directory. The command copies that log to the terminal until the updater exits.
4. The updater takes the lifecycle lock of the instance. It stops the server only if
   its verified instance ID matches the ID that the command recorded before the
   question. It uses the same identity check on the shutdown connection as the menu
   Quit action.
5. The updater waits for the archive lock release. Then it starts the server with the
   new version and its macOS menu. It does not open the UI.
6. The command requires a new verified server instance. It does not trust the updater
   exit status alone. Then it prints the old version, the version that the installed
   executable reported, and the `bbflow ui` command for the instance.

If another server runs at step 4, the updater does not stop it and reports an error.
If the start fails at step 5, the new executable stays in place and no server runs.
Then `bbflow server start` is the recovery. Other instances that use the same
executable continue on the previous version until they restart.

The updater is a newer version than the command that starts it. The environment
variables `BBFLOW_UPDATE_CHILD` and `BBFLOW_UPDATE_INSTANCE`, and the locked directory
as file 3, are the interface between the two versions. Keep their names and meaning
stable.

The web UI can start the same update after a release check. See
[Update from the web UI](#update-from-the-web-ui). There is no automatic update.

### Release check

The server of a release build on macOS checks for a newer release by itself.
Development builds, other platforms, and a renamed executable do not check. For a
renamed executable, `server.log` tells why.

While the **Check for a new version every day** setting is on, the server runs the
embedded installer with `--check`, as `bbflow update` does. The check downloads no
binaries. The first check runs when the server starts. The next check runs 24 hours
after the previous check. Each server start checks again. The result stays only in
server memory. A settings save applies at once, also while a check runs. While the
setting is off, the server sends no request and shows no offer, and a view cannot start
an update. When the setting changes to on, the view shows the result of the last check
again. When the setting changes to on after a check is due, the check runs at once. A
failed check keeps the result of the last successful check. It writes its reason to
`server.log` and shows no error in the UI.

The check compares the running version, the version of the executable on disk, and the
latest release. Another instance can install a release into the same executable. Then
this server runs an earlier version than the executable. The server takes the newer of
the latest release and the executable on disk. It offers that version when it is newer
than the running version. When the executable on disk has that version, the offer only
restarts the server.

The installer of a check or a server update runs in its own process group. Server
shutdown stops that group and its curl requests at once. The installer then removes its
temporary files. The update command keeps the installer in the process group of its
terminal, so Ctrl+C in that terminal stops the installer.

### Update from the web UI

The [status watch](PROTOCOL.md#session-status) sends the offer to every view. The
sidebar then shows a button above **Settings**: **Update available: 0.0.15**, or
**Restart to use 0.0.15** for an offer that only restarts the server. The button opens
a confirmation dialog. The dialog shows the two versions and the steps. It names up to
five live sessions that the restart stops and counts the others. It takes the live
sessions from the same status message as the offer. Their titles come from the current
session list, also after a rename. It also links to the release notes on GitHub. **Cancel** changes nothing. While the status watch has no connection, the
view does not know the live sessions. Then the button and the dialog close until the
watch sends the offer again. An update in progress stays in the sidebar.

Each offer has a revision. A check that finds another release or another action gives
a new revision, and an open dialog then closes. A confirmation applies only to the
offer that the dialog showed. After confirmation, the view saves its message draft and
its project draft form. Then it sends `update-start` with the version and the revision
of that offer. The server rejects another version, an earlier revision, a second
update, and an offer that the off setting hides. The offer can change, or the status
watch can lose its connection, while the drafts save. Then the dialog stays open but
does not change. If the start fails, the dialog shows the error and allows no other
attempt. The user must open the update again with current data. All views then show **Updating to 0.0.15…** in the sidebar. The server
does these steps in the background:

1. Lock the directory of the executable, as the update command does. If another update
   holds the lock, stop with an error. Do not wait.
2. Read the version of the executable on disk. If it is the offered version, skip the
   download. The executable can disagree with the confirmed offer: the offer only
   restarts, or the executable has a newer version. Then stop and change nothing. The
   sidebar shows the failure, and the server checks again at once. The views then show
   the new offer, which the user must confirm again. A late confirmation of the earlier
   offer from another view fails, because its revision is earlier.
3. Download, verify, and install the offered release while the server continues. The
   installer appends its output to `update.log`.
4. Start the new executable as the updater, with the same interface as the update
   command. The updater gets the server environment without `GITHUB_TOKEN`. It stops
   this server and starts the new version in the same directory, as described above.

Open tabs then reconnect to the same port and reload, as after `bbflow update`. A tab
with an edit that was not saved keeps the edit and asks the user to reload.

A failure before step 4 leaves the server running. A failure before the rename in step
3 also leaves the executable unchanged. The sidebar then shows
**Update to 0.0.15 failed**. The dialog shows the reason, and the user can try again.
If the updater ends while the server still runs, the offer shows that the restart failed
and names `update.log`. A server that stops during the download stops the installer and
does not start again. If it stops after the rename, the next server start uses the new
executable.

## Server lifecycle

See [COMMANDS.md](COMMANDS.md#start-the-server) for the effects of `server start`,
`server stop`, and `server restart`, and for the selection of the instance directory.
See [PROTOCOL.md](PROTOCOL.md#connections-and-requests) for the greeting and its
verification, the shutdown request, the protocol version, and the message limits.

`start` uses the invoked executable to launch a new detached process, with standard
input disconnected and output appended to `server.log`. It waits up to two minutes for a
successful protocol handshake, including database upgrades. A second start leaves the
matching server unchanged. `stop` requests shutdown through the protocol and waits for
the archive lock to be released. `restart` completes stop before launching the invoked
executable again.

A server closes its listener before it releases the archive lock. When the lock is held
and the published port refuses connections, the server is shutting down. Then `start`,
`stop`, and `restart` wait up to 15 seconds for the lock release. They do not report an
unverified server.

Lifecycle commands serialize within an instance directory. An archive lock prevents
multiple servers from owning it. When the lock is free, lifecycle commands can discard
stale `server.json` information. They never use a saved PID or port to stop another
process.

If the lock is held, lifecycle commands require a verified server connection. Missing,
malformed, or mismatched connection information causes an error instead of starting a
duplicate or stopping an unrelated server. A failed stop does not start a replacement.

The server binds its loopback port and atomically publishes its connection information in
`server.json`, with private permissions. The file is disposable. The server removes it
as the last shutdown step, after handlers, agents, SQLite, and the menu companion stop,
immediately before it releases the archive lock. Until then, a lifecycle command finds a
server that refuses connections and waits for it. A held lock with a missing
`server.json` occurs only while a server starts. Shutdown leaves the file intact if it
belongs to another server instance.

HTTP serves the WebSocket upgrade, the embedded UI, its static files, and the browser
connection information. All session operations and history reads use WebSocket. There
is no separate UI API. See [browser access](PROTOCOL.md#browser-access) for the routes
and the Host and Origin policy.

Shutdown closes HTTP connections and waits for upgraded handlers and agent cleanup
before releasing the archive. An upgraded peer that sends no request can delay shutdown
until its five-second request timeout.

### macOS menu bar

Each new server launches a menu companion on macOS. No command option turns it off.
Builds that set the link-time variable `main.menuBar` to `off` launch no companion.
Only automated tests use that setting. A repeated start keeps the existing server and
its menu. Restart replaces both processes.

The menu contains **Open UI**, a separator, and **Quit bbflow**. The Quit bbflow label
shows the running version, such as **Quit bbflow (0.0.5)** or **Quit bbflow (dev)**.
Preview builds can set a version label at build time, such as **Quit bbflow (0.0.5
dev-1af9)**. Open UI calls the same verified home-page opener as the CLI.

For an instance directory that is not the default of the build, the label shows an
instance tag in place of the version, such as **Quit bbflow (demo-1a2b3)**. The tag is
the folder name without a leading `.` and `bbflow-`, then the first 5 hexadecimal digits
of the SHA-256 hash of the canonical path. Thus folders with the same name in different
checkouts get different tags. The tooltip of the icon also shows the tag.

The build renders the menu icon from `web/src/bbflow.svg` and embeds it in the
executable. The icon shows the letters "bb" on a 16-unit pixel grid and uses macOS
template coloring, so it ignores the logo colors. The 44-pixel PNG has a 3-unit margin around the grid, so macOS
shows a 16-point mark with sharp edges in the 22-point status item.

Quit retains the connection information verified when the companion starts. It
reconnects to that endpoint and verifies the original server identity on the shutdown
connection, without rereading `server.json`. It requests graceful shutdown and waits for
the server's lifetime pipe to close. Missing or replaced connection files do not prevent
Quit. A replacement instance, including one reusing the original port, cannot be stopped
by an old menu.

bbflow accepts one menu action at a time. During shutdown, the menu shows
**Quitting bbflow…**. If an action fails, the menu shows a retry label and writes
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

The browser favicon uses the same pixel logo as the macOS menu bar, in six rainbow
bands from violet to red. The logo selects brighter band colors when the browser uses
dark appearance. The visible product name is bbflow. The sidebar shows it as text at the
top left, without the logo.

Server start and repeated start print a clickable `http://localhost:PORT/` URL without
opening a browser. `bbflow ui` and the **Open UI** menu item open the home page of the
verified server at the same URL. See
[COMMANDS.md](COMMANDS.md#open-the-web-ui).

The UI checks every WebSocket greeting against `/client-config`. A changed server
requires a reload using its current URL. A content security policy restricts scripts
and network access to the local origin and blocks framing. Terminal libraries are
served locally. See [browser access](PROTOCOL.md#browser-access) for the Host, Origin,
and caching rules.

The sidebar lists saved projects and groups sessions, including drafts, through
`project-list` and `session-list`. General appears first. Custom projects follow in name
order. Groups can be collapsed in each view. A group lists
[session families](#session-families): a top-level session and its sub-sessions count
as one family. Each group shows its 10 most recent families. **Show more** below a group
shows 10 more of its families. It has no upper limit. Each reply holds at most 100
families. Thus the list reads the 10 most recent families of 10 groups in each request.
It reads the families after the first 10 of a group in separate windows of at most 100
families. When the group then shows all of its families, the keyboard focus moves from
**Show more** to its last session. The list and Archived keep separate group sizes until
reload. The family of the selected session stays in its group, also when it is older
than the other families that the group shows.

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
IDs, before the group limits. A match of a sub-session also shows its top-level session
as context. It uses SQLite's case-insensitive ASCII matching and treats wildcard
characters literally. This UI does not search message or terminal
contents. Each refresh reads the most recent sessions again, so activity changes can
move a session into or out of the shown part of a group.

The list refreshes every five seconds while visible. It also refreshes when the status
watch reports a terminal start or end, or a title change. There is no manual refresh
control. Project names are plain text. The small arrow expands or collapses a group.
Each project's **＋** creates and selects a new draft entry. A click on an existing
entry reopens it by session ID. The URL keeps that
ID as `/sessions/<id>` through reload and launch. The welcome view is the home page at
`/`. Its toolbar title is **Home**, and it shows one line that tells how to start a
session. The bbflow name in the sidebar returns to it. It also opens when no session is
selected, for example after the archive of the selected session.

The browser tab title shows the session or draft name. Settings shows `Settings`, and
the home page shows `bbflow`.

Below the list, a row holds **＋ Project**, **Archived**, and **Settings**. A newer
release shows above this row. The instance directory shows below the row, except below
a window width of 620 pixels. The sidebar shows the server connection only while the
server is unavailable.

**Archive** hides a draft or finished session from the normal list. It is in the More
actions menu of the toolbar. It is also in the row menu of each draft and ended session
in the list. The ⋯ button of a row opens its row menu, so one click never archives a
session. The button shows on pointer hover and on keyboard focus. On devices without
hover, it always shows. The row menu has **New sub-session** for a top-level session,
and **Archive**, or **Restore** in Archived. A row without such an item has no ⋯
button. While a row menu is open, a list refresh keeps the buttons of the list. The list
then changes after the menu closes. Escape, a choice, or a click outside the menu closes
it. The Up and Down arrow keys move between the items. Archive of a top-level session with sub-sessions
archives the whole family. See [session families](#session-families). Archive of the
selected session first saves the launch choices and message editor. Then the welcome
view opens. A family archive does the same when the selected session is in the family.
Archive of another session keeps the current view.

**Archived** shows the archived sessions in place of the normal list, with the same
search and groups. **Back** above the list, or a second click on **Archived**, returns
to the normal list. A new project also returns to the normal list and clears the
search. **Restore** in the More actions menu or in a row menu returns an item to its
project, or Standalone if that project was removed, without launching it. A restore of
the selected session opens it in the normal list. A restore of another session keeps
the archived list.

While Settings is open, an archive or restore from a row menu keeps Settings open. When the
row is the session behind Settings, **Back to session** then opens the welcome view
after an archive, or the restored session. After an archive or restore with the
keyboard, focus moves to the nearest later session row that shows, or else the nearest
earlier one. Rows of a collapsed group do not count. Without such a row, focus moves to
the search box, or to **Back** in the archived list.

The archive flag is separate from draft/run status. Archiving preserves all SQLite
records, draft revisions, attachments, workspace files, and worktree metadata. bbflow
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
follows the device appearance. A theme selection applies to the current view at once.
Other views read the saved theme on reload or when they open Settings without unsaved
edits. The server includes the theme in each page so it applies before the first render.
If the server cannot read the settings, the page uses System.

Appearance and session defaults save to SQLite automatically. The default starting
branch or commit saves when the field loses focus.

The toolbar title of Settings is **Settings**. **Back to session** is at the top right
of the page.

In **Server**, **Port** sets the port of the next server start. An empty field selects
the automatic port. The field saves when it loses focus or on Enter. The card shows the
port that the server uses now and when a saved port applies. Text that is not a whole
number, a port outside 1024 to 65535, and a new port that another program holds fail to
save. A port that browsers refuse to open also fails. The error shows below the
field. A failed port save does not join a later save of another setting. An edit made
during a port save stays in the field after the reply, with its own error. Open tabs do
not move to a new port.

In **Tools**, enter a name and command in the blank row at the bottom. Click **Add tool**
to save the new tool. Click **Edit** beside a saved tool to edit it in its row. Click
**Save** to apply changes. The add row stays at the bottom during an edit.

In a wide view, **Name** and **Command** head the columns for saved tools and editor
fields. The primary action spans **Edit** and **Move up**. **Cancel** spans
**Move down** and **Remove**. A narrow view puts each label above its field.
**Cancel** discards the current entry or edit. An error keeps the entered values.
**Remove** and the move buttons save at once. Remove has no undo.

A move returns keyboard focus to its button if another move in that direction is
available. Otherwise focus goes to **Edit** on the moved row. After a removal, focus
goes to **Edit** on the nearest row. If the list is empty, focus goes to the add row.

The page sends one settings save at a time. If another view or the CLI saved first,
the page applies the requested change to the latest settings. An edit keeps the latest
value of each tool field that the user did not change. The browser can warn about
unsaved changes when the user reloads or closes the tab.

The theme covers the workspace, dialogs, terminal, and Changes pane. Dark uses charcoal
surfaces, a near-black terminal, and blue for primary actions and focus. The terminal
renders the colors supplied by each program. Light also uses a dark terminal. A browser
without CSS `light-dark()` support uses the Light palette.

**Updates** has the **Check for a new version every day** setting. It saves at once.
New installations and upgrades start with the setting on. See
[Release check](#release-check).

Settings also has a default tool, default worktree choice, default Git base, and an
ordered list of named commands. Shell is built in and sends no startup command.
Users can add, edit, reorder, and remove other presets. A command is one line of shell
syntax, at most 1,000 UTF-8 bytes, without control characters. bbflow does not install
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
stdin can affect queued input. bbflow does not detect prompt readiness or retry this
input.

The server uses the installed Git executable to detect repositories, including linked
worktrees and repository subfolders. Creating a worktree requires an existing commit.
Repositories and bases containing submodules are rejected.

The chosen base (default HEAD) resolves to a commit at Start. If the base names a
remote-tracking branch, such as `origin/main`, Start first fetches only that branch from
its remote. Thus the checkout starts from the current remote commit, not from the last
fetch. A branch that is on the remote but was not fetched before also works if a fetch
refspec maps it. A single-branch clone maps only its branch, so Start fails early for
other branches, and the error names the tracking ref. bbflow does not add tracking refs
that the repository does not map. To map a branch, add a fetch refspec, for example with
`git remote set-branches --add origin feature`. A negative refspec still excludes the
branch.
HEAD, local branches, tags, commit IDs, and expressions such as `origin/main~1` resolve
locally without a fetch.

The configured `remote.<name>.fetch` refspecs of the repository select the remote branch
that a tracking ref copies. For example, with the refspec
`+refs/heads/main:refs/remotes/origin/stable`, the base `origin/stable` fetches the
remote `main`. The most specific destination wins.
Negative refspecs exclude a branch. The fetch updates only the selected tracking ref.
Other matching refspecs, local branches, tags, and `FETCH_HEAD` do not change. If no
refspec maps to an existing tracking ref, or two remotes map it equally, bbflow does not
fetch. The launch then uses the local ref and shows a notice.

The fetch runs before the launch lock, so a slow remote does not delay other launches.
It stops after 15 seconds. The server then stops Git and its transport helpers, such as
`ssh`. Server stop does the same. Until the session message, the starting view gets a
`running` status every 5 seconds, so that the browser does not end the wait.

Git runs without a terminal and without askpass programs, so it shows no credential
prompts. bbflow sets `GIT_ASKPASS=false` and `SSH_ASKPASS_REQUIRE=never`. Credential
helpers and SSH agents still work. A remote that needs a typed password or passphrase
fails.

If the fetch fails and a local copy of the branch exists, the launch uses that copy. The
view that started the session then shows a notice with the Git error and the commit of
the worktree record. bbflow does not record this notice. If no local copy exists, Start
fails and the preparation stays editable.

bbflow creates a fresh branch (user-named or generated as bbflow/TIMESTAMP-SUFFIX) and
checkout under `<instance>/worktrees/YYYYMMDD-HHMMSS-XXXXXXXX`, using UTC and a random
suffix.
Repository subfolder projects launch in the corresponding subfolder. Missing or escaping
subfolders fail the launch and preserve the checkout for inspection and explicit
cleanup.

SQLite records the checkout path, repository, requested base, resolved commit, creation
branch, and lifecycle state. Sessions retain their actual launch paths. The session
header shows the creation branch and launch path. After removal, **(worktree removed)**
follows the path, and the tooltip shows the creation branch.

Only committed files are checked out. Uncommitted changes, untracked/ignored files,
dependencies, and local environment files are not copied. Worktree files remain outside
SQLite and outside the planned database backup. Git worktrees share repository metadata.
They provide independent working files. They are not a security sandbox.

Closing views, stopping sessions, and removing projects preserve worktrees. **Remove
worktree** checks all live bbflow session paths and refuses active or overlapping
workspaces. It also refuses detached HEADs, replaced repositories, and modified,
untracked, or ignored files, and uses Git removal without force. It preserves the branch
and all session history.

External processes and concurrent edits outside bbflow are not coordinated. Git manages
its locks and linked-worktree metadata. Missing or moved repositories cause explicit
errors.

### Session families

A session can have sub-sessions. A sub-session belongs to one top-level session, its
parent. A parent and its sub-sessions form a family. A family has one level: a
sub-session cannot have sub-sessions. `sessions.parent_id` keeps the parent, or NULL for
a top-level session. The parent is set when the sub-session draft is created, and it
does not change. Thus families form only through **New sub-session**. Sessions from
before families stay top-level sessions. The link only organizes the list. A sub-session inherits no
history, draft, or settings from its parent. Each session keeps its own terminal, status,
and lifecycle. **Stop session** stops one session only.

The sidebar shows a family as the row of the top-level session, then the rows of its
sub-sessions in creation order. A family is always open. A guide line goes from the
parent to each sub-session and ends at the last one. A family shows its first 5
sub-sessions. Then **Show N more** ends the guide line. It shows the other sub-sessions
in this view until reload, and the keyboard focus moves to the first of them. A search
shows every matching sub-session, and a selected sub-session always shows. The latest
activity of any member in the list gives the position of the family.

The tooltip of the status icon of a sub-session tells where it works: **parent
workspace**, **own worktree**, **own folder**, or, for a draft, **new worktree**. A ⑂
mark after the title shows an own worktree or a draft for a new worktree. A context row shows a top-level session that is not in
the list itself, at reduced contrast. It is the parent of a match, or a session from the
other collection, such as a parent that is not archived in Archived.

**New sub-session** in the row menu of a top-level session, or in the More actions menu,
creates a sub-session draft. The draft takes the project of its parent. On a
sub-session, the menu item is **New sub-session in this family**: it adds a draft to the
same parent. A session without a saved project cannot get a sub-session. The draft
offers two workspaces:

- **Parent workspace** starts the sub-session in the current workspace of its parent.
  Both sessions then change the same files. This choice needs a parent whose first
  terminal started. Before that, the parent has no launch workspace, also after a launch
  that stopped early. The sub-session gets no worktree record.
- **New worktree** creates a managed worktree from the project folder. The default base
  is the current branch of the managed worktree of the parent, or its commit when that
  checkout is detached. Thus the base has the commits of the parent, also after it
  switched branches. Without a parent worktree, the default is the default Git base.
  Uncommitted changes of the parent are not copied.

In a Git project, the Settings worktree default selects **New worktree**. Otherwise the
draft selects **Parent workspace**. The form says that, in the parent workspace, both
sessions change the same files. For example, a review-loop reviewer runs
`gh pr checkout --detach`. In the parent workspace, that command would change the
checkout of the implementer, so such a reviewer needs **New worktree**.

A request for a sub-session draft names a session. For a top-level session, that session
becomes the parent. For a sub-session, the parent of that sub-session becomes the parent,
so the new draft is a sibling. The draft takes the project of the family. The request
fails for a missing session, for a family without a saved project, and for an archived
parent. The store also keeps the storage rule: the parent of a sub-session is a
top-level session of the same project that is not archived. Removal of a project moves
the whole family to Standalone.

Archive and restore follow the family:

- Archive of a top-level session with sub-sessions first shows the members in a dialog.
  It then archives the whole family. Every member must be stopped first. The view sends
  the sub-sessions that it listed. If the family has other sub-sessions at that time,
  bbflow archives nothing, and the dialog shows the new members. An archive without the
  dialog confirms no sub-sessions, so a new sub-session also stops it. The view then
  shows the dialog with the current members.
- Archive of a sub-session archives only that session. Archived then shows it under its
  parent as a context row.
- Restore of a top-level session also restores all of its archived sub-sessions, also a
  sub-session that was archived alone before.
- Restore of a sub-session also restores its archived parent.

The sidebar is the only place that shows the family of a session. The toolbar of a
sub-session is the same as the toolbar of a top-level session.

### Projects and launches

**＋ Project** at the bottom of the sidebar opens the Add project dialog for a folder and
an optional name. `project-add` saves an existing canonical directory and a name,
defaulting to the folder basename. Git is not required. Canonical paths are unique
across saved projects. Parent and child folders remain allowed. Project IDs are independent of their names and paths.

Names contain 1–200 characters without control characters. Custom projects can be
renamed and removed. Removal sets their sessions' `project_id` to NULL. The UI shows
these sessions under Standalone. Removal preserves recorded workspace paths, runs,
recordings, drafts, and files. `session-rename` changes the user title of a session
without changing its ID or recorded activity. See [session titles](#session-titles).

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
server inherits its startup environment and sets `TERM=xterm-256color`. The launch
stores the tool name and workspace basename as the derived title, also when the user
set a title.

Workspaces accept absolute paths, `~`, and `~/path`. Home expansion uses the server's
`HOME` from startup, before canonicalization. Other relative paths, `~user`, and
environment-variable expansion are unsupported. The directory must exist. History stores
its canonical absolute path. Multiple sessions may share it.

The shell reads its normal startup files. Agents retain their arguments, authentication,
and permissions. bbflow submits only the configured startup command. It does not submit
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
failures trigger automatic reconnect with increasing delays from 0.5 to 5 seconds. The
last screen stays visible and input is disabled until a fresh frame is rendered.

A session connection owns its peer, rendered-frame state, and retry timer. Closing that
view cancels retries and ignores late callbacks from the old connection. A server
restart or update keeps the port, so open tabs reconnect at the same address. The new
server has a new instance ID and can have a new protocol. A tab can get a complete
greeting with a new instance ID, the same directory, and the same port. Then it
reloads once and keeps its path. An incomplete greeting, or a greeting with another
directory or port, needs manual recovery. The reload loads
the UI of the new server. A tab with an edit that the old server did not save does not
reload. It tells the user to copy the edit and reload. The message editor, the project
draft form, Settings, and the open Add project, Edit project, Rename, and Continue
dialogs have this check. A dialog has an edit when a field differs from its value when
the dialog opened. That dialog also shows the message, because it covers the page. A tab that reloaded automatically in the last
10 seconds shows the same message. The old page cannot save edits to the new server. Other protocol and instance mismatches require
explicit recovery. A changed server port requires reopening the UI. Input and session creation are never retried automatically.

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
sent messages, recorded-output search, a read-only Changes pane, and a side terminal.
There is no browser
SQL client. The `bbflow query` command reads archived events. There is no semantic chat
transcript.

### Session titles

A session has two title fields. `sessions.title` holds the title that the user set in
the draft form or in **Rename**. It is empty when the user set no title.
`sessions.auto_title` holds a derived title. The UI shows the user title. Without it,
the UI shows the derived title. Search matches both fields.

Each launch writes the tool name and workspace basename to the derived title, also
under a user title. A rename to an empty title removes the user title, and the session
shows its derived title. Neither field ever changes the other.

Automatic titles apply only to sessions that start after the upgrade to format 10. An
older session keeps its title and has an empty derived title. The archive cannot show
which send was its first, so it never gets an automatic title, also after the user
clears its title.

**Automatic titles** in Settings selects the title tool: None, Claude, Codex, or Code
Puppy. The settings JSON stores `titleTool` as `none`, `claude`, `codex`, or
`code-puppy`. None turns automatic titles off. This is the default.
`bbflow settings set title-tool` sets the same value. A change saves at once.

The server owns the command of each title tool. Users cannot edit these commands:

| Title tool | Command |
| --- | --- |
| Claude | `claude -p --model haiku --restricted --tools "" --strict-mcp-config` |
| Codex | `codex exec --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --disable shell_tool --disable unified_exec --disable view_image --disable code_mode_host --disable apps --disable plugins --disable hooks --disable multi_agent --disable browser_use --disable computer_use --disable image_generation --disable mentions_v2 -c web_search=disabled --model gpt-6-luna -c model_reasoning_effort=low -` |
| Code Puppy | `code-puppy --no-tools --model codex-gpt-6-luna -p "$(cat)"` |

Claude uses Haiku. Codex and Code Puppy use Luna. Settings shows the command of the
selected tool. Each command gives the model only the request text:

- Claude: `--restricted` ignores the settings files, with their hooks and plugins. It
  also limits `@` file references to the working folder. `--tools ""` turns off all
  built-in tools. `--strict-mcp-config` skips MCP servers.
- Codex: `--ignore-user-config` skips `config.toml`, with its hooks, MCP servers, and
  default reasoning effort. The sign-in stays. The read-only sandbox and the disabled
  features remove the tools that read files or run code. `--ephemeral` saves no
  session. `--skip-git-repo-check` is necessary, because the temporary folder is not a
  Git repository. Codex sets low reasoning effort.
- Code Puppy: `--no-tools` turns off its tools and MCP servers. Code Puppy always
  attaches existing files whose paths are in the prompt, so bbflow masks paths in the
  request. Code Puppy 0.0.969 also always loads the user plugins in
  `~/.code_puppy/plugins`, and no option turns them off. So a title run can execute
  plugin code that the user installed for Code Puppy.

The empty temporary folder alone is not a file access limit, because an absolute path
or `~` reaches other folders.

The title command runs once, after the terminal accepts the first send with text from
the message editor. The editor saves a pending draft revision before it writes to the
terminal. It sends the input with the ID `draft-REVISION`, where `REVISION` is that
pending revision. The server records the input bytes and writes them to the PTY. After
the PTY accepts them, the server reads that revision. The input ID comes from the
browser, so the accepted bytes must be exactly the input that the editor writes for the
revision: the text, then each attachment path in single quotes on its own line, with
line breaks as carriage returns, in a bracketed paste or not, and a final carriage
return. Thus only text that reached the terminal goes to the title provider.

The first such verified send with text records a `title` event in the archive, on the
PTY receipt and in the order that the PTY accepts input. Its data holds the draft
revision, the selected title tool, and `requested`. The event is recorded also when the
send starts no request, because the tool is None or the session has a user title. So a
later send never becomes the first message, also after the user selects a title tool
or removes a user title. One statement checks that the session has no `title` event and
inserts it. Thus each session gets at most one title request, also after a server
restart, a lost receipt in the browser, or an unlocked draft. Only the command runs
later, in a job. A failed request does not run again. The command does not run for
autosaves, sends without a receipt, attachments without text, or terminal input from
the keyboard.

The server runs the command with `$SHELL -c`, or `/bin/sh -c` when `$SHELL` is unset. It
uses the server environment. The shell is not interactive, so it does not read
interactive startup files. The command runs in a new empty temporary folder, so agent
CLIs do not read project files. It is not a session terminal, and the archive records
no events for it.

Standard input holds a fixed instruction and the message text. The server cuts the text
at 2,000 bytes. It replaces each `/` with `∕` (U+2215) and each `~` with `∼`
(U+223C). Thus no path, home reference, or link in the request names a file. The
server changes these characters back in the title. Message text never enters the command line that bbflow writes. Code
Puppy takes the prompt only as an argument, so its command reads standard input with
`"$(cat)"`. The shell does not parse the text again. The request starts with plain text, so a CLI does
not treat it as a `!` or `/` command.

The instruction asks the model for one line that starts with `bbflow-title:`. The
instruction describes this marker but does not contain it. The server breaks each
marker in the message text, for example `bbflow-title :`. Thus a CLI that prints the
request back prints no marker.

The server reads up to 64 KiB of standard output. It uses the last line that starts
with the marker, after Markdown marks and spaces. The server rejects output without
such a line, also one line of text, because agent CLIs can print status lines and errors
on standard output with exit status 0. It removes control characters,
`Title:` labels, Markdown marks, quotes, and a final period. It keeps at most 200
characters.

The server stops the command process group after 90 seconds or at server stop. A
nonzero exit, a timeout, or empty output keeps the current title. Exit status 127
reports that the CLI is not installed or not on the PATH of the server. The server writes
the error and the first 4 KiB of standard error to `server.log`. Server stop waits for
title commands before the archive closes. A title command that is running at a server
crash or restart is lost. The server does not run it again.

After each title change, the status watch sends a new title revision. Each view then
reads the session list again.

**Test** in Settings runs the selected title tool once. It is not available for None.
Test and the tool list stay disabled until the test ends, also when another setting
saves. A result shows only while its tool stays selected, also after another view
changes the tool. The browser waits 100 seconds for the reply, longer than the 90-second server
limit.
It sends a fixed sample message, not a message of a session, and saves nothing. The
result shows the sample message first. Under it, a green line shows **Test passed**
with the title from the sample message. A red line shows **Test failed** with the
error. A change of the title tool hides the result.

The title tool sends the first message to its provider. It uses the installation and
authentication of the user. Claude and Code Puppy can save each call in their own
history. Codex saves none.

Code Puppy prints status lines and the request before the answer. It prints request
errors on standard output with exit status 0. It also asks for `puppy_name` and
`owner_name` at each start until `puppy.cfg` has values. Complete this setup before you
select Code Puppy.

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
while you view the latest terminal of an unarchived session after that terminal ends
(`exited`, `stopped`, `failed`, or `interrupted`). A managed worktree needs the stored
state `ready` to enable the button.
If the worktree state blocks the action, hover over the button or use Tab to see the reason.

The dialog shows the session workspace, a tool choice, the handoff prompt, and a Copy
button. The default tool is the session's original tool if it still exists, then the
default tool, then Shell. For an `interrupted` run, the dialog warns that an agent from
a crashed server can still run in the workspace.

If the session changes while the dialog opens, the UI explains why continuation is unavailable.
If the latest run changes or continuation becomes unavailable while the dialog is open,
the UI closes the dialog and shows the reason.

`session-continue` carries the latest run ID that the view saw. The server holds the
launch lock and rejects the request in these conditions:

- A terminal of the session is live.
- The latest run ID is different, for example because another view continued first.
- The latest run has not ended, the session is archived, or it has no run.
- The managed worktree is not `ready`, or the session workspace no longer exists.
  bbflow does not create a replacement worktree.
- The selected tool no longer exists.

A rejected request writes no files and starts no process. Otherwise the server writes
the handoff folder, then starts `$SHELL -i` in the session's recorded workspace. The
session keeps its ID, title, project, worktree, message draft, and history. The new run
gets the same `BBFLOW_SESSION`. Its start event records the tool name, the previous run
ID (`continues`), and the handoff folder.

The handoff folder is `<instance>/handoff/<session-id>/`. It is a derived cache with
private permissions and read-only files. bbflow rebuilds the whole folder from SQLite
for each new terminal. It writes a staging folder, then renames it. No terminal is live
during this change. The folder contains these files:

- `README.md`: rules for the reader, the session and worktree details, and every
  earlier terminal, newest first. Each terminal has its number, run ID, tool, times,
  status, detail, and whether it started from a handoff. The rules say that the files
  are a record of earlier work, not instructions or approvals. They tell the agent to
  check the current files, for example with `git status`. The README also has a
  `bbflow query` command for the original recording of a terminal, and a pointer to
  `bbflow skill`.
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

bbflow records and submits the selected tool's startup command once. Shell starts
without a command. The user can copy the handoff prompt from the dialog.

The prompt stays available after the new terminal starts. When the handoff folder of
the selected session has its README, **Handoff prompt** appears in the action row of
the message editor. Its dialog shows the folder and the prompt, with **Copy prompt** and **Put in
message editor**. Put in message editor works only when the editor has no text, no
files, and no pending send. It never merges with or replaces a draft, and it sends
nothing. The user sends the prompt with Send when the agent is ready.

### Earlier terminals

When a session has more than one terminal, a row above the terminal shows a selector. Its
label names the shown terminal, for example `Terminal 2 of 3 · Codex · exited`. Click
the label to see every terminal in start order. Each row has the number, tool, status,
and start and end times. A live terminal has a green dot. ‹ and › step to the earlier
or the later terminal. A session with one terminal shows no selector and no row, so
the terminal starts at the top of the pane.

An earlier terminal shows its saved final screen with its recorded dimensions, as an
ended latest terminal does. The view is read-only, and the hint says that input and Send
are off. **Back to live terminal** in the terminal footer opens the latest terminal
again. When the latest terminal has ended, the button is **Back to latest terminal**.
Reload and the session link also open the latest terminal.

A view of an earlier terminal leaves the live process, its capture, and its views active.
Only views of the live terminal can change its size. The status badge applies to the whole
session. The session toolbar hides **Stop session** and **Continue in new terminal** while
you view an earlier terminal.

The UI reads the list with `session-terminals` when it opens a session, when a terminal
starts or exits, and when the selector opens. A start or a continue first clears the list
of the view, because the list then lacks the new terminal. The selector hides until the
new list arrives. The tool name comes from the start event
of each run. Start events from bbflow 0.0.4 and earlier have no tool, so the first run
uses the tool of the preparation. A new terminal has no run record until its process
starts. Until then, the list ends with a `starting` terminal without a run ID. The UI
reads the list again every five seconds until that terminal has a run.

### Workspace pane

The workspace pane is to the right of the terminal and the message editor. It shows one
of three views:

- **Changes** lists the changed files and shows their diffs.
- **Files** shows the workspace folder as a tree and the current files.
- **Terminal** shows the [side terminal](#side-terminal).

Each view has an icon in the session toolbar, after the search icon. The tooltips are
**Show changes**, **Show files**, and **Show terminal**. A click on an icon opens the
pane with its view, or changes to its view. The icon of the shown view is pressed. A
click on it closes the pane. **×** in the header of each view also closes the pane.
Each view has a header with its name and only its own controls.

Drafts have no workspace pane. Ended sessions keep it while their workspace exists. A
drag on the divider or the Left and Right arrow keys change the pane width.

The session keeps a width of at least 360 pixels, so that its terminal keeps a usable
size. The pane keeps at least 320 pixels. When the window becomes narrower, the pane
becomes narrower first. When the window becomes wider again, the pane goes back to the
width that the user set. A drag cannot make the pane wider than the session allows.
When the main area is narrower than 707 pixels, it cannot hold both minimum widths.
Then the pane is below the session, the divider is not available, and the main area
scrolls.

Each session has its own open state and view in the browser tab. A session that the
browser tab has not shown yet starts with a closed pane. A session that you start from a
draft also starts with a closed pane. When you select a session again, its pane shows
the view that it showed before. The width belongs to the browser tab, and all sessions
use it. Other browser tabs keep their own state. A reload resets the open states, the
views, and the width.

### Changes pane

The Changes and Files views of the [workspace pane](#workspace-pane) are read-only.
They never change files, the Git index, or SQLite. Each view has its own selected file
and its own filter text. The scope button, **Split**, **Unified**, and the file count
are only in the Changes header. The Files header has **Refresh** and **×** only.

- The scope button shows the selected changes. Its width comes from the pane width and
  not from its label, so the other controls do not move when the label changes. A
  click opens the scope menu. A click outside the menu, or Escape, closes it.
- The session base is the recorded commit of a ready managed worktree. Other sessions
  use the merge base of `HEAD` and the default branch. The default branch is the target
  of `origin/HEAD`, or else `main`. A session has no base without such a branch,
  without a merge base, or when `HEAD` is the merge base. `HEAD` is the merge base
  when it has no commit that the default branch does not have, for example on `main`
  without local commits. Local commits on `main` that `origin/main` does not have, such
  as commits that are not pushed, get `origin/main` as their base.
- **All changes** is at the top of the menu when the session has a base. It compares
  the base with the current files, so it includes the commits since the base and the
  uncommitted changes. It is the default when the session has a base. The labels do not
  claim that one session made the changes, because other sessions and tools can share a
  workspace.
- Below it, a timeline lists **Uncommitted changes** and the commits since the base,
  newest first. **Uncommitted changes** compares `HEAD` with the current files. A
  repository without commits uses the empty tree. A commit compares its first parent
  with its own tree. A root commit compares with the empty tree. Each commit row shows
  its short ID, its subject, and the number of files that it changes in the session
  workspace. The tooltip has the full subject.
- A click on the text of a row shows only that change and closes the menu. Each row also
  has a dot. Rails join the dots. The dots are for ranges. One selected row is
  highlighted, and its dot stays empty. A click on a dot selects its row and puts a
  ring on the dot. A click on a second dot selects all changes between the two dots.
  Their dots fill, and a thick line joins them. The diff then compares the first parent of the oldest selected
  commit with the newest selected commit, or with the current files when the range has
  **Uncommitted changes**. Before the second click, the pointer over a dot shows that
  range. A click on the same dot, or Escape, cancels the range. A range of every row
  stays a range. It can differ from **All changes**, for example when a commit merged
  the default branch. The menu stays open after a dot or **All changes**, so that the
  line stays in view. After a click on the text of a row, the focus goes to the scope
  button.
- When the focus is in the Changes view, `[` steps to the older row and `]` to the newer
  row. From a range or **All changes**, a step goes to its end in that direction. A
  field, such as the filter box, keeps the keys.
- A diff that ends at a commit has no untracked files. In it, **View file** shows the
  file at that commit. Files always shows the current files.
- The commit list follows the first parent from `HEAD`, up to 30 commits. It stops at
  the base. Without a base, it lists the latest commits of `HEAD`. A shallow clone does
  not have the parent of its last commit. The list omits that commit. The menu shows
  "Older commits are not listed." when the list omits commits, also when the list is
  empty. When a rebase or a reset removes a selected commit, or the session loses its
  base, the next refresh uses the default changes. When a file read finds this first, the pane reads the list again. If
  that read fails, the pane shows no file until a later refresh succeeds. A refresh
  cancels the file request of the earlier list, so a late file reply cannot change a
  newer choice.
- **Split** shows the old and new file side by side. **Unified** shows one column with
  removed and added lines. When the editor area is narrower than 520 pixels, the pane
  shows Unified and marks it as pressed. Split keeps a dashed border until the pane is
  wide enough. Unchanged regions fold into bars. Click a bar to show its lines.
- Both layouts use green for added lines and red for removed lines. Stronger fills mark
  changed text. Split shows a gutter marker for each changed line. Unified shows one
  `−` per block of removed lines and one `+` per added line. Syntax colors, line numbers,
  and folded regions follow Appearance. The file view uses the same syntax colors.
- Markdown files use GitHub Flavored Markdown colors. Headings, links, code, and quotes
  have their own colors. Markup characters, such as `#` and `**`, are muted. A fenced
  code block gets the colors of its language when the first word of its info string
  names a language that the pane supports, such as `go`, `ts`, or `bash`.
- The **Changes** view lists the changed files with Git status letters A, M, D, R, and T. An
  untracked file has A. After `git rm --cached`, the path has one row with M. An
  untracked nested repository shows as one folder row. The filter box matches any part
  of a path without case. A long path keeps its file name in view and shortens its
  folder.
- The **Files** view shows the workspace folder as a tree. Click a folder to open or
  close it.
  The pane reads a folder when it opens. The tree puts folders first and sorts names
  without case. It omits `.git`. It includes the entries that Git ignores, in a muted
  color. A changed file shows its status letter. A folder with a change below it shows
  a dot. A deleted file is not in the tree. An open folder without entries shows
  "Empty folder".
- With text in the filter box, **Files** shows a list in place of the tree. The list has
  the paths that match, from the paths that Git tracks or does not ignore, and from the
  deleted files.
- A file that you select in **Files** shows its current text. A file that you select in
  **Changes** opens as a diff. A symlink opens as a file with its target text.
- PNG, JPEG, GIF, WebP, and SVG files show as images in both views. The server reads
  the raster format from the first bytes of the file, not from its extension. The file
  view shows one image. The diff shows the old and the new image. **Split** puts them
  side by side, and **Unified** puts the old image above the new image. An added file
  shows only its new image, and a deleted file only its old image. A text side without
  an image, for example the text side of a type change, shows its text in place of the
  image. Another side without an image shows a note.
- An SVG file shows as an image only when its root element is `svg` in the SVG
  namespace, `http://www.w3.org/2000/svg`. A prefix, as in `svg:svg`, needs its own
  namespace declaration. Before the root, the check skips white space, the XML
  declaration, processing instructions, comments, and a document type declaration.
  Other text in an SVG file, such as the pointer text of Git LFS or an `svg` element in
  a comment, shows as text. The old side of a
  rename uses its old path. Thus a rename from an SVG file to another file type shows
  the old image.
- Each image fits in its side and never gets larger than its actual size. A click on
  an image shows all images at their actual size, with scroll bars when necessary. The
  next click fits them again. An SVG file without its own width and height has no
  actual size, so it fills its side in both cases. A checkerboard shows transparent
  pixels. A caption above
  each image shows **Old** or **New** in a diff, the format, the pixel size, and the
  file size. An SVG file shows no pixel size. An image that the browser cannot decode
  shows "The browser cannot show this image."
- For an SVG file, **View source** shows its text, or the diff of its text. Next to a
  raster image or a side without text, such as a binary side, the SVG side shows its
  text in place of its image. The other side keeps its image or its note. **View image** shows
  the image again. The choice applies to all SVG files in both views of
  the browser tab. A reload resets it.
- Images show only in `img` elements, from `data:` URLs. There, an SVG file cannot run
  scripts or load other files. The page policy also allows images only from the page
  and from `data:` URLs.
- A vertical divider between the file list and the file view changes the list width.
  Drag it with a mouse or touch. Or focus it and use Left/Right to resize. Use
  Home/End to reach the limits. A double-click restores the default width, 24% of the
  pane but at least 140 pixels. The list stays at least 140 pixels wide. When the list
  and the file view have at least 420 pixels together, the file view keeps at least
  280 pixels. In less space, the list stays at 140 pixels and the file view gets the
  remaining space. Changes and Files use the same width. In a narrower pane, the list
  gets narrower and keeps the selected width for a wider pane. Below a window width of
  620 pixels, the list is above the file view and the divider is not available.
- In Changes, the file header shows the path and the line counts. **View file** and
  **View diff** change between the current text and the diff.
- In Files, the file header shows the path only. For a changed file, **View diff**
  opens the diff of that file in the Changes view. **Copy path** copies the path
  relative to the workspace in both views.
- For a Markdown file (`.md` or `.markdown`), **Preview** shows to the right of the
  path in both views. **Preview** opens a dialog with the file path, a close button
  (✕), and the rendered current text. The button is not shown for a deleted file, a
  binary file, a file above 1 MiB, or a symlink. The dialog keeps its text while it is
  open. Use **Refresh**, then **Preview** again, to see a later change.
- In a narrow pane, the line counts, **View source**, **View file**, and **Copy path**
  go to a second row of the file header. The path and **Preview** keep at least 200 pixels.
- Preview uses markdown-it with CommonMark, GitHub tables, strikethrough, and task
  lists. Raw HTML shows as text. Images do not load. The dialog shows "Image not
  loaded" with the alternative text and the source. Task list checkboxes are disabled.
  In forced colors mode, they use the checkbox of the browser.
  An escaped marker, such as `\[x]` or `&#91;x]`, stays text. A fenced code block gets
  the syntax colors of the file view when the first word of its info string names a
  language that the pane supports. Other code blocks show as plain text.
  Only `http:`, `https:`, and `mailto:` links open, in a new tab. Other links, such as
  relative paths, show as text with the target in their tooltip. `javascript:`,
  `vbscript:`, `file:`, and most `data:` links stay Markdown source text.
- The pane reads its lists when it opens, on **Refresh**, on a change of the view, and
  when the window gets focus. It does not watch files. A refresh reads
  each open folder again. It closes a folder that is gone. A refresh keeps the shown
  file when its content is the same.
- Only the latest request for a folder changes its entries. A reply or a failure of an
  earlier request does nothing, also after the folder closes and opens again.
- The keyboard focus stays on its row when the list changes. Thus Tab moves from an
  opened folder to its entries.
- In a folder that is not a Git repository, the Changes view shows "Not a Git
  repository. Files shows the workspace." The scope button and the filter box are off
  there. The Files view shows the tree and the current files. When the server has no
  Git executable, Files works in the same way, and Changes shows the error.

The selected changes, the open folders, the filter text, and the selected file of each
view belong to the browser tab.
Other browser tabs keep their own state. A visit to Settings or the home page keeps the
state. A different session or a reload resets it.

The layout and the list width also belong to the browser tab. A different session keeps
them. A reload resets them.

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

- Each text side of a file holds at most 1 MiB. An SVG file is text, so this limit
  applies to it. An image side holds at most 5 MiB, so that two image sides in base64
  fit in one 16 MiB protocol message. A larger side shows a note instead of its content.
- A side with a NUL byte in its first 8000 bytes, or with invalid UTF-8, is binary. A
  binary side that starts with the signature of a PNG, JPEG, GIF, or WebP file is an
  image. Text stays text, also when it starts like an image. Thus text above 1 MiB is
  too large. The pane shows a note instead of the content of other binary sides.
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
- After a failure, a refresh continues with the other folders that need a request of
  their own. The pane keeps the first error of that refresh in view. When the request
  of the refresh fails, the pane reads each open folder that has no entries yet in a
  request of its own. Thus no folder stays on "Reading…" without a request.
- When the first read of the workspace folder fails, the tree shows "Cannot read this
  folder. Click Refresh to try again." in place of "Reading…".
- Line counts of untracked files use at most 32 MiB of reads for each list. Later
  untracked files show no count. An untracked file above 1 MiB has no line count. When
  its first 512 bytes are binary data with a PNG, JPEG, GIF, or WebP signature, it
  counts as binary.
- A folder that is not a Git repository has no changes and no filter.

### Side terminal

The side terminal is a shell for ad hoc commands in the session workspace. It is the
Terminal view of the [workspace pane](#workspace-pane). Thus the session terminal keeps
its full height. Drafts have no side terminal. Ended sessions have one while their
workspace exists.

- When you click the terminal icon, the server starts `$SHELL -i` in the session
  workspace. When the session already has a live side terminal, the view joins it. Each session has at most one live side terminal. All views of a session
  share it.
- The server does not record the side terminal. SQLite has no events, run, or screen of
  it. Search history, the handoff folder, and `bbflow query` cannot read it. The view
  shows "Not recorded. Runs in the session workspace."
- The side terminal does not change the session status, the view count, or the session
  order.
- Type directly in the view. The message editor sends only to the session terminal.
- Another view, the pressed terminal icon, and **×** hide the terminal. The shell
  continues, and the browser tab stays connected. A hidden terminal keeps its PTY size.
  **Stop shell** ends the shell and its foreground job for every view. When the shell
  ends, the view shows its exit code and **Start shell**.
- Each shell has an ID. A view reconnects and stops only the shell that it showed. When
  another view started a new shell after that shell ended, the view shows "The shell
  ended." It does not join or stop the new shell.
- After the shown shell ended, a click on the terminal icon connects again. The view
  joins the live shell of the session, or it starts a new shell.
- Only a click moves the keyboard focus to the side terminal. A reconnection keeps the
  focus where it is.
- Stop session ends only the session terminal. Archive stops the side terminal. Server
  stop ends it as well. A managed worktree cannot be removed while a side terminal uses
  it.
- When you select a session that showed its Terminal view, the view shows again. It
  joins the shell of that session, but it does not start one. Click **Start shell** to
  start a shell there.

After a lost connection, the view rejoins the same shell. It never starts a new shell on
reconnection. When the shell ended during the disconnection, the view shows
**Start shell**.

### Message editor

The multiline composer stays visible below preparation and terminal views. A horizontal
divider with a centered grip resizes the terminal and editor after launch. Drag it with
a mouse or touch. Or focus it and use Up/Down to resize.

Use Home/End to reach the limits. Both panes keep a minimum height. Editor contents
scroll when needed. The editor size stays with the browser view across session switches
and resets on reload. Size changes use the existing terminal viewport updates.

A viewport change resizes the PTY only from the size owner view. Direct terminal
interaction remains available.
The editor has no visible label or help text. Its action row holds **＋ Attach files**,
**Handoff prompt**, **Sent messages**, the draft status, and **Send ⌘↵**. The tooltips
of these buttons explain them. The row wraps when the editor is narrow, for example
while the workspace pane is open. **Send** stays at the right end of its line.

Enter inserts a newline. Command-Enter or Ctrl+Enter in the editor does the same as
Send. After such a send, the keyboard focus returns to the editor, unless the user
moved it to another control. Send sends one `input` control to the attached PTY with the
message followed by Enter. When the application enables bracketed paste, the message
uses its paste delimiters. Newlines are normalized to carriage returns, matching
terminal paste.

The editor rejects multiline text and tabs without bracketed paste. It rejects other
terminal control characters. Existing input at the terminal prompt is not cleared.
bbflow does not infer readiness or completion, and a shell still treats submitted text
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

**Sent messages** in the editor action row opens a list of the session's sent messages.
The oldest message is at the top and the newest is at the bottom. The list opens
scrolled to the bottom and shows the newest 20 messages. **Show older messages** at the
top loads 20 more and keeps the visible messages in place. The `composer-sent` operation
derives this list from the existing pending draft revisions. Thus the list also includes
sends from before this feature. Direct terminal input is not listed.

Each message shows its time, text, and attached file names. **Sent** means that the
editor got an input receipt and then cleared the draft. **Not confirmed** means that
there was no receipt, or the user unlocked the draft. This status is derived. It does
not confirm that the application accepted the message.

A long message shows its first 8 lines, and the list is the only scroll area. **Show
more** below the text shows 16 more lines. Each later click shows double the lines of the
previous click. The button shows the number of hidden lines. When fewer than 4 lines
would stay hidden, all of the text shows. **Show less** returns to the first 8 lines.
When a click hides its button, the other button gets the keyboard focus.
The line count follows the current text wrap.

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
depends on the agent's capabilities and workspace permissions. bbflow does not change
permissions for the agent.

## Terminal runtime

Before launching a shell, bbflow records its resolved command, arguments, workspace, and
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

A web view asks for at least 20 columns and 5 rows, for the session terminal and the
side terminal. When the terminal area of the view is smaller, the terminal scrolls in
the view. Thus a narrow view does not make an agent redraw and hard-wrap its output at
a few columns.

Only a size owner resize reaches the shared emulator and PTY. The server orders accepted
input with size owner changes. A size change reaches the PTY before the input that caused
it. The server sends receipts to their original view. Input that two views send at the
same time can interleave.

Committed output and size events update the emulator in order. Terminal query responses
are recorded as `terminal-response` before PTY delivery. One notification combines
render requests. There is no per-client queue of raw output. Each attachment has its own
immutable render baseline and one outstanding frame.

An emulator panic does not stop the server. Live updates and the replay of a stored run
recover the panic for that terminal only. The server writes the session, the event
sequence, the event kind, and the stack to `server.log`. It then starts a blank emulator
at the size of the event, and views get a full frame. The process and the archive do not
change. The rendered screen and history before the panic are lost from that view.

After its acknowledgment, the server computes changes from the latest state, at most 20
times per second. Final output is acknowledged before exit. Input receipts use a
separate bounded queue.

A new attachment always starts with a full frame. Reconnecting does not change the PTY
size while another view owns it. The server updates PTY size when the size owner's
dimensions change. Reattaching at the same size uses the saved screen without requesting an
application redraw. An ended view never starts another process or invokes native
provider resume. Only an explicit `session-continue` starts a new terminal in an ended
session.

The server orders families by the most recent member in the collection, with the rules
below. A family lists its top-level session first, then its sub-sessions in creation
order. The UI requests 101 to display 100 entries and detect another page. Normal listing
excludes archived sessions. Archived listing includes only archived sessions, and the
parents of archived sub-sessions as context. Ordering
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
(empty for standalone), parent ID (empty for a top-level session), workspace, update
time, status, archive flag, view count, and a context flag.

### Session status

Each session shows one status. The server derives it. SQLite keeps the run status and
the preparation state without change, so `bbflow query` results do not change.

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
message boundaries are inferred from silence. bbflow never sends input because of a
status.

Each sidebar row has one line: a status icon, then the title. Standalone sessions add
their workspace on a second line. The icon has a different shape for each status:

| Icon | Status |
| --- | --- |
| A green dot with a slow pulse | `running`. With the reduced motion setting, the dot does not move. |
| A green ring | `idle` |
| A gray dashed ring | `draft` |
| A gray dot | `ended`, after an exit or a stop |
| An amber dot | `ended`, when the latest run `failed` or was `interrupted` |

The tooltip of the icon gives the status text, for example **Idle: live, with no output
in the last 3 seconds** or **Ended · stopped**. It adds **Archived**, the view count, and
the place of a sub-session. The tooltip of the row adds the same text to the title,
workspace, ID, and update time. A label for screen readers gives the short status, for
example **idle, 1 view**. Each page keeps one `status-watch` stream
open. The server pushes the statuses of all live terminals on it, at most 200
milliseconds after a change. Thus the sidebar shows brief activity of each session,
also without a view of that session. The `session-list` refresh every five seconds
supplies all other session data. It also supplies the statuses while the watch
reconnects. When a terminal starts or ends, the page reads the list at once.

A status change updates the icon, the tooltips, and the label of a session button in
place. The
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

The session toolbar shows the status next to the session title. Below the title, a
line shows the tool of the shown terminal, the worktree branch, and the workspace path,
for example `Codex · ⑂ feature · /path/to/workspace`. Each terminal records its own tool,
so the line changes when a view shows an earlier terminal with another tool. A draft
shows only its path. Until the terminal list loads, or when it cannot load, the line
shows no tool. A start or a continue clears the list of the view, so the line shows no
tool until the list with the new terminal arrives. The toolbar does not show the startup command. The shell usually
echoes it at the top of the terminal, and the start event records it. At the right, a search
icon opens **Search history**. Three icons show the Changes, Files, and Terminal views of
the workspace pane. **Reconnect** shows when a view of a live terminal has no connection.

The session toolbar shows **Stop session** to the left of the icons when you view the
live terminal. During worktree creation, the session shows `running` before a terminal
exists. When the server reports that it stopped no terminal, the page says so and leaves
the status as is. When the session ends, **Continue in new terminal** shows there in the
latest terminal view.

A hint below the terminal shows only when the view cannot send input. This occurs when
the process ended, when the view shows an earlier terminal, or when the connection is
lost. A view of the live terminal has no hint.

**More actions** (⋯) opens a menu that lists only the actions that apply:

- **Rename** shows for started sessions. The field shows the user title, or the derived
  title as a placeholder. An empty field removes the user title.
- **Copy session ID** copies the ID of a started session to the clipboard.
- **New sub-session** shows for a session that is not archived and has a saved project.
  See [session families](#session-families).
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
changes. bbflow does not serialize writers or isolate filesystem changes.

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
controlled. bbflow never treats a stored PID as authority to kill or revive a process
and never replays terminal input. Stopping a session with no process owned by this
server is a no-op.

## History and storage

The build sets the default instance directory. Plain `go build` and `go run` use the
development default. `make release` sets `main.instanceDirName=.bbflow` through Go's
linker. See [instance directory](COMMANDS.md#instance-directory) for the defaults and
the selection order. bbflow creates SQLite (`history.sqlite`) under the selected
directory with private permissions.

The archive stores projects, sessions, runs, settings, preparation choices, worktree
metadata, and append-only events with stable global sequence numbers. New runs set
`BBFLOW_SESSION` and canonical `BBFLOW_DIR` for CLI retrieval, overriding inherited
values. `BBFLOW_SESSION` is a value the caller can use in SQL, not an automatic filter.
No retrieval prompt is automatically added to the agent's conversation. An agent can
run `bbflow skill` to get the retrieval guide.

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

- Empty databases run the format 3 baseline, then migrations 4 through 14. In the same
  transaction, a new database sets `worktree` to true in the settings JSON. Thus new
  installations select **Use worktree** by default. Upgrades keep the saved value.
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
- Format 8 removes the obsolete `continueCommand` field from saved tools through
  migration 9. The upgrade keeps tool IDs, order, startup commands, and the settings
  revision.
- Format 9 gains the `sessions.auto_title` column through migration 10. Existing
  sessions keep their titles as user titles, with an empty derived title. The upgrade
  does not guess which old titles were defaults. Sessions with an empty derived title
  never get automatic titles. It also adds `titleTool: "none"` to
  the settings JSON, so automatic titles start off. The settings revision stays.
- Format 10 gains the `server` table through migration 11. Its one row keeps the last
  port of the server, with `0` for no saved port. The first start after the upgrade
  saves a new port.
- Format 11 gains `updateCheck: true` in the settings JSON through migration 12. Thus
  the daily release check starts on, also after an upgrade. The settings revision and
  the other values stay.
- Format 12 gains the nullable `sessions.parent_id` column and its index through
  migration 13. Existing sessions stay top-level sessions.
- Format 13 gains `port: 0` in the settings JSON through migration 14. Port `0` selects
  the automatic port, so the server keeps its last port. The settings revision and the
  other values stay.
- Format 14 opens without running scripts or rewriting history, settings, or metadata.

The upgrade preserves IDs, timestamps, event sequences, original blobs, text, drafts,
and attachments. It also preserves the highest allocated event sequence. Migration
starts no agents and replays no input. Startup interruption recovery still runs
afterward. Repeated or concurrent opens see the committed version and skip completed
steps.

Formats 1 and 2 have no known migration path in this repository. They, nonempty
unversioned databases, and formats newer than 13 are rejected without changing their
schema or records. A newer format error asks for a newer executable. There is no
downgrade path, external migration command, or automatic backup.

### Read-only SQL

Each query opens a separate `mode=ro` connection with `query_only` enabled and
`trusted_schema` disabled. The SQLite authorizer permits only reads, selects, recursion,
and functions. It rejects file and extension functions, which bbflow does not install.
All other operations, including PRAGMAs, transactions, schema changes, and ATTACH, are
denied. SQLite prepares the SQL and its remaining text before execution.

The server rejects a second statement. The result must be read-only and have columns. No
SQL parser or prefix-only write check is maintained in bbflow.

The connection uses a five-second cancellation context that applies during preparation
and row stepping. It does not share the terminal capture connection. See
[COMMANDS.md](COMMANDS.md#query-sqlite) for the result format, the size limits, and the
`truncated` flag.

### Storage report

The `storage-report` operation returns the storage use of the archive. `bbflow storage`
prints it as Markdown. See [COMMANDS.md](COMMANDS.md#storage-report) for the report
sections.

`Store.StorageReport` uses its own `mode=ro` connection and one read transaction, so the
page counts and the event totals come from one snapshot. It does not block capture. A
long read can keep the WAL from a full checkpoint until the read ends. The read stops
after 10 minutes, or when the client closes its connection.

The report reads every event row once with one plain table scan, and Go adds up the
rows. The scan reads the byte lengths of `data` and `text` from the record headers. Thus
SQLite does not copy the payloads, and an attachment larger than the 1 MiB value limit
of the read connection does not stop the report. A `GROUP BY` is not used, because its
sort records copy the payloads. Only start events return their data, for the tool names.
A synthetic archive of 1.4 GB with 6 million events took about 2 seconds on an Apple
silicon laptop.

The reply lists only the sessions that the report shows: the 10 largest sessions with
events, and the 5 largest sessions with events in each of the 3 largest projects. Counts
of all sessions, archived sessions, sessions with no events, and terminals are separate
fields. Thus the session lists have a fixed limit for any number of sessions or events.

Three lists have no limit. `projects` has one entry for each project with sessions,
`days` has one entry for each UTC day with events, and `kinds` has one entry for each
event kind. A project entry uses about 120 to 300 bytes of JSON, and a day entry about
100 bytes. If the reply is larger than the 16 MiB protocol limit, the server sends the
error `the result exceeds 16 MiB` in its place. `bbflow storage` then prints that error
and no report, and exits with code `1`. This needs tens of thousands of projects with
sessions, or more than 100 years of days with events.

A start event from bbflow 0.0.4 or earlier has no tool. As in the terminal list, the
first terminal of a session then uses the tool of the session preparation.

Event counts and the bytes of each events column are exact. The embedded SQLite build
has no `dbstat` table, so the report cannot measure each table or index. SQLite also
does not record which pages belong to a session. Thus each size for a session, project,
kind, or day is an estimate: its data and text bytes, plus its event count times the
average overhead for each event. The average overhead is the used space, less all data
and text bytes, divided by the event count. The estimates add up to about the used
space.

Input/output and launch arguments can include secrets. No redaction or encryption is
implemented. The local archive is not isolated from other processes running as the same
OS user. bbflow implements no telemetry or cloud storage.

All durable bbflow data is in `history.sqlite`:

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
both baselines of a managed worktree after an agent commit. Commit baseline fixtures
cover the commit list with its file counts, a subject with a tab, the changes from a
commit, one commit, a range of commits, the file at a commit, a rejected to commit, a
root commit, file counts with `diff.renames` and `log.showRoot` off, the list and
output limits, a shallow clone, unknown commits, and a rebase. Merge base fixtures cover a feature branch, a subfolder session, `origin/HEAD`
of a clone, local commits on `main` of a clone, `main` without local commits, a base
request after the base is gone, and branches without a common commit. Folder list fixtures cover the entry order, ignore marks, a nested repository, `.git`, symlinks inside and outside
the workspace, missing folders, the entry limit, a folder outside Git, a missing Git
executable, and a failed ignore check. A WebSocket fixture sends `workspace-file` and
`workspace-folders` through the server. Web fixtures cover the file list, the filter,
the tree rows and their notes and marks, the folders of a refresh, the language choice,
the layout width rule, and late replies. They also cover replies for a folder that
closed or opened again, a refresh at the shared entry limit, a folder that is gone, a
failed request for one folder, the unread folders of a failed refresh, and a failed
first read of the workspace folder. Scope fixtures cover the requests and the labels
of each scope, ranges in either order, and the steps of `[` and `]`. Pane fixtures
cover the requests after a file reply without the selected commit, a failed list read
after it, a late file reply after a new choice, two dots, a cancel with the same dot, a
range of every row, the focus after a row, the keys, a base that is gone, and the
notice of omitted commits with an empty list. Image fixtures cover PNG, JPEG, GIF, and
WebP sides from Git and from the workspace, a format change, an image above 1 MiB, an
image and other binary data above the limits, text with an image extension or an image
signature, text above 1 MiB with an image signature, and an SVG symlink. A change list
fixture counts an untracked image above 1 MiB as binary. It also counts text above 1 MiB
with an image signature as text, also when the read of its first bytes cuts a character. A WebSocket fixture sends two 5 MiB image sides in one
reply. Web fixtures cover the image URLs, SVG text in a URL, the shown sides and their
text or notes, a rename from an SVG path, Git LFS pointer text in an SVG path, the
captions, and the size text. SVG root fixtures cover a prefixed root, the prolog
parts, an `svg` element in a comment before another root, and a root without the SVG
namespace. Pane fixtures cover an image diff in both layouts, **View source** with an
SVG file and next to a PNG file or a binary side, and a rename from an SVG path. Markdown fixtures cover raw HTML, script links,
relative and allowed links, images, tables, task lists, escaped task markers, syntax
colors and escaped text in fenced code, and the files that Preview accepts.

A browser check used a temporary instance, a fixture repository, and a shell session in
a managed worktree. It checked Split, Unified, folded regions, View file, deleted files,
symlinks, binary files, both baselines, a non-Git General session, and an ended
session. It also checked two tabs with separate selections, a phone width without
horizontal scroll, and an empty browser console. Script text in a file showed as text.

A browser check of Preview used a demo instance with a synthetic Markdown file. It
checked an added file in Changes and an unchanged file in Files. It checked headings,
a table, task lists, a code block, raw HTML and script links as text, an image
placeholder, and an allowed and a relative link. It also checked that a deleted file
and a Go file show no Preview button. It checked Esc, ✕, light and dark Appearance, a
phone width without horizontal scroll, and an empty browser console.
A later check of Preview covered fenced code with Go, shell, and no language, in light
and dark Appearance. It also checked the syntax colors of a Go diff and a Markdown file
view, a phone width without horizontal scroll, and an empty browser console. A headless
Chrome check with emulated forced colors showed separate checked and open task boxes.
Code in a level 4 heading kept its case.

A browser check of the image view used a demo instance with a modified PNG file and a
modified SVG file that has only a `viewBox`. It also used an added PNG file of 1.8 MiB
and an added SVG file with a script, an `onload` attribute, and an external image. It
checked Split, Unified, the captions, **View source** and **View image**, the Files
view, fit and actual size with scroll bars, and light and dark Appearance. The script
and `onload` did not run, and the browser sent no request for the external image. It
also checked a phone width without horizontal scroll and an empty browser console.

A browser check of the Files tree used a temporary instance, a fixture repository, and
a folder outside Git, each with a shell session. It checked open and closed folders,
ignored entries, status letters, folder dots, a symlink, a binary file, the file view
and the diff of a changed file, the filter list with a deleted file, and a refresh
after a folder was removed. It also checked the folder outside Git, an ended session, a
phone width without horizontal scroll, and an empty browser console. A later check
opened a folder with Enter and moved to its first entry with Tab. It also refreshed the
tree with an open folder of 20,000 files, and each open folder kept its entries.
A simulated connection failure of the request for one folder kept that folder open
with its entries and showed the error. With a folder that opened just before the
refresh, the pane still read that folder after the failure. It also read that folder
after a failure of the refresh request.
A simulated failure of the first read of the workspace folder showed the failed note
and the error. A slow refresh then showed "Reading…", and the tree came back.

A side terminal fixture uses a live server and `/bin/sh`. It checks the workspace and
`BBFLOW_SESSION` of the shell, and that two views share one shell. It checks that the
shell continues after its views close and after Stop session. It also checks
`side-terminal-stop`, a shell that exits, archive, and refusal for drafts, archived
sessions, and unknown sessions. It checks that a resume or stop with the ID of an ended
shell does not join or stop a later shell. It checks that SQLite has no side terminal
events and that the session gets no status messages or view count from them. Web
fixtures check that a lost side terminal rejoins with `side-terminal-resume` and the ID
of its shell, and never starts another shell.

A browser check of the side terminal used a temporary instance and a shell session. It
checked commands in the session workspace, hide and reopen with the same shell, the fit
to a larger window, Stop shell with its exit code, and **Start shell**. It also checked
that a return to the session joins without a start. A query found no side terminal
output in SQLite. A later check of the workspace pane checked the three icons, a separate selected file
in each view, **View diff** from Files, the Changes header only in Changes, a folder
outside Git, and an empty browser console. It also checked that a hidden terminal stays
connected and keeps its size.

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

Web fixtures cover settings comparison, edits that preserve fields changed by another
view, and repeated add requests. Protocol fixtures verify that a server error reply is
marked apart from a transport failure.

CLI fixtures run `bbflow tool` and `bbflow settings` against a temporary server. They
verify that a repeated `tool add` updates the same tool, that removal of the default tool
selects Shell, and that duplicate names stop `add` and `remove`. They verify that a tool
named `shell` can be the default tool, and that only an empty value selects the
built-in Shell. They verify that
server validation errors change nothing, and that a change applies again after a
revision conflict.

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

Menu fixtures cover repeated start, restart, server crashes, shutdown
with an active session, and protection against stopping a replacement instance. A manual
macOS check confirmed Open UI and Quit bbflow from the standalone executable. The shared
logo was checked in light and dark browser themes. The generated menu bar PNG was
checked to contain only fully transparent or fully opaque pixels. A manual check
confirmed the icon in the dark macOS menu bar. The updated native companion also launched and exited with its server.

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

Frozen schemas from repository history test upgrades from formats 3–13 to format 14 and
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

Release check fixtures use a fake curl, a synthetic release, and this test binary as
bbflow 0.0.1 and 0.0.2. They verify that a server start offers the release without a
download, and that `update-start` installs it and starts a new server. They verify a
restart without a download when the executable already has the release, the reason of
a failed download, and an unchanged server after it. A server stop during a hanging
check ends at once and leaves no temporary files. An in-process server fixture with a
fake release source verifies a single check across setting changes, the offer in the
status watch, rejected versions, a second update, and a failed restart. It also verifies
that an off setting during a slow check hides the result and rejects its start. A
newer save can reply first, and an earlier save does not then apply. A stale offer
starts a check at once. A release fixture changes the executable back to 0.0.1 after a
restart offer: the confirmed restart downloads nothing, and the server offers the
download. A second confirmation of the restart then fails. A check of the same release
and action keeps the revision. Web fixtures verify the sidebar labels, the dialog text, and the session
warning. A fake DOM fixture verifies that the open dialog counts the live sessions of
the latest status message and shows the titles of the current list. It also verifies
that a new offer closes the dialog, that the view confirms the revision of the shown
offer, and that a lost status watch hides the offer. A lost watch during a pending start
that then fails allows no other attempt. A failed start without a change allows one. A failed settings
update in migration 12 rolls back and keeps format 11.

Family fixtures verify family order by the latest member, paging by family, an included
sub-session that brings its family, search context, and context parents in Archived.
They verify family archive and restore, live members that block an archive, and the
rules of a sub-session draft. Server fixtures create sub-session drafts with a Git repository. They
verify the base from the parent branch, a start in the parent worktree, a new worktree
from the parent commit, and the rejection of a parent draft workspace. A failed index
creation in migration 13 rolls back and keeps the earlier format. Web fixtures verify
the families of the list, context families, the place labels, and the merge of pages
without a repeated family. A browser check of a demo instance with the Demo agent
verified a start in the parent workspace, the family archive dialog, the welcome view after the archive of a selected sub-session,
restore of the family, and search context. No real agent CLI was used. Web fixtures also
verify the status icons and texts and the first 5 sub-sessions of a family. Family
fixtures verify a rejected archive when the confirmed sub-sessions differ. Server fixtures verify the base from a parent worktree
after a branch switch and on a detached commit, and the rejection of a parent workspace
before the first terminal of the parent.

Title fixtures verify the separate user and derived titles, search on both, and the
title tool values. A failed settings update in migration 10 rolls back the new column
and keeps format 9. Synthetic title commands verify standard input, path masking, the
temporary folder, the marker rule, failures, cancel, and a missing CLI. Send fixtures
verify that only the input receipt of the first send with text runs the command, with
the text of that send. An autosave, a send without a receipt, a receipt for another
revision or for other bytes, an emptied draft after a failed send, and later sends do
not run it. A session without a derived title, as after an upgrade, starts no request
after the user clears its title. Byte fixtures reject text inside another submission, text only in an
attachment path, a missing attachment, and a missing final Enter. They accept valid
sends with attachments and with several lines. A fixture turns titles on between two
accepted sends, and the second send runs no request. A fixture reopens the archive after a request with a lost receipt, and a
second send then runs no second request. Live checks used
Claude Code 2.1.312, Codex CLI 0.160.0, and Code Puppy 0.0.969 with synthetic messages.
A message that named a local canary file did not give its content to the hardened
Claude and Codex commands.

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
read-only files, and rebuilds without leftover staging folders. Request fixtures reject
live terminals, old run IDs, running records, archived sessions, removed worktrees,
missing workspaces, and unknown tools. A rejected request writes no handoff folder.
A startup command can contain literal `{prompt}` text.

A temporary server test starts a worktree session with a synthetic tool and sends one
editor message. It stops the session and continues it with the same tool. It verifies
the startup command, absence of automatic handoff input, the worktree path, the handoff
files, and the rejection of a second continue request. After a server restart, it
continues with Shell. The README lists both earlier terminals, newest first.

A browser check with the demo instance verified that tool fields do not save on blur.
**Add tool** and **Save** saved the requested changes. **Cancel** discarded an edit.
A rejected command stayed in the editor, and a session default saved during the edit.
After a reload, the tool and the default showed their saved values. A move changed the
tool order. A new terminal started the Demo agent. **Put in message editor** inserted
the handoff prompt, and **Send** delivered it to the simulated agent.

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
new terminal** then started a fourth terminal. No browser errors were reported.
No real agent CLI was used.

`codex sandbox` from Codex CLI 0.160.0, with default settings, read the handoff
`README.md` from outside its working directory. In the same sandbox, `bbflow query`
failed with "connect: operation not permitted". These checks ran no model.

Earlier live checks verified that Codex CLI 0.160.0 and Claude Code 2.1.312 could read
the handoff files. See the [v0.0.5 release notes](releases/0.0.5.md#validation) for the
agent versions, permission modes, and results.

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

A web fixture covers the send shortcut of the message editor. A live check of the
simplified layout used a demo instance and headless Chrome. A live view had no hint and
no row above the terminal. Its toolbar line showed the tool before the workspace path.
A Shell session that continued with the demo agent showed **Shell** for terminal 1 and
the demo agent for terminal 2. Command-Enter sent the saved draft, and the terminal printed the
reply of the demo agent. An earlier terminal showed the selector, the hint, and
**Back to live terminal**. An ended session showed **Continue in new terminal** in the
toolbar. The home page, a draft, Settings, and two dialogs also showed correctly. With the Files pane open in a window 1,152 pixels wide, the
action row of the message editor wrapped, and **Send** stayed inside the editor. A
dropped `session-terminals` request left the toolbar line without a tool. During a
continue with another tool, a delayed list left the line without a tool until the new
list arrived. Then the line showed the new tool. After
Command-Enter, the keyboard focus was in the editor again. The check did not use a
pointer, so tooltip display on hover is not verified.

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

bbflow stops the launched group and a shell's foreground job. It does not track other
background groups. Linux runtime behavior and large archives are unverified.

A session has at most one live session terminal, and at most one live side terminal.
The side terminal keeps its screen only in server memory. Its output is lost when it
ends, and no history can read it. The UI shows an earlier terminal only as its
saved final screen, one terminal at a time. It cannot show two terminals side by side.
The terminal list reads every start event of the session, so a long session makes the
list slower to load.

Search history can read matching output and bounded context from earlier terminals.
Their saved transcripts remain available in the handoff folder, and `bbflow query` reads
their original events.

A handoff transcript has at most the newest 10,000 scrollback rows of a terminal.
The server rebuilds the handoff folder while it holds the launch lock. A large interrupted
recording can delay other launches during this rebuild. A transcript keeps
only the last screen of a program that uses the alternate screen, such as Codex CLI
0.160.0 without `--no-alt-screen`.

The prompt gives the new agent a record of earlier work. It does not restore the
internal state of the earlier agent.

The Changes pane reads files only when it opens, on Refresh, and on window focus. It
shows one file at a time. A diff that ends at a commit has no untracked files, and
Files always shows the current files. Its commit list has at most 30 commits since the
base, and it omits the last commit of a shallow clone, whose parent is not available.
**All changes** needs a base. A session without `origin/HEAD` and `main`, and a session
whose `HEAD` has no commit that the default branch does not have, have none. The **Uncommitted changes** row has no file count. Other image formats, such as AVIF, HEIC, TIFF, BMP, and ICO, show as binary files. In a Git LFS repository, Git gives the LFS pointer text for a committed side. Then the diff shows that text in place of the old image. It cannot show changes in a folder that is
not a Git repository. The filter of **Files** needs a Git repository, and it does not
find ignored files. The tree has no arrow key navigation. Use Tab and Enter. Git detects a rename only
between tracked files with similar content. An untracked new file and its deleted
original show as two changes.

Each session has one shared draft. Other views update after each save, about half a
second after typing stops. They do not show each keystroke. When two views edit at the
same time, the latest save wins. The earlier text then stays only in archived draft
revisions. The draft does not merge edits from two views.
