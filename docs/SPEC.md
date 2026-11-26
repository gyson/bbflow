# bbflow — Current Specification

bbflow has a separate background server and a browser workspace. The CLI opens the UI,
manages the server, edits settings, runs read-only SQL queries, prints a storage report,
and updates the installed executable.
See [GOAL.md](GOAL.md) for continuation, imports, and richer workspace goals.

## Contents

Each section starts with a summary. The sub-sections after the summary give the exact
rules. A "Limits" sub-section gives the limits of one feature.

| Section | Contents |
| --- | --- |
| [Architecture and build](#architecture-and-build) | The server, its clients, the dependencies, and the build. |
| [Commands](#commands) | The scope of the CLI. COMMANDS.md has the reference. |
| [Release installation](#release-installation) | The installer, `bbflow update`, the release check, and the update from the web UI. |
| [Server lifecycle](#server-lifecycle) | Start, stop, and restart, the loopback address and port, remote access, and the macOS menu bar. |
| [Web client](#web-client) | Each feature of the web UI. See the second table. |
| [Terminal runtime](#terminal-runtime) | Launch, recording, signals, exit, and scrollback of a terminal. |
| [Session views](#session-views) | Shared views, the size owner, frames, and the order of the session list. |
| [Concurrency and recovery](#concurrency-and-recovery) | Shared workspaces, SQLite access, and recovery after a crash. |
| [History and storage](#history-and-storage) | The archive, database upgrades, read-only SQL, the storage report, and data handling. |
| [Limitations](#limitations) | The limits that apply to bbflow as a whole. |
| [Validation](#validation) | The checks of each feature, in the order of the feature sections. |

The Web client section has these features:

| Feature | Contents |
| --- | --- |
| [Page and connection](#page-and-connection) | The page URL, the server check, the favicon, and the home screen icon. |
| [Page messages](#page-messages) | The place of each warning and error. |
| [Mobile layout](#mobile-layout) | The layout of a very narrow window: the sidebar drawer, the short toolbar, the message editor, the file list, and the on-screen keyboard. |
| [Sidebar](#sidebar) | Projects, session groups, width, search, refresh, and stops from the row menu. |
| [Session families](#session-families) | Sub-sessions and their parent. |
| [Pinned sessions](#pinned-sessions) | The Pinned group at the top of the sidebar, and the pin rules. |
| [Archive](#archive) | Archive and restore of drafts and ended sessions. |
| [Projects and launches](#projects-and-launches) | Projects, the project menu, Start session, the shell, the terminal view, and reconnection. |
| [Session preparation, settings, and worktrees](#session-preparation-settings-and-worktrees) | The Settings page, built-in tools, tool types and model lists, the launch preparation of a session, and managed worktrees. |
| [Usage limits](#usage-limits) | The Usage dialog, the check of each agent CLI, and the cache of the server. |
| [Session status](#session-status) | The four statuses, the sidebar icon, the session toolbar, and the More actions menu. |
| [Session titles](#session-titles) | User titles, derived titles, and the title tools. |
| [Message editor](#message-editor) | Send, the ＋ menu, saved prompts, the shared draft, sent messages, and attachments. |
| [Sent messages in the terminal](#sent-messages-in-the-terminal) | The positions of the sent messages in the terminal: the message bar, the marks, the steps, and the jump to another terminal. |
| [Continue in a new terminal](#continue-in-a-new-terminal) | A new terminal in an ended session, with the handoff folder and prompt. |
| [Earlier terminals](#earlier-terminals) | The terminal selector and the read-only view of an earlier terminal. |
| [History search](#history-search) | Search of the recorded terminal output. |
| [Workspace pane](#workspace-pane) | The pane that shows Messages, Changes, Files, or Terminal. |
| [Changes pane](#changes-pane) | The Changes and Files views, images, the Markdown preview, and the file menu. |
| [Side terminal](#side-terminal) | An ad hoc shell in the session workspace, without a recording. |

## Architecture and build

bbflow is one self-contained Go executable. A detached server owns the pseudo-terminals
(PTYs) and SQLite. The browser UI and the CLI are clients of that server. The
executable embeds the web UI, so the deployed binary needs no other files.

### Server and clients

- A detached Go server owns pseudo-terminals (PTYs) and SQLite.
- Clients use JSON text messages over WebSocket at `/ws`, on an HTTP server bound to
  loopback. The Go transport uses `github.com/gorilla/websocket`. Byte blobs use base64
  encoding.
- The CLI and browser clients share the same protocol. See [PROTOCOL.md](PROTOCOL.md).
- Every new session starts an interactive shell with `-i`, using the server environment.
  The server resolves `$SHELL` from PATH or an absolute path, falling back to `/bin/sh`
  when unset. Workspaces accept absolute paths, `~`, and `~/path`.
- The server uses the pinned pure-Go `github.com/eugenioenko/xterm-go` headless
  emulator. It owns terminal screens independently of client connections.
- This fork of `github.com/gitpod-io/xterm-go` fixes a panic when a narrower size
  reflows more rows than the scrollback holds (gitpod-io/xterm-go issue 61). The reflow
  drops the oldest rows.
- On macOS, `github.com/gogpu/systray` v0.3.0 implements a menu bar companion. It uses
  Go FFI to load the built-in AppKit frameworks, without CGO.
- The server launches the same executable as a separate menu process. It needs no
  `.app` bundle or additional executable. Other platforms do not load native menu code.

### Go core

- Go 1.27.3+ core with `github.com/creack/pty`, `golang.org/x/sys`, and
  `golang.org/x/term`.
- `bbflow update` uses `golang.org/x/term` to find out if standard input is a terminal
  for its question. Synthetic test agents also use it.
- SQLite through the pure Go `github.com/ncruces/go-sqlite3` driver. No CGO in
  deployment builds.

### Frontend build

- Frontend sources are under `web/`, with strict TypeScript and CSS under `web/src`.
  Source builds require Node.js 22+ and npm. The TypeScript compiler checks types.
- esbuild bundles the application and its npm dependencies into one ES2022 JavaScript
  file and one CSS file. The dependencies are xterm.js 6.0.0, CodeMirror 6 with
  `@codemirror/merge` 6.12.3, a fixed set of language modes, and markdown-it 15.0.3.
- The build also includes HTML and the licenses of every bundled npm package, which it
  reads from the esbuild metafile.
- The JavaScript file is about 1.2 MB. CodeMirror adds about 290 KB, its language modes
  about 400 KB, and markdown-it about 100 KB.
- Generated assets are in `internal/webui/dist`, which Go embeds. Git ignores this
  directory, test compiler output in `web/dist`, and npm dependencies.
- The deployed binary needs neither Node.js nor external frontend files.

### Licenses

- The build collects bbflow's license, the Go license, npm runtime licenses, and
  license/notice files from the Go modules required by `go.mod`.
- It includes the Apache-2.0 text referenced by goffi's attribution notice.
- These are embedded at `/assets/licenses.txt`, so the installed standalone executable
  retains them.

### Developer tools

- `cmd/bbflow-demo` is a developer tool for the demo-instance project skill. It adds
  simulated data to a new instance through the same Go client and protocol types as the
  CLI, and removes that instance. Releases do not include it.
- [DEVELOPMENT.md](DEVELOPMENT.md) gives the build, check, and release commands.

### Storage and history package

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

The CLI opens the UI, manages the server, edits tools and settings, runs read-only SQL
queries, prints a storage report and the agent guide, and updates the executable. It
has no session operations, terminal attachment, or `history` command group.
[COMMANDS.md](COMMANDS.md) is the reference for each command, its options, its output,
and its effects.

`bbflow skill` prints `cmd/bbflow/skill.md`, which the executable embeds. Fixtures
compare its tables and columns with the migrated schema. They also run each example
through a shell against a test server.

## Release installation

GitHub Releases provide versioned macOS archives, checksums, and `install.sh`. One
POSIX shell installer does the first installation and each `bbflow update`. The server
of a release build also checks for a newer release, and the web UI can start the
update.

### Installer

Each archive contains `bbflow`, `LICENSE`, and `THIRD_PARTY_NOTICES.txt`. The installer
extracts only the executable. That binary also embeds all notices. The installer uses
curl and macOS plutil, with no GitHub CLI dependency. Downloads need no credentials.

An optional `GITHUB_TOKEN` environment variable authenticates GitHub API requests. The
installer passes the token to curl through stdin. It does not put the token in process
arguments or a file.

#### Version and location

The POSIX shell installer supports macOS `arm64` and `x86_64`. It resolves the latest
published full release once, then downloads the architecture archive and checksum file
from that fixed tag. `--version X.Y.Z` selects a specific release. Other version formats
are rejected. It installs into `~/.local/bin` by default.

`BBFLOW_INSTALL_DIR` overrides this default. Installer `--dir` overrides both. Each
override must be an absolute path.

#### Replacement rules

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

#### Release workflow

The tag-triggered Release workflow tests Apple Silicon and Intel macOS runners before
publishing assets. Release notes are stored in `docs/releases/`. Linux and Windows
packages, Homebrew packaging, and Apple Developer ID signing/notarization are absent.
The installer and release smoke checks use temporary directories. Installer fixtures use
synthetic binaries and GitHub API responses. They do not access real credentials.

### Update

`bbflow update` installs the latest release over the invoked executable. When a server
of the selected instance runs, the command asks first, and then restarts that server.
The restart stops all live sessions. See [COMMANDS.md](COMMANDS.md#update-bbflow) for
its usage, prompt, and options.

#### Installer and version check

`bbflow update` runs the embedded copy of `internal/install/install.sh` with the invoked
executable's directory. It uses the same curl download, verification, and atomic
replacement as initial installation. It never downloads or executes a remote installer
script. Unsupported platforms and development builds are rejected. Failed downloads or
verification preserve the installed executable.

The command first runs the installer with `--check` and reads the installed and
available versions. If the installed executable is current or newer, the command stops.
It does not contact the server, ask a question, or change files.

#### Server states

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

#### Lock of the executable

After the question, the command locks the directory of the executable with `flock`. The
lock creates no file. Updates that share the executable run one at a time, even for
different instance directories. A second update waits and says so. Under the lock, the
command runs the executable with `--version` again. If the version is no longer the
version from the check, another command changed the executable. Then the command stops
with an error and changes nothing.

The command passes its open directory to the updater as file 3. The lock belongs to that
open directory, so it continues until both processes close it. The updater holds it
until it ends, even when the command ends early, for example after Ctrl+C or when its
terminal closes. The updater marks file 3 close-on-exec at once, so the new server, its
menu companion, and its sessions never inherit the lock. An updater without that file
stops with an error.

#### Hints and environment

Hints and recovery commands always name the selected instance, for example
`bbflow --dir '/path/to/instance' server start`. The directory is quoted for a POSIX
shell. A hint without `--dir` could select the default instance and stop its sessions.

The updater environment does not contain `GITHUB_TOKEN`. The new server passes its
environment to each session, and the token is only for release requests. All other
variables of the update command reach the new server, as with `server restart`.

#### Steps after the question

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

#### Failures

If another server runs at step 4, the updater does not stop it and reports an error.
If the start fails at step 5, the new executable stays in place and no server runs.
Then `bbflow server start` is the recovery. Other instances that use the same
executable continue on the previous version until they restart.

#### Interface between versions

The updater is a newer version than the command that starts it. The environment
variables `BBFLOW_UPDATE_CHILD` and `BBFLOW_UPDATE_INSTANCE`, and the locked directory
as file 3, are the interface between the two versions. Keep their names and meaning
stable.

The web UI can start the same update after a release check. See
[Update from the web UI](#update-from-the-web-ui). There is no automatic update.

### Release check

The server of a release build on macOS checks for a newer release by itself, at start
and then once a day. **Check now** in Settings starts a check at once. The server offers
a newer version to the web UI. A setting turns off the daily check.

#### Schedule and setting

- Development builds, other platforms, and a renamed executable do not check. For a
  renamed executable, `server.log` tells why.
- A check runs the embedded installer with `--check`, as `bbflow update` does. The
  check downloads no binaries.
- While the **Check for a new version every day** setting is on, the first check runs
  when the server starts. The next check runs 24 hours after the previous check. Each
  server start checks again.
- `update-check` starts a check at once, also while the setting is off. **Check now**
  sends it. A running check answers the request. The next daily check runs 24 hours
  after it.
- The result stays only in server memory.
- A settings save applies at once, even while a check runs.
- While the setting is off, the server sends no request by itself. The result of the
  last check stays, and a view can start its update.
- When the setting changes to on after a check is due, the check runs at once.
- A check that ends during an update applies only if the update fails, because the
  server then continues. Until then, the views show the update in progress and the
  earlier check. The checks then apply in order. Thus a failed check keeps the offer
  of a successful check before it.
- The reason of a failed update stays with the release of that update until the next
  update starts. A check that changes the offer or removes it keeps the reason.
- A failed check keeps the offer of the last successful check. It writes its reason to
  `server.log`. The status watch sends the reason, and the **Updates** card shows it.
  The reason is the last message of the installer, as for a failed update.

#### Offered version

The check compares the running version, the version of the executable on disk, and the
latest release. Another instance can install a release into the same executable. Then
this server runs an earlier version than the executable. The server takes the newer of
the latest release and the executable on disk. It offers that version when it is newer
than the running version. When the executable on disk has that version, the offer only
restarts the server.

#### Process group

The installer of a check or a server update runs in its own process group. Server
shutdown stops that group and its curl requests at once. The installer then removes its
temporary files. The update command keeps the installer in the process group of its
terminal, so Ctrl+C in that terminal stops the installer.

### Update from the web UI

The **Updates** card of Settings shows the release check state of the server. A dot on
**Settings** in the sidebar tells of a newer version or a failed update. **Update…**, or
**Restart…** for an installed version, opens a confirmation dialog. After confirmation, the server installs the release and restarts itself. The
restart stops all live sessions.

#### Updates card

The [status watch](PROTOCOL.md#release-check-state) sends the release check state to
every view. The **Updates** card shows it:

- The running version, for example **bbflow 0.0.14**.
- A status line. It is one of these:

  | State | Status line |
  | --- | --- |
  | Build that cannot check | **This build cannot check for a new version.** It also says that only a release build on macOS can check and update. |
  | No check since the server started | **No check since the server started.** |
  | Check running, no offer | **Checking for a new version…** |
  | No newer version | **This is the newest version.** and the time of the last check. |
  | Offer of a download | **bbflow 0.0.15 is available.** and the time of the last check. |
  | Offer of a restart | **bbflow 0.0.15 is installed. A restart starts it.** and the time of the last check. |
  | Update in progress | **Updating to 0.0.15…** |

- The reason of a failed check, with its time, and the reason of a failed update.
- **Update…**, or **Restart…** for an offer that only restarts the server. The button
  opens the dialog. It shows only for an offer that can start.
- **Check now**. It shows **Checking…** and is off while a check runs. It is also off
  during an update. A build that cannot check does not show it.
- **Release notes ↗** for an offer. The link opens the release on GitHub.
- The **Check for a new version every day** setting. See
  [Updates setting](#updates-setting).

The time of the last check names the day for a check on an earlier day. A failed
`update-check` request shows **Could not check:** and the reason. A later check removes
it.

#### Dot on Settings

- The **Settings** button of the sidebar shows a dot for an offer that can start, and
  for a failed update. The dot is red for a failed update, also without an offer.
- The tooltip and the accessible name of the button name the failed update, if there is
  one. Otherwise they name the offer.
- A click on **Settings** with the dot opens Settings at the **Updates** card.
- An update in progress shows in the page bar instead of the dot.

#### Dialog

- The dialog shows the two versions and the steps. It also links to the release notes
  on GitHub. **Cancel** changes nothing.
- The dialog names up to five live sessions that the restart stops and counts the
  others. It takes the live sessions from the same status message as the offer. Their
  titles come from the current session list, even after a rename.
- While the status watch has no connection, the view does not know the release check
  state or the live sessions. Then the card shows **Waiting for the server.**, and the
  dialog closes until the watch sends the state again.
- An update in progress stays in the card.

#### Confirmation

- Each offer has a revision. A check that finds another release or another action
  gives a new revision, and an open dialog then closes.
- A confirmation applies only to the offer that the dialog showed.
- After confirmation, the view saves its message draft and its project draft form. Then
  it sends `update-start` with the version and the revision of that offer.
- The server rejects another version, an earlier revision, and a second update.
- The offer can change, or the status watch can lose its connection, while the drafts
  save. Then the dialog stays open but does not change.
- If the start fails, the dialog shows the error and allows no other attempt. The user
  must open the update again with current data.

#### Server steps

All views then show **Updating to 0.0.15…** in the **Updates** card and in the page
bar. The server does these steps in the background:

1. Lock the directory of the executable, as the update command does. If another update
   holds the lock, stop with an error. Do not wait.
2. Read the version of the executable on disk. If it is the offered version, skip the
   download. The executable can disagree with the confirmed offer: the offer only
   restarts, or the executable has a newer version. Then stop and change nothing. The
   card shows the failure, and the server checks again at once, also while the setting
   is off. The views then show
   the new offer, which the user must confirm again. A late confirmation of the earlier
   offer from another view fails, because its revision is earlier.
3. Download, verify, and install the offered release while the server continues. The
   installer appends its output to `update.log`.
4. Start the new executable as the updater, with the same interface as the update
   command. The updater gets the server environment without `GITHUB_TOKEN`. It stops
   this server and starts the new version in the same directory, as described above.

Open tabs then reconnect to the same port and reload, as after `bbflow update`. A tab
with an edit that was not saved keeps the edit and asks the user to reload.

#### Failures of the server update

A failure before step 4 leaves the server running. A failure before the rename in step
3 also leaves the executable unchanged. The card then shows
**The update to 0.0.15 failed:** and the reason. The dialog of the same release shows
the reason too, and the user can try again.
If the updater ends while the server still runs, the card shows that the restart failed
and names `update.log`. A server that stops during the download stops the installer and
does not start again. If it stops after the rename, the next server start uses the new
executable.

## Server lifecycle

One detached server owns each instance directory. `bbflow server start`, `stop`, and
`restart` control it. An archive lock and a verified connection make sure that a
command never starts a second server or stops another process.

See [COMMANDS.md](COMMANDS.md#start-the-server) for the effects of `server start`,
`server stop`, and `server restart`, and for the selection of the instance directory.
See [PROTOCOL.md](PROTOCOL.md#connections-and-requests) for the greeting and its
verification, and for the shutdown request. See [Transport](PROTOCOL.md#transport) for
the protocol version and the message limits.

### Lifecycle commands

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

#### Lock and verification

Lifecycle commands serialize within an instance directory. An archive lock prevents
multiple servers from owning it. When the lock is free, lifecycle commands can discard
stale `server.json` information. They never use a saved PID or port to stop another
process.

If the lock is held, lifecycle commands require a verified server connection. Missing,
malformed, or mismatched connection information causes an error instead of starting a
duplicate or stopping an unrelated server. A failed stop does not start a replacement.

#### Connection information

The server binds its loopback port and atomically publishes its connection information
in `server.json`, with private permissions. The file is disposable. The server removes
it as the last shutdown step, after handlers, agents, SQLite, and the menu companion
stop, immediately before it releases the archive lock. Until then, a lifecycle command
finds a server that refuses connections and waits for it. A held lock with a missing
`server.json` occurs only while a server starts. Shutdown leaves the file intact if it
belongs to another server instance.

#### HTTP and shutdown

HTTP serves the WebSocket upgrade, the embedded UI, its static files, and the browser
connection information. All session operations and history reads use WebSocket. There
is no separate UI API. See [browser access](PROTOCOL.md#browser-access) for the routes
and the Host and Origin policy.

Shutdown closes HTTP connections and waits for upgraded handlers and agent cleanup
before releasing the archive. An upgraded peer that sends no request can delay shutdown
until its five-second request timeout.

### Loopback address

The server listens only on the loopback addresses `127.0.0.1` and `::1`. Another device
reaches it only through [remote access](#remote-access), which is off by default. The
UI URL uses `localhost`, and a browser can resolve
`localhost` to either address. Thus the server holds its port at both addresses, and no
other program can take the requests for `localhost` while bbflow runs. A system without
IPv6 loopback uses `127.0.0.1` only. The CLI connects to `127.0.0.1`.

### Port selection

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

### Remote access

Remote access lets a browser on another device, such as a phone, use the web UI. A
reverse proxy on the computer of the server forwards the requests to the loopback port.
The supported proxy is [Tailscale Serve](https://tailscale.com/kb/1312/serve). Remote
access is off by default, and the server still listens only on loopback.

See [Remote host](PROTOCOL.md#remote-host) for the exact request checks. See
[Remote access in Settings](#remote-access-in-settings) for the page, and
[COMMANDS.md](COMMANDS.md#manage-settings) for the `remote`, `remote-host`, and
`remote-login` keys.

#### Remote access settings

Settings hold a switch, `remoteOn`, and two values, `remoteHost` and `remoteLogin`.
Remote access is on only while the switch is on and both values are set. The switch and
the values are independent.

| Setting | Rules |
| --- | --- |
| `remoteOn` | The switch of remote access. A new database starts with `false`. |
| `remoteHost` | The Host of the remote requests, such as `my-mac.example.ts.net`. It is a DNS name with at least two labels and an optional port. The server saves it in lower case. The server rejects an IP address and a name that ends in `localhost`. |
| `remoteLogin` | The Tailscale login that can use remote access, such as `user@example.com`. It has at most 254 printable ASCII characters, without spaces. |

- A save of the values never turns the switch on. Only a save of the switch does.
- The switch saves without the values. While the values are incomplete, remote access
  stays off.
- When the switch turns off, the settings keep both values. Thus the switch turns remote
  access on again without a new entry.
- A save of one value alone succeeds.
- An upgrade turns the switch on only when both values are saved, because remote access
  was on there before. See [Formats](#formats).
- A change applies without a server restart. It is in effect before the server
  replies to the save. Thus a request after a successful save gets the new rules.
- A change of the switch or of either value closes each open WebSocket connection of a
  remote request. The connections of local views stay open. Thus a remote view that
  turns the switch off loses its connection, and it cannot turn the switch on again.
- The server applies the saved values in the order of the settings revisions. When two
  saves complete in the other order, the values of the later revision stay.
- A save of another setting keeps the remote connections.

#### Remote requests

A request is local only when its Host is a loopback host name of the server and it has
no header of a reverse proxy, such as `X-Forwarded-Host`. See
[Host and Origin](PROTOCOL.md#host-and-origin) for the headers. Each other request is
remote, and the server answers it only when all of these conditions are true:

- The Host is exactly the saved `remoteHost`.
- The switch is on.
- The request has exactly one `Tailscale-User-Login` header, and its value is the saved
  `remoteLogin`. The comparison ignores letter case.

The server answers each other remote request with status 403. The body names the first
check in the list that failed:

| Failed check | Body |
| --- | --- |
| The Host, or no saved `remoteHost` | `invalid host` |
| The switch | `remote access is off` |
| The login, or no saved `remoteLogin` | `remote access needs the Tailscale login of Settings` |

Thus a request for another host gets `invalid host`, whatever the switch is.

A remote WebSocket upgrade also needs the Origin `https://` with the Host of the same
request. Thus an HTTP page of the same host cannot connect. The content security policy
of a remote page also takes its WebSocket origin from the Host of its request. A change
of the settings during a request thus cannot admit the origin of another host.

Tailscale Serve selects its backend by the TLS server name, and it keeps the Host that
the client sent. A client in the tailnet can thus send a loopback Host through the
proxy. Tailscale Serve sets `X-Forwarded-Host` on each request that it forwards, so the
server does not handle such a request as local. This applies also while remote access
is off.

Tailscale Serve removes each `Tailscale-User-Login` header that the client sent, and it
sets its own header for a user device of the tailnet. A request that comes through the
HTTP proxy of Tailscale Funnel from the internet has no login, so the server rejects
it.

A remote page uses the same UI and the same operations as a local page. On an HTTPS
page, the UI connects with `wss://`. The content security policy of a remote page names
the secure WebSocket origin of the remote host instead of the loopback addresses.

#### Setup with Tailscale Serve

bbflow does not start, change, or stop Tailscale Serve. The user runs
`tailscale serve` for the port of the server. See [REMOTE.md](REMOTE.md) for the setup
procedure, the Tailscale commands, and the solutions to problems.

#### Limits

- Remote access admits one host name and one Tailscale login.
- The server has no password and no TLS of its own. Tailscale supplies the encryption
  and the user identity.
- Each device where that Tailscale user is signed in can run commands as the user of
  the server. A lost device needs removal from the tailnet.
- The checks do not authenticate local programs. A local program can send the same Host
  and header to the loopback port. Such a program can already use the loopback host.
- A device with a Tailscale tag has no login, so the server rejects its requests.
- A login with characters outside printable ASCII cannot be saved.
- **Open in browser** and **Show in Finder** act on the computer of the server, not on
  the remote device.
- A remote view can become the [size owner](#size-owner), as each view can. A typed key
  or a message from a phone gives the PTY the size of the phone view.
- `bbflow ui`, the menu bar, and the server start message use the `localhost` URL only.
- The web UI loads its files and its WebSocket connection from the root of the host.
  Thus it does not work below a path of the proxy.
- Another application at a path of the same HTTPS host and port has the browser origin
  of bbflow. Its scripts can use bbflow as the signed-in user. The remote host needs an
  HTTPS port that serves only bbflow.
- Tailscale Serve forwards to a port number. When the server
  [selects another port](#port-selection), the address reaches the program that holds
  the earlier port.
- A reverse proxy that sets none of the proxy headers makes its requests with a loopback
  Host local. The HTTP proxy of Tailscale Serve sets them.
- A TCP forwarder, such as `tailscale serve --tcp` or `tailscale funnel` with
  `--tls-terminated-tcp`, adds no headers. The server cannot tell its requests from
  local requests, also while remote access is off. The remote access settings give no
  protection for a port that such a forwarder exposes.
- The checks with a real Tailscale Serve proxy used one Mac with Tailscale 1.104.7 and
  one iPhone. No check used a real Funnel request, a device with a tag, or another
  reverse proxy. No check of the switch used a real Tailscale Serve proxy. See
  [Checks of the server and the menu bar](#checks-of-the-server-and-the-menu-bar).

### macOS menu bar

On macOS, each server has a menu bar icon. Its menu has **Open UI** and **Quit
bbflow**. A separate companion process shows the menu, so a menu failure does not stop
the server or its sessions.

#### Companion start

Each new server launches a menu companion on macOS. No command option turns it off.
Builds that set the link-time variable `main.menuBar` to `off` launch no companion.
Only automated tests use that setting. A repeated start keeps the existing server and
its menu. Restart replaces both processes.

#### Menu items and labels

The menu contains **Open UI**, a separator, and **Quit bbflow**. The Quit bbflow label
shows the running version, such as **Quit bbflow (0.0.5)** or **Quit bbflow (dev)**.
Preview builds can set a version label at build time, such as **Quit bbflow (0.0.5
dev-1af9)**. Open UI calls the same verified home-page opener as the CLI.

For an instance directory that is not the default of the build, the label shows an
instance tag in place of the version, such as **Quit bbflow (demo-1a2b3)**. The tag is
the folder name without a leading `.` and `bbflow-`, then the first 5 hexadecimal digits
of the SHA-256 hash of the canonical path. Thus folders with the same name in different
checkouts get different tags. The tooltip of the icon also shows the tag.

#### Icon

The build renders the menu icon from `web/src/bbflow.svg` and embeds it in the
executable. The icon shows the letters "bb" on a 16-unit pixel grid and uses macOS
template coloring, so it ignores the logo colors. The 44-pixel PNG has a 3-unit margin
around the grid, so macOS shows a 16-point mark with sharp edges in the 22-point status
item.

#### Quit

Quit retains the connection information verified when the companion starts. It
reconnects to that endpoint and verifies the original server identity on the shutdown
connection, without rereading `server.json`. It requests graceful shutdown and waits for
the server's lifetime pipe to close. Missing or replaced connection files do not prevent
Quit. A replacement instance, including one reusing the original port, cannot be stopped
by an old menu.

bbflow accepts one menu action at a time. During shutdown, the menu shows
**Quitting bbflow…**. If an action fails, the menu shows a retry label and writes
diagnostics to the server log. Actions run outside the native UI thread.

#### Companion process

The server owns an inherited pipe to its menu. On normal shutdown it finishes session
cleanup and closes SQLite, closes the pipe, waits for the companion, then releases the
archive lock. A companion that does not exit within three seconds is killed through its
original process handle. Server crashes also close the pipe and remove the icon. This
does not prove that agent processes from the crashed server stopped.

The companion verifies its parent before entering the AppKit event loop. It requires a
logged-in macOS desktop. A failed or killed companion does not stop the server or its
sessions.

#### Limits

- The server does not automatically relaunch the companion. To restore it, restart the
  server.
- There are no native notifications, login items, settings, or global shortcuts.
- No protocol or storage format change was needed.

## Web client

The web UI is one page in a browser tab. A sidebar lists the projects and their
sessions. The main area shows one session: its terminal, its message editor, and an
optional workspace pane. Each tab has its own selected session, and tabs can share a
session. A window of 700 pixels or less uses the [mobile layout](#mobile-layout).

### Page and connection

The UI renders titles, errors, and recorded output as text. It never treats them as
HTML. Each tab has its own selected session. Tabs can share a session. Every tab can
type and send messages. The PTY uses the size of the tab that most recently did so. See
[Size owner](#size-owner).

The browser favicon uses the same pixel logo as the macOS menu bar, in six rainbow
bands from violet to red. The logo selects brighter band colors when the browser uses
dark appearance. iOS ignores SVG icons for a web app on the home screen. For it, the
page links `/assets/apple-touch-icon.png`. The build renders this 180-pixel PNG from the
same logo with a 2-unit margin. It has an opaque mid-gray tile, so that it stays visible
on light and dark wallpapers. It uses the brighter band colors of dark appearance. iOS
saves the icon when the user adds the page, so an earlier home screen icon stays until
the user adds the page again. The visible product name is bbflow. The sidebar shows it
as text at the top left, without the logo.

Server start and repeated start print a clickable `http://localhost:PORT/` URL without
opening a browser. `bbflow ui` and the **Open UI** menu item open the home page of the
verified server at the same URL. See
[COMMANDS.md](COMMANDS.md#open-the-web-ui).

The UI checks every WebSocket greeting against `/client-config`. A changed server
requires a reload using its current URL. A content security policy restricts scripts
and network access to the origin of the page and blocks framing. Terminal libraries are
served locally. See [browser access](PROTOCOL.md#browser-access) for the Host, Origin,
and caching rules.

### Page messages

The page has no general message banner. Each message shows next to the item that it is
about:

- A start warning from the server, such as a base fetch that failed, shows as
  **⚠ Start warning** at the end of the workspace line. Its tooltip gives the text. A
  click also shows the text. The page keeps the warning of each session until the page
  reloads. bbflow does not record it.
- A lost connection, an end with an error, and a stop without effect show in the hint
  below the terminal. An error hint is red. **Reconnect** shows next to the hint. A
  screen reader announces these hints from a status region, because the focus can stay
  in the terminal.
- When the session changes while the Continue dialog is open, the dialog stays open. It
  tells why it cannot start a terminal and disables its start button. When continuation
  is available again for the same latest run, the reason goes and the button comes back.
  After a server restart, the dialog shows the restart message in place of the reason,
  and the button stays off until the page reloads.
- A handoff folder that is not available shows in the status line of the message editor.
- A failed list refresh shows above the session list, because the list can then be out
  of date. A failed connection at page load shows there too. After a server restart,
  the restart bar replaces it.
- An update in progress and a server restart show in a bar at the top of the main area.
  The update bar follows the update state of the status watch in each view. Thus a
  failed update removes it, and the **Updates** card of Settings shows the failure. A
  restart replaces the update bar. The restart bar has **Reload page**.
- After **Copy session ID**, the More actions button shows **Session ID copied** as its
  tooltip for a short time.
- After **Copy folder path**, the ⋯ button of the project shows **Folder path copied**
  as its tooltip for a short time. A list refresh keeps it on the new button. See
  [the project menu](#project-menu).
- The ⋯ button of the file header shows the result of a file menu item as its tooltip.
  See [the file menu](#file-menu).

A failed action that has no such place shows an error toast at the right, below the
toolbar. The toast names the action and the session, for example
`Could not archive “Fix links”.`, and gives the reason. It stays until the user closes
it. The page keeps the three newest toasts.

Archive, restore, stop, and worktree removal show no confirmation. The list, the status,
and the workspace line show the result. Project removal asks first. See
[the project menu](#project-menu). A stop from the sidebar asks first too, because the
view may not show the session. See [Stop from the sidebar](#stop-from-the-sidebar).

### Mobile layout

A window width of 700 pixels or less selects the mobile layout. The width selects it,
not the device. Thus a narrow window on a desktop computer uses it too. The page keeps
the height of the window and shows one part at a time:

- The sidebar is a drawer above the main area.
- The [view switch](#view-switch) below the toolbar shows the session or one view of
  the workspace pane. A wider window that cannot hold the session and the pane has the
  same switch.
- The toolbar has one row.
- The message editor has the height of its text, and no divider. See
  [message editor in the mobile layout](#message-editor-in-the-mobile-layout).
- Each text field has a font size of 16 pixels, also the search field of Changes and
  Files. iOS zooms the page when a text field with a smaller font gets the focus, and
  it keeps that zoom.
- In Changes and Files, the rows of the file list are higher. A view narrower than 560
  pixels shows the list and the file view one at a time. See
  [file list in a narrow pane](#file-list-in-a-narrow-pane).

A wider window uses the regular layout. A change of the width changes the layout at
once and keeps the selected session and the shown view.

#### Sidebar drawer

- The toolbar button at the left of the session title opens the drawer. The open
  drawer covers this button.
- A click outside the drawer or Escape closes the drawer. An open row menu or dialog
  takes Escape first.
- Command-B opens and closes the drawer on macOS.
- The open drawer takes the keyboard focus. The row of the selected session gets it, or
  else the drawer. The main area under the drawer takes no focus and no input.
- When the drawer closes, the focus goes back to the control that had it before. If that
  control is gone, the toolbar button gets the focus.
- The drawer closes when a session or Settings opens.
- The drawer is open on the welcome view, and closed in each other view, after a page
  load and after a change to the mobile layout.
- The drawer has a width of 86% of the window, at most 330 pixels. The sidebar divider
  is not available.
- The state of the drawer is separate from the visibility of the sidebar in the regular
  layout.

#### Toolbar in the mobile layout

The toolbar has one row: the sidebar button, the title with its status and workspace
line, the search icon, and **More actions**. **Continue in new terminal** moves to the
top of the [More actions menu](#more-actions-menu). When a new terminal cannot start,
the menu shows the reason below the disabled item.

The toolbar stays at the top of the main area when the main area scrolls. It has an
opaque background. A Home Screen web app on iOS blurs the page content below the status
bar. It does not blur a bar that stays at the top and has an opaque background. Thus
the session title stays sharp.

A control that gets the focus scrolls to a position below the toolbar. A More actions
menu that is higher than the space below the toolbar scrolls.

#### Message editor in the mobile layout

- The [message editor](#message-editor) has the height of its text: from 2 lines to 6
  lines. Longer text scrolls in the editor.
- The editor and the terminal have no divider. The terminal gets the other height of
  the session.
- A wider window uses the divider again, with the editor height from before.
- The session keeps a minimum height of 340 pixels for its terminal and its editor. In
  a lower window, the main area scrolls.

#### On-screen keyboard

The on-screen keyboard of a phone covers the lower part of the window. The browser
keeps the height of the page. Without a change, it scrolls the page to show the control
with the focus, and the toolbar leaves the window. Thus the page follows the keyboard:

- While the keyboard shows, the page has the position and the height of the visual
  viewport. That is the part of the window above the keyboard. The toolbar stays at
  the top.
- The page hides the [view switch](#view-switch) and the bar above the session
  terminal while the keyboard shows. Their space goes to the shown view.
- The session has no minimum height while the keyboard shows.
- The [message editor](#message-editor) has the height of its text and no divider, as
  in the [mobile layout](#message-editor-in-the-mobile-layout). This applies at each
  window width. A phone in landscape orientation is wider than the mobile layout.
- The sidebar drawer also ends above the keyboard.
- When the keyboard goes away, the page uses the full window again.

The page finds the keyboard from the visual viewport of the browser. A keyboard shows
when the visual viewport is 150 pixels or more lower than the layout viewport, and the
page has no pinch zoom. This rule applies at each window width, not only in the mobile
layout.

A terminal keeps its PTY size while the keyboard shows. The view sends no resize
request. A new size at each change of the keyboard would make the terminal application
draw its screen again, and the recording keeps that output. The session terminal and
the [side terminal](#side-terminal) both use these rules:

- The view is lower than the terminal and shows a part of its rows.
- The view shows the last rows of the terminal. When the cursor is above them, the
  cursor row is the last shown row.
- The shown part follows the cursor after each frame and each cursor movement.
- A [finger drag](#touch-scroll-in-a-terminal) moves the shown part to other rows.
  Then the shown part stays after a frame and a cursor movement, because many
  terminal applications write output and move the cursor all the time.
- Typed input in the terminal shows the cursor row again. A change of the keyboard
  does this too, and a new PTY size from another view. A drag back to the position of
  the cursor row also starts to follow the cursor again.
- When the keyboard goes away, the view shows all rows. Then it asks for the size that
  fits, as before.

#### Limits

- A draft has the height of its form, and the main area scrolls.
- A window wider than 700 pixels keeps the higher toolbar and the font size of 14
  pixels of the regular layout. On a phone in landscape orientation, the part above
  the keyboard can be lower than the toolbar and the editor together. Then the main
  area scrolls. iOS also zooms such a page when a text field gets the focus.
- The mobile layout does not change the sizes of the buttons. Some buttons are smaller
  than a finger, for example the buttons of the bar above the terminal.
- The editor grows with its text only in a browser with the CSS property
  `field-sizing`. In another browser, it has a fixed height of 3 lines.
- The on-screen keyboard has no Esc, Tab, Ctrl, or arrow keys. The page adds no such
  keys.
- A pinch zoom while the keyboard shows gives the page the full window height again.
- The keyboard rules were checked only in Safari on an iPhone simulator. See
  [Checks of the side terminal and the workspace pane](#checks-of-the-side-terminal-and-the-workspace-pane).
- A phone in landscape orientation is usually wider than 700 pixels and uses the
  regular layout.
- A phone reaches the server only through [remote access](#remote-access), which is
  off by default.

### Sidebar

The sidebar lists the saved projects. Under each project, it shows the most recent
sessions in groups. [Pinned](#pinned-sessions) comes first, above the projects. The
sidebar also has a search box, and a bottom row with **＋ Project**, **Archived**,
**Usage**, and **Settings**.

#### Projects and groups

- The sidebar lists saved projects and groups sessions, including drafts, through
  `project-list` and `session-list`.
- **Pinned** comes first when it has families. Projects then appear in name order. The
  order ignores the case of ASCII letters only. For example, **alpha** comes before
  **Beta**, but **Étoile** comes before **éclair**. Groups can be collapsed in each view.
- With no projects and no sessions, the sidebar shows **No projects yet. Click ＋
  Project to add a folder.**
- A group lists [session families](#session-families): a top-level session and its
  sub-sessions count as one family.
- Each group shows its 5 most recent families. **Show more** below a group shows 5 more
  of its families. It has no upper limit.
- A reply holds at most 100 families, plus the family of the selected session. See
  [`session-list`](PROTOCOL.md#session-list) for the exact rule. Thus the
  list reads the 5 most recent families of 20 groups in each request.
- It reads the families after the first 5 of a group in separate windows of at most 100
  families.
- When the group then shows all of its families, the keyboard focus moves from **Show
  more** to its last session.
- The list and Archived keep separate group sizes until reload.
- The family of the selected session stays in its group, even when it is older than the
  other families that the group shows.

#### Sidebar width

A vertical divider on the right edge of the sidebar changes its width. Drag it with a
mouse or touch. Or focus it and use Left/Right to resize. Use Home/End to reach the
limits. A double-click restores the default width. The width stays from 240 to 480
pixels, and the main area keeps at least 400 pixels.

The default width grows with the window, so a large monitor shows more of each session
title:

| Window width | Default sidebar width |
| --- | --- |
| 701 to 950 pixels | 240 pixels |
| 951 to 1390 pixels | 278 pixels |
| 1391 to 1799 pixels | 20 percent of the window width |
| 1800 pixels or more | 360 pixels |

The toolbar button at the left of the session title hides or shows the sidebar.
Command-B does the same on macOS. Ctrl+B stays available to terminal programs. Width
and visibility stay with the browser view across session switches and reset on reload.
In the [mobile layout](#mobile-layout), the sidebar is a drawer and the divider is not
available.

#### Sidebar search

Server-side search matches project names and paths, or session titles, workspaces, and
IDs, before the group limits. A match of a sub-session also shows its top-level session
as context. It uses SQLite's case-insensitive ASCII matching and treats wildcard
characters literally. This UI does not search message or terminal
contents. Each refresh reads the most recent sessions again, so activity changes can
move a session into or out of the shown part of a group.

#### Refresh and selection

- The list refreshes every five seconds while visible. It also refreshes when the
  status watch reports a terminal start or end, or a title change. There is no manual
  refresh control.
- Project names are plain text. The small arrow expands or collapses a group.
- Each project's **＋** creates and selects a new draft entry. A click on an existing
  entry reopens it by session ID. The URL keeps that ID as `/sessions/<id>` through
  reload and launch.
- The welcome view is the home page at `/`. Its toolbar title is **Home**, and it shows
  one line that tells how to start a session. Without a project, the line tells how to
  add the first project with **＋ Project**.
- The bbflow name in the sidebar returns to the welcome view. It also opens when no
  session is selected, for example after the archive of the selected session.

The browser tab title shows the session or draft name. Settings shows `Settings`, and
the home page shows `bbflow`.

#### Stop from the sidebar

The row menu of a session can stop that session. The row menu of a top-level session
can also stop the whole family. The stop items are the last items of the row menu, below
a line. The line shows only while an item shows above it and a stop item shows below it.
Archived has no stop items, because archived sessions have no live terminal.

- **Stop session** shows while the session of the row has a live terminal. Top-level
  sessions and sub-sessions have it. It stops that session only. The other sessions of
  its family continue.
- **Stop family** shows on a top-level session while one of its sub-sessions has a live
  terminal. It stops the members with a live terminal together, also the top-level
  session. See [session families](#session-families).
- While only the top-level session of a family is live, **Stop family** does not show.
  It would then stop only what **Stop session** stops.
- Each item first reads the session or the family from the server. The read also finds
  a family that another view pinned or unpinned, and a family that moved to Standalone
  after a project removal. When no session to stop has a live terminal then, the list
  refreshes and no dialog opens. A session that another view archived has nothing to
  stop.
- The family dialog lists the members that are live at that time. If the sub-sessions
  ended after the menu opened, it lists only the top-level session.
- A dialog asks first, because the view may not show the session. **Stop this
  session?** names the session and its status. **Stop this family?** lists each member
  with a live terminal, with its status: **Running** or **Idle**. A running session had
  a screen change in the last 10 seconds, so its agent can still work.
- A member that creates its worktree has no terminal yet. The family dialog names it
  below the list, and it does not stop.
- **Stop family** in the dialog stops only the listed members. A member that starts a
  terminal after the dialog opened continues.
- Each stop is the same as **Stop session** in the toolbar. Side terminals continue. The
  history of each session stays.
- After the stop, the dialog closes, and the list shows the ended statuses. An error
  shows in the dialog, and the dialog stays open.
- After a choice with the keyboard, the focus returns to the ⋯ button of the row. This
  applies after the stop, after a cancel of the dialog, and when no dialog opens. If the
  row has no ⋯ button then, the focus goes to the search box.

#### Bottom row

Below the list, a row holds **＋ Project**, **Archived**, **Usage**, and **Settings**.
In a narrow sidebar, **Usage** and **Settings** go to a second line together. **Usage**
opens the [Usage dialog](#usage-dialog). A newer release or a failed update shows as a
[dot on Settings](#dot-on-settings). The instance directory shows below the row. The
sidebar shows the server connection only while the server is unavailable.

### Session families

A session can have sub-sessions. A parent and its sub-sessions form a family, and the
sidebar shows the family together. The link only organizes the list. A sub-session
inherits no history, draft, or settings from its parent.

#### Family rules

- A sub-session belongs to one top-level session, its parent.
- A family has one level: a sub-session cannot have sub-sessions.
- `sessions.parent_id` keeps the parent, or NULL for a top-level session.
- The parent is set when the sub-session draft is created, and it does not change, so
  families form only through **New sub-session**.
- Sessions from before families stay top-level sessions.
- Each session keeps its own terminal, status, and lifecycle. **Stop session** stops
  one session only. **Stop family** in the row menu of the top-level session stops the
  live members of a family together. See [Stop from the sidebar](#stop-from-the-sidebar).
- The sidebar is the only place that shows the family of a session. The toolbar of a
  sub-session is the same as the toolbar of a top-level session.

#### Family rows in the sidebar

- The sidebar shows a family as the row of the top-level session, then the rows of its
  sub-sessions in creation order. A family is always open.
- A guide line goes from the parent to each sub-session and ends at the last one.
- A family shows its first 5 sub-sessions. Then **Show N more** ends the guide line. It
  shows the other sub-sessions in this view until reload, and the keyboard focus moves
  to the first of them.
- A search shows every matching sub-session, and a selected sub-session always shows.
- The latest activity of any member in the list gives the position of the family.
- The tooltip of the status icon of a sub-session tells where it works: **parent
  workspace**, **own worktree**, **own folder**, or, for a draft, **new worktree**.
- A ⑂ mark after the title shows an own worktree or a draft for a new worktree.
- A context row shows a top-level session that is not in the list itself, at reduced
  contrast. It is the parent of a match, or a session from the other collection, such
  as a parent that is not archived in Archived.

#### New sub-session

**New sub-session** in the row menu of a top-level session, or in the More actions menu,
creates a sub-session draft. The draft takes the project of its parent. On a
sub-session, the menu item is **New sub-session in this family**: it adds a draft to the
same parent. A session without a saved project cannot get a sub-session. The draft
offers two workspaces:

- **Parent workspace** starts the sub-session in the current workspace of its parent.
  Both sessions then change the same files. This choice needs a parent whose first
  terminal started. Before that, the parent has no launch workspace, even after a launch
  that stopped early. The sub-session gets no worktree record.
- **New worktree** creates a managed worktree from the project folder. The default base
  is the current branch of the managed worktree of the parent, or its commit when that
  checkout is detached. Thus the base has the commits of the parent, even after it
  switched branches. Without a parent worktree, the default is the default Git base.
  Uncommitted changes of the parent are not copied.

In a Git project, the Settings worktree default selects **New worktree**. Otherwise the
draft selects **Parent workspace**. The form says that, in the parent workspace, both
sessions change the same files. For example, a review-loop reviewer runs
`gh pr checkout --detach`. In the parent workspace, that command would change the
checkout of the implementer, so such a reviewer needs **New worktree**.

#### Request and storage rule

A request for a sub-session draft names a session. For a top-level session, that session
becomes the parent. For a sub-session, the parent of that sub-session becomes the
parent, so the new draft is a sibling. The draft takes the project of the family. The
request fails for a missing session, for a family without a saved project, and for an
archived parent. The store also keeps the storage rule: the parent of a sub-session is a
top-level session of the same project that is not archived. Removal of a project moves
the whole family to Standalone.

#### Archive and restore of a family

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

### Pinned sessions

A pin keeps a top-level session and its sub-sessions at the top of the sidebar.
**Pinned** lists the pinned families of all projects, above the project groups. A
pinned family shows only there. The pins are in SQLite, so every view shows the same
pins.

#### Pin action

- **Pin** is in the row menu of each top-level session outside Archived. It is also in
  the More actions menu of the toolbar. For a pinned session, **Unpin** replaces it.
- A pin moves the family to the top of **Pinned** and expands that group.
- An unpin returns the family to its project group, at the position of its latest
  activity, and expands that group. A family that is older than the shown families of
  the group is then behind **Show more**.
- After a pin or an unpin with the keyboard from a row menu, the focus moves to the ⋯
  button of the row in its new place. When the row is behind **Show more**, the focus
  moves to the nearest later session row that shows, or else the nearest earlier one.
  Without such a row, the focus moves to the search box. The list then scrolls to show
  the focused control.
- **New sub-session** and the restore of the selected session expand the group that
  shows the family: **Pinned** for a pinned family, or else the group of the project.
- Other views show the change at their next list refresh.

#### Pinned group

- **Pinned** comes first in the list. It shows only when it has families.
- The newest pin comes first. Activity does not change the order.
- Each top-level row shows the name of its project below the title. A session without a
  saved project shows its workspace there.
- **Pinned** has no ＋ button, no ⋯ button, and no **Show more**. Its arrow collapses
  it like a project group.
- Search filters **Pinned** like a project group. A match of the project name or folder
  lists the pinned families of that project.
- Archived ignores pins. It lists each family in the group of its project.
- `session-list` gives the families of **Pinned** in the group `pinned`. See
  [`session-list`](PROTOCOL.md#session-list).

#### Pin rules

- Only a top-level session that is not archived can have a pin. A draft can have a pin.
  A sub-session moves with its family.
- Archive removes the pin. Restore does not pin the session again.
- A pin stays after the removal of its project.
- A pin of a pinned session and an unpin of a session without a pin change nothing.
- `sessions.pinned_at` keeps the time of the pin, or NULL without a pin. A check of the
  table rejects a pin of a sub-session or of an archived session.
- The time is in UTC with nine digits of fractional seconds, so its text order is its
  time order. A new pin gets a time after the latest pin, also when the clock moved
  back. Thus two pins in one millisecond keep their order.

#### Limits

- At most 20 sessions can have a pin. A pin beyond that fails, and the error tells the
  user to unpin a session first. Thus one `session-list` request reads all of
  **Pinned**.

### Archive

**Archive** hides a draft or a finished session from the normal list. **Archived**
shows the hidden sessions, and **Restore** returns one to its project. Archive keeps
all recorded data. There is no permanent delete action.

#### Archive action

- **Archive** hides a draft or finished session from the normal list. It is in the More
  actions menu of the toolbar. It is also in the row menu of each draft and ended
  session in the list.
- The ⋯ button of a row opens its row menu, so one click never archives a session. The
  button shows on pointer hover and on keyboard focus. On devices without hover, it
  always shows.
- The row menu has **New sub-session** for a top-level session, **Pin** or **Unpin** for
  a top-level session outside Archived, and **Archive**, or **Restore** in Archived. A
  live session also has **Stop session**. A top-level session has **Stop family** while
  one of its sub-sessions is live. See [Stop from the sidebar](#stop-from-the-sidebar).
  A row without such an item has no ⋯ button.
- While a row menu is open, a list refresh keeps the buttons of the list. The list then
  changes after the menu closes.
- Escape, a choice, or a click outside the menu closes it. The Up and Down arrow keys
  move between the items.
- Archive of a top-level session with sub-sessions archives the whole family. See
  [session families](#session-families).
- Archive removes the [pin](#pinned-sessions) of a session.
- Archive of the selected session first saves the launch choices and message editor.
  Then the welcome view opens. A family archive does the same when the selected session
  is in the family. Archive of another session keeps the current view.

#### Archived list

**Archived** shows the archived sessions in place of the normal list, with the same
search and groups. **Back** above the list, or a second click on **Archived**, returns
to the normal list. A new project also returns to the normal list and clears the
search. **Restore** in the More actions menu or in a row menu returns an item to its
project, or Standalone if that project was removed, without launching it. A restore of
the selected session opens it in the normal list. A restore of another session keeps
the archived list.

While Settings is open, an archive or restore from a row menu keeps Settings open. When
the row is the session behind Settings, **Done** then opens the welcome view
after an archive, or the restored session. After an archive or restore with the
keyboard, focus moves to the nearest later session row that shows, or else the nearest
earlier one. Rows of a collapsed group do not count. Without such a row, focus moves to
the search box, or to **Back** in the archived list.

#### Archive rules

The archive flag is separate from draft/run status. Archiving preserves all SQLite
records, draft revisions, attachments, workspace files, and worktree metadata. bbflow
rejects archive requests for active sessions and unfinished launch claims. Stop the
session first. Archive changes and launches share the server launch lock.

Archived drafts can be edited and finished output can be read. Start requires restoring
the draft first. Other open views retain their selection and see archive changes on
refresh. The server also checks archive state at Start. Read-only SQL includes archived
data unless filtered explicitly. There is no permanent delete action.

### Projects and launches

A project is a saved folder with a name. Each session starts from a project, in an
interactive shell of the server. This section also gives the rules of the terminal
view: its reconnection, its frames, and the display of an ended session.

#### Projects

**＋ Project** at the bottom of the sidebar opens the Add project dialog for a folder and
an optional name. `project-add` saves an existing canonical directory and a name,
defaulting to the folder basename. Git is not required. Canonical paths are unique
across saved projects. Parent and child folders remain allowed. Project IDs are
independent of their names and paths.

Names contain 1–200 characters without control characters. Projects can be renamed and
removed in the [project menu](#project-menu). The folder of a saved project cannot
change. Removal sets their sessions' `project_id` to NULL. The UI shows these sessions
under Standalone. Removal preserves recorded workspace paths, runs, recordings, drafts,
and files. `session-rename` changes the user title of a session without changing its ID
or recorded activity. See [session titles](#session-titles).

A new instance has no projects. Project metadata is authoritative in SQLite. Files in a
project folder are ordinary files outside the database.

#### Project menu

The ⋯ button beside the **＋** button of a project opens its project menu. The menu has
these items:

| Item | Effect |
| --- | --- |
| **Edit** | Opens the Edit project dialog. The dialog changes only the name. It shows the folder as text. |
| **Copy folder path** | Copies the saved canonical folder of the project to the clipboard. |
| **Search this project** | Opens [Search history](#history-search) with the scope **This project**. **This session** is not available there. |
| **Remove project** | Opens a dialog that asks before the removal. The dialog names the project and its folder. |

- **Remove project** is the last item, below a line. Its text has the danger color.
- The menu has the keys and the focus rules of a row menu. See
  [archive action](#archive-action). A list refresh does not close it.
- The groups of Pinned, Standalone, and Archived have no project menu.
- After a rename, the focus is on the ⋯ button of the project. The list shows the
  project at its place in name order and scrolls to show the button.
- A removal keeps the current view. Settings, the selected session, and the sidebar
  drawer stay open. A selected session of the project becomes standalone.
- After a removal with the keyboard, the focus moves to the search box. The sessions of
  the project then show under Standalone. A pinned family stays in Pinned.
- A failed copy shows an error toast. A failed rename or removal shows its error in the
  dialog.

#### Drafts and Start session

Clicking **＋** beside a project opens its saved preparation without launching a process.
There is no global New session button. The main area has the session name, tool, and
worktree choices above a persistent message editor. **Start session** replaces the upper
form with its terminal and adds the session to the project's list.

The message and attachments remain in that session. Clicking **＋** again creates its
next draft. Launch settings and message drafts save separately. Project removal
preserves unfinished drafts and sessions under Standalone. It does not associate them
with another project.

#### Shell and startup command

The server resolves its `$SHELL` and starts it with `-i`, using `/bin/sh` when unset.
The server rejects a nonempty relative shell path. It accepts names on PATH and absolute
paths. Requests cannot override the shell or environment.

A selected tool supplies an optional startup command to submit through that shell. For
a tool with a type other than Custom, the launch adds the options of the chosen model and
effort to the end of the command. See [Tool types and models](#tool-types-and-models). The
server inherits its startup environment and sets `TERM=xterm-256color`. The launch
stores the tool name and workspace basename as the derived title, even when the user set
a title.

Workspaces accept absolute paths, `~`, and `~/path`. Home expansion uses the server's
`HOME` from startup, before canonicalization. Other relative paths, `~user`, and
environment-variable expansion are unsupported. The directory must exist. History stores
its canonical absolute path. Multiple sessions may share it.

The shell reads its normal startup files. Agents retain their arguments, authentication,
and permissions. bbflow submits only the configured startup command. It does not submit
the message draft automatically. After an agent exits, the shell remains available.
After the shell exits, the session ends.

#### Terminal view

xterm.js displays server-rendered frames and forwards keyboard input, paste and resize
requests through the shared stream. The server submits the saved tool command with only
the model and effort options of its type. It adds no prompts. Source terminal queries are answered by the server,
including while detached. Generated frames exclude hyperlinks, clipboard requests and
other non-display source escape sequences.

Selecting another session closes the old view before opening the selected one. Closing
or refreshing the tab leaves work and recording running. Refresh reopens the project
draft or session identified in the URL path, or Settings at `/settings`. Transport
failures trigger automatic reconnect with increasing delays from 0.5 to 5 seconds. The
last screen stays visible and input is disabled until a fresh frame is rendered.

#### Touch scroll in a terminal

xterm.js scrolls on a mouse wheel and on a drag of its scroll bar. It does not scroll on
a finger drag. Thus the page handles a finger drag in the session terminal and in the
[side terminal](#side-terminal):

- A vertical drag with one finger scrolls the terminal by the rows that the finger
  passes. A finger that moves down shows earlier rows.
- A drag gets its direction when the finger has moved 8 pixels. A drag that is then
  more vertical than horizontal is a vertical drag. Each other drag is horizontal. A
  drag keeps its direction until the finger leaves the screen.
- A horizontal drag does not scroll the terminal and sends no report, also when it
  drifts up or down.
- After a fast release, the scroll continues and gets slower. This is a glide. A touch
  stops it. Typed input in the terminal also stops it, because typed input shows the
  cursor row.
- A vertical drag is not a tap. A touch that stops a glide is not a tap either, also
  when it then moves to the side. The page cancels the end of such a touch, so that
  the browser does not send a click. A click makes xterm.js give the focus to the
  terminal input, and a phone then shows its keyboard.
- Each other touch keeps its browser behavior. That includes a touch that moves less
  than 8 pixels. It also includes a touch after the last frame of a glide, and a touch
  after a drag with mouse reports.
- The browser does not pan the page for a vertical drag that starts in a terminal. A
  horizontal drag and a pinch keep their browser behavior.
- A drag on the scroll bar of the terminal moves the scroll bar, as before.
- A view can be lower than its terminal and show a part of the rows, for example with
  an [on-screen keyboard](#on-screen-keyboard). There, a drag first moves the shown
  part, to the first or the last row of the terminal. When the shown part is at that
  end, the drag continues with the history or the reports below. A movement across
  that end uses its other distance for the history or the reports.
- A drag scrolls the history rows of the view, as the mouse wheel does. It sends no
  input. That includes a view of an alternate screen, because the frames draw an
  alternate screen below the history rows.
- When the terminal application asked for mouse reports, a drag has the effect of a
  mouse wheel in xterm.js. xterm.js sends one wheel report for each row to the
  application. Such a drag does not continue after the release. A report does not
  change the [size owner](#size-owner).

#### Reconnection after a server restart

- A session connection owns its peer, rendered-frame state, and retry timer. Closing
  that view cancels retries and ignores late callbacks from the old connection.
- A server restart or update keeps the port, so open tabs reconnect at the same
  address. The new server has a new instance ID and can have a new protocol.
- A tab can get a complete greeting with a new instance ID, the same directory, and the
  same port. Then it reloads once and keeps its path. The reload loads the UI of the
  new server.
- An incomplete greeting, or a greeting with another directory or port, needs manual
  recovery.
- A tab with an edit that the old server did not save does not reload. The page bar
  tells the user to copy the edit and reload. The old page cannot save edits to the new
  server.
- The message editor, the project draft form, Settings, and the open Add project, Edit
  project, Rename, and Continue dialogs have this check.
- A dialog has an edit when a field differs from its value when the dialog opened. That
  dialog also shows the message, because it covers the page.
- A tab that reloaded automatically in the last 10 seconds shows the same message.
- Other protocol and instance mismatches require explicit recovery. A changed server
  port requires reopening the UI.
- Input and session creation are never retried automatically.

#### Frames

The server sends a full current screen and the normal-buffer scrollback rows that the
view keeps, then generated row changes. [Terminal scrollback](#terminal-scrollback)
gives the row limit. Each frame is acknowledged after xterm finishes parsing it. Each
view has at most one outstanding frame, so slow rendering coalesces intermediate redraws
while capture continues. Partial source escape sequences and UTF-8 remain inside the
server's emulator. Clients receive complete render operations.

A view keeps at most 8 MiB of rendered scrollback rows, so rows with many styles lower
the row count. A frame carries at most 11 MiB of rendered data. A full frame always
includes the visible screen and omits the oldest rows that do not fit. A view narrower
than the terminal keeps its own cache of cropped rows. Each of its frames renders only
new rows.

Between the old screen and a full frame, the browser paints no other state. It paints
no empty view, and no old screen at the new size. xterm.js parses each write in a later
task, and a reset empties the rows of the view at once. Thus a full frame is one write:
an erase of the history rows, a reset (RIS), and the frame data. A parser handler of the
reset sets the row limit of the frame width and the frame size. Then xterm.js does its
reset at the new size. xterm.js parses one write in one task, so the browser paints the
rows of the frame next.

The erase leaves no history rows for the resize to reflow. A delta frame has the size of
the frame before it, so it has no erase, no reset, and no resize. A frame that the
browser received always reaches the view, also when the connection fails before xterm.js
parses the frame. Thus the view keeps a complete frame while it reconnects.

Frames preserve visible cells, colors, cursor position, bracketed paste, application
cursor/keypad, mouse, and focus reporting modes. Advanced terminal graphics and extended
keyboard protocols are not forwarded. Rendered rows visually preserve recorded wrapping.
A rendered row writes a style only where the style changes, so cells with the same
colors and styles give the same row. Client rows do not preserve soft wraps during copy
or reflow. Normal scrollback remains
available while an alternate screen is visible. Erased output and exited alternate
screens remain in the original recording.

A full frame sets each of these modes. A later frame sets only the modes that changed,
and it turns a mode off before it turns another mode on. xterm.js stops the reports of a
mouse gesture when it parses the reset of a mouse tracking mode, also when the next
sequence sets the mode again. Thus a redraw during a drag keeps the gesture of the view.

xterm.js reports the focus state each time it parses the sequence that turns focus
reporting on. A view does not send that report as input. A view sends a focus report
only when the focus of its terminal changes. Thus a frame never causes input, and it
cannot change the [size owner](#size-owner). An application gets no focus report at the
time that it turns focus reporting on. The same rule applies to the side terminal.

#### Display of an ended session

Ended sessions display the saved final view of their latest terminal. A normal exit or
stop writes a derived `terminal-screen` event for that run to SQLite. Interrupted
recordings without a final screen are reconstructed on the server from the events of
that run only, in pages of 64 original display events. Historical queries are discarded
and recorded input is never sent to a process.

The saved view has the size of the terminal when its process ended. The browser keeps
that width, because the server rendered the rows at that width. The browser sets the
number of rows to fill the terminal area, and again after each size change.

The last row with text becomes the last row of the view, also at the saved number of
rows. When the cursor row is lower, the cursor row becomes the last row, and the blank
rows above it stay. A row with a background color counts as a row with text, because the
server renders its cells as spaces. A taller view shows history rows above the last row.
Blank rows fill the bottom when the history has too few rows. A lower view moves the top
rows into the scrollback and keeps all history rows.

The cursor returns to its recorded row when that row is on the screen again. A live view
applies these rules when its process ends. A live view of another size than the terminal
shows a crop or a padding of the screen. Thus its last frame is the saved screen, as a
reload shows it.

Large interrupted recordings can take longer to reconstruct. This restores a display,
not a process or native agent context. Terminal dimensions are limited to 2–512 columns
and 1–256 rows to bound emulator memory. When a lower view moves the cursor row into the
scrollback, the cursor shows on the first row.

#### Contents of a session view

Session views show the server-rendered terminal and message editor. The UI also provides
sent messages, recorded-output search, a read-only Changes pane, and a side terminal.
There is no browser SQL client. The `bbflow query` command reads archived events. There
is no semantic chat transcript.

### Session preparation, settings, and worktrees

This section has three related parts:

- **Settings** is one page for the instance. It has the appearance, the server port,
  remote access, the tools with their startup commands, types, and default models, and
  the session defaults.
- A **preparation** holds the launch choices of a session that did not start: the
  project, the tool, its model and thinking effort, and the worktree choices. The message draft saves separately.
  Start does not send it. It stays in the editor for the user to send.
- A **managed worktree** gives a session its own checkout and branch. bbflow creates it
  at Start from a base commit.

#### Settings page

Settings is an instance-wide page at `/settings`. Its URL has no session ID. The cards
are **Appearance**, **Tools**, **Session defaults**, **Prompts**, **Automatic titles**,
**Updates**, **Server**, and **Remote access**. See [Saved prompts](#saved-prompts) for
the **Prompts** card. Tools come before the session defaults, because the
default tool is one of them.

**Appearance** offers **System**, **Light**, and **Dark**. System is the default and
follows the device appearance. A selection applies to the current view at once. Other
views read the saved appearance on reload or when they open Settings. The server
includes the appearance in each page so it applies before the first render. If the
server cannot read the settings, the page uses System.

The toolbar title of Settings is **Settings**. A bar at the top of the page holds the
save status and **Done**. The bar stays in view while the page scrolls. **Done** leaves
Settings.

#### Saves in Settings

Settings has no save action for the whole page. Each control saves to SQLite in its own
way:

| Control | Save |
| --- | --- |
| Appearance, default tool, worktree default, update check | At once, on selection. |
| Starting branch or commit, Port, Tailscale host name, Tailscale login | On Enter, or when the field loses focus. Escape restores the saved value. |
| Tools | **Add tool** and **Save** in the tool editor. A switch and the move buttons save at once. **Remove** asks first. |
| Prompts | **Add prompt** and **Save** in the prompt editor. The move buttons save at once. **Remove** asks first. |
| Title tool | After a passed test. See [Title controls in Settings](#title-controls-in-settings). |
| Remote access switch | At once, on a click. See [Remote access in Settings](#remote-access-in-settings). |

The status shows **Saving…** during a save. It shows **All settings saved** when each
entry is saved. Otherwise it names each entry that is not saved, for example
**Not saved: Port, New tool**. The names are **Starting branch or commit**, **Port**,
**Tailscale host name**, **Tailscale login**, **Custom title command**, **New tool**,
**New prompt**, **Edit of** with the tool or prompt name, and the name of a default
that failed to save.

- When the user leaves Settings, the page discards the entries that are not saved. The
  fields then show the saved values. A default that the server rejected is such an
  entry. It does not join a later save.
- A running save or title tool change continues after the user leaves.
- A hidden Settings page shows no error, so an error toast tells about an entry that
  did not save:
  - The Port text was not a valid port, or the page showed the error of a rejected port,
    remote access value, or default. The click on **Done** first saves a text field, so
    the server can reject the value before the page closes.
  - The server rejected a port, a default, a title tool, or remote access after the user
    left. The page then also discards that entry.
  - A save of a new tool or prompt, an edit, a move, or a removal failed after the user
    left. The toast names the action and the tool or prompt, for example **The new tool
    “Codex” did not save.**
- A reply that comes after the user opened Settings again also goes to a toast, because
  the close discarded the entry of that request.
- Escape in **Starting branch or commit** also discards a value that the server
  rejected.
- While Settings shows an entry that is not saved, the browser can warn when the user
  reloads or closes the tab. The page also does not reload after a server restart. See
  [Reconnection after a server restart](#reconnection-after-a-server-restart).

#### Server port

- In **Server**, **Port** sets the port of the next server start. An empty field
  selects the automatic port.
- The field saves when it loses focus or on Enter. Escape restores the saved port and
  hides the error.
- The card shows the port that the server uses now and when a saved port applies.
- Text that is not a whole number, and a port outside 1024 to 65535, send no save. The
  page shows its range message below the field.
- New text in the field hides the error, because the error is about the earlier text.
- A new port that another program holds fails to save. A port that browsers refuse to
  open also fails. The server error shows below the field.
- A failed port save does not join a later save of another setting.
- An edit made during a port save stays in the field after the reply, with its own
  error.
- Open tabs do not move to a new port.

#### Remote access in Settings

- In **Remote access**, an On/Off switch next to the title holds the switch of
  [remote access](#remote-access). **Tailscale host name** and **Tailscale login** hold
  the two values. The card tells that a person who can use remote access can run
  commands on the computer.
- The switch saves at once. It shows and works also while the values are not saved. A
  click saves only the switch, with the saved values. The switch takes no click during
  its save.
- Each field saves alone, as **Port** does: on Enter, or when the field loses focus.
  Escape restores the saved value and hides the error of the field. A save of a field
  does not change the switch or the other field.
- The fields take input during a save. A save clears the edit of its field only when no
  input came after the save started. Then the field shows the saved value, with the host
  name in lower case. Enter and the blur after it save the text once. An input or Escape
  during a save makes the next Enter or blur save again.
- The status below the fields tells if remote access is on, and for which host name and
  login. When the switch is on without both values, the status tells that remote access
  needs both.
- To turn remote access off, the user clicks the switch. The fields keep their values.
- A value that the server rejects stays in its field, with the server error below that
  field. Each field has its own error. New text in a field hides only its error, and a
  save of the other field keeps it. The error of the switch shows below the card text.
- A save of a field applies to the latest settings after a revision conflict. Thus a
  view with an earlier login cannot restore a login that another view removed.
- A press on the switch keeps the focus in a field, as Safari does for each button. Thus
  a field with an edit gets no blur before the click, and its save cannot come first.
- A click that turns the switch off saves at once, before an edit of a field. Thus no
  change of a value comes before Off. From a remote view, such a change could close the
  connection of the view and keep access on.
- A click that turns the switch on uses the values that the card shows at the click: the
  text of a field with an edit, as the server saves it, or else the saved value. The
  click first saves each field with an edit, and it waits for a running save of a field.
- When a field keeps an edit that did not save, the switch stays off. The error of the
  field stays in view, or an error tells that a field did not save.
- When the saved values then differ from the values at the click, the switch stays off
  too. A save of a field can take a new value of the other field from another view. The
  fields show the new values, and the error names them. A second click turns remote
  access on for those values.
- Thus the switch never turns remote access on for a host name or a login that the card
  did not show at the click.
- A failed save of the switch or a field after the user left Settings shows the toast
  **Remote access did not save.**
- A text that is not saved shows in the save status with the name of its field. The page
  discards it when the user leaves Settings.
- A save of remote access does not join a save of another setting.

#### Tools

**Tools** shows the saved tools in two tables, each with a title. **Built-in tools**
comes first, then **Custom tools**, the tools that the user added:

| Table | Columns | Row actions |
| --- | --- | --- |
| **Built-in tools** | **On**, **Name**, **Command**, **Default model** | **Edit**. Shell has no Edit. |
| **Custom tools** | **On**, **Name**, **Command** | **Edit**, **↑**, **↓**, **Remove** |

- Each row starts with a switch, **On** or **Off**. A tool that is off stays saved, and
  its row is dimmed. See [Built-in tools](#built-in-tools) for the effect.
- The default tool has a **DEFAULT** mark beside its name.
- **Default model** shows the model and the effort, for example **gpt-6-luna ·
  Medium**. For Shell it shows **None**.
- A built-in tool keeps its place and cannot be removed. A custom tool moves only among
  the custom tools.
- When Settings opens, the page asks the server which CLIs it finds. A built-in tool
  without its CLI gets a **NOT FOUND** mark. See [Tool program](#tool-program).
- A narrow window scrolls each table sideways. Without a custom tool, the second table
  tells how to add one.
- The settings hold at most 100 custom tools. The built-in tools do not count.

**＋ Add custom tool** below the custom tools and **Edit** in a row open the tool editor as a
dialog, so a long tool list needs no scroll to reach it:

- **＋ Add custom tool** opens it with the title **New custom tool**. **Edit** opens it
  with the values of a saved tool, and its title is **Edit of** with the tool name.
- Each tool that the user adds is a Custom tool. Its editor has **Name** and **Startup
  command**. bbflow submits the command unchanged, so it holds all options of the tool.
- For a built-in tool, the editor has only **CLI path**, **Default model**, and
  **Default thinking effort**, with a note that bbflow keeps its name and command. See
  [Tool program](#tool-program).
- **New sessions submit** shows the command with the options of the model and the
  effort.
- **Add tool** or **Save** saves the tool and closes the dialog. **Cancel**, **✕**, and
  Escape discard the entry. An error keeps the dialog and its values. The dialog stays
  open while a save runs.
- Focus goes to the first field when the dialog opens. While the dialog is open or a
  change saves, the buttons of the rows and **＋ Add custom tool** wait. The row of the edited
  tool is marked.

The page does not add a tool with the name of another tool. It also does not rename a
tool to such a name. The error shows in the row. The CLI selects a tool by its name, so
two tools with one name stop `tool add` and `tool remove`. An edit that keeps its name
saves, also when an earlier save made two tools with one name. The page checks the name
again after a revision conflict, against the latest settings. Thus a name that another
view or the CLI added meanwhile also stops the save.

**Remove** opens a dialog that names the tool. The dialog tells that drafts and sessions
keep their own copy of the command, and that a removal has no undo. For the default
tool, it also names the tool that becomes the default tool. See
[Built-in tools](#built-in-tools). **Remove tool** saves the
removal. The move buttons save at once.

Another view or the CLI can make the tool the default tool while the dialog is open.
Then **Remove tool** saves nothing. The dialog opens again with the warning about the
default tool, and the user confirms again.

A move returns keyboard focus to its button if another move in that direction is
available. Otherwise focus goes to **Edit** on the moved row. After a removal, focus
goes to **Edit** on the nearest row. If no custom tool is left, focus goes to **＋ Add
custom tool**. After a save or **Cancel**, focus goes to **Edit** of the tool, or to
**＋ Add custom tool**.

In **Session defaults**, the text below **Default tool** names the default model and
effort that new drafts select.

The page sends one settings save at a time. If another view or the CLI saved first,
the page applies the requested change to the latest settings. An edit keeps the latest
value of each tool field that the user did not change. The type, the model, and the
effort count as one field, because the model and the effort belong to the type.

#### Theme

The theme covers the workspace, dialogs, terminal, and Changes pane. Dark uses charcoal
surfaces, a near-black terminal, and blue for primary actions and focus. The terminal
renders the colors supplied by each program. Light also uses a dark terminal. A browser
without CSS `light-dark()` support uses the Light palette.

#### Updates setting

**Updates** shows the running version and the result of the last release check. It has
**Check now** and the **Check for a new version every day** setting. The setting saves
at once and controls only the daily check. New installations and upgrades start with
the setting on. See [Release check](#release-check) and
[Updates card](#updates-card).

#### Session defaults and tool commands

Settings also has a default tool, default worktree choice, default Git base, and an
ordered list of named commands. In **Session defaults**, their labels are **Default
tool**, **Start new Git sessions in a new worktree**, and **Starting branch or commit
for new worktrees**. Shell is a [built-in tool](#built-in-tools) that sends no startup
command.
Users can add, edit, reorder, and remove other presets. A command is one line of shell
syntax, at most 1,000 UTF-8 bytes, without control characters. bbflow does not install
tools or check the other arguments of a command. Commands may contain secrets
and are stored locally in the same unencrypted archive as terminal input.

#### Built-in tools

Each instance has **Shell** and one built-in tool for each agent type:

| Name | Command without a CLI path | Type |
| --- | --- | --- |
| **Shell** | None. It starts the shell of the session. | None |
| **Codex** | `codex --no-alt-screen` | `codex` |
| **Claude Code** | `claude` | `claude` |
| **Antigravity** | `agy` | `agy` |
| **Code Puppy** | `code-puppy` | `code-puppy` |

Each tool is on or off, also a tool that the user added. A tool that is off stays
saved. It is not a choice in the **Tool** menu of a draft, the **Continue in new
terminal** dialog, or **Default tool**. A draft that chose the tool before keeps it, as
for a removed tool. A tool that is off cannot be the default tool. A tool that the user
adds starts on.

When the default tool turns off or leaves the list, Shell becomes the default tool. If
Shell is off too, the first other tool that is on becomes the default tool. The last
tool that is on cannot turn off or leave the list while it is the default tool.

Shell has the empty ID, as before. Its row in the **Built-in tools** table has only
its switch, because Shell has no command, model, or path. The settings save Shell as
`shellOff`. A draft that chose Shell before Shell turned off keeps it, and its menu shows
**Shell (off)**.

bbflow keeps the name, the type, and the command of a built-in tool. The user sets only
its [CLI path](#tool-program), its default model and effort, and whether it is on. The
tool cannot be removed. For other options or a wrapper, the user adds a Custom tool. A
save with another name or command for a built-in tool keeps the kept values, and a save
with another type fails. A settings save without a built-in tool keeps it. Only the
server marks a tool as built in. The saved list has the built-in tools first, then the
tools of the user.

The tool menus of a draft, of **Continue in new terminal**, and of **Default tool** show
the built-in tools that are on, Shell among them, sorted by name. A line follows, then
the custom tools that are on, in their saved order. The **Built-in tools** table in
Settings is sorted by name too. The custom tools keep the order of **↑** and
**↓**.

At its first start, the server checks which CLIs it finds, through its shell. See
[Tool program](#tool-program). It turns on each built-in tool whose CLI it finds. It
runs this check once, before it takes
requests, and it keeps the settings revision. Later starts do not turn a tool on or off.
A failed check turns on no tool. The check finds only the CLI. It does not tell if the
user is signed in.

#### Tool program

A built-in tool has an optional **CLI path**. The program of an agent type is this
path, or the plain CLI name when the path is empty: `codex`, `claude`, `agy`, or
`code-puppy`. bbflow runs the program in five places:

- The sessions of the built-in tool. Its command is the program, then `--no-alt-screen`
  for Codex. The launch adds the model and effort options.

- The [model list](#model-lists) of the type, for example
  `/opt/homebrew/bin/codex debug models`.
- The check for the CLI: at the first start, and for the **NOT FOUND** mark. A plain
  name must be on the PATH of the server. A path must name an executable file.
- The [title tool](#title-models) of the type. The start of its command is the
  program.
- The [usage check](#checks-of-each-cli) of Codex, Claude Code, and Antigravity.

A session runs in the shell of the session, which reads the startup files of the user.
The other four run in the shell of the server without them. So a plain name can work in
a session and fail in the check. A CLI path serves all five.

A CLI path has at most 500 characters: letters, digits, and `_ . / ~ + @ -`, without
spaces. So the shell does not interpret it, except a `~` at its start. A path with a
folder starts with `/` or `~/`. Sessions, the model lists, the check, the title tools,
and the usage checks run in different folders, so a relative path would name different
files. Only a built-in
tool has a CLI path. After a save with another path, the page reads the model lists,
the check, and the title commands again.

#### Tool types and models

Each tool has a type. A built-in tool has the type of its agent: **Codex**, **Claude
Code**, **Antigravity**, or **Code Puppy**, saved as `codex`, `claude`, `agy`, and
`code-puppy`. Each tool that the user adds is **Custom**, saved as `custom`, also when
its command starts an agent. A save of a tool of the user with another type fails. A
built-in tool also has a default model and a default thinking effort. An empty value
selects the default of the CLI and adds no option.

The launch adds the options at the end of the command, so the command must end with the
agent call:

| Type | Model option | Effort option |
| --- | --- | --- |
| Codex | `--model MODEL` | `-c model_reasoning_effort=EFFORT` |
| Claude Code | `--model MODEL` | `--effort EFFORT` |
| Antigravity | `--model MODEL-EFFORT`, or `--model MODEL` without an effort | Part of the model ID |
| Code Puppy | `--model MODEL` | None |
| Custom | None | None |

A model name has at most 200 characters. It starts with a letter or a digit and has only
letters, digits, and `. _ : / @ + -`. An effort is one lowercase word. These rules keep
the names safe in a shell line without quotes. The server rejects a model or an effort
for a Custom tool or Shell, an effort for Code Puppy, and an Antigravity effort without
a model.

#### Model lists

The **Model** menus suggest the models of each type. The first choice is **CLI
default**, which adds no `--model` option. The last choice is **Other…**, which shows a
field for any model name. A saved model that the list does not have stays a choice. The
server runs one list command for each type, through its shell, in an empty temporary
folder:

| Type | Command | Result |
| --- | --- | --- |
| Codex | `codex debug models` | The models with `visibility` `list`, with the efforts of each model and its default effort. |
| Antigravity | `agy models` | Lines of an ID, a tab, and a name. IDs such as `gemini-4-neon-high` join to the model `gemini-4-neon` with its efforts. |
| Code Puppy | `code-puppy --setup model list` | The configured models of Code Puppy. |
| Claude Code | None | A built-in list of the aliases `fable`, `opus`, `sonnet`, and `haiku`, and full model names. |

The server keeps each list in memory until **Refresh list** or a server restart. A failed
command keeps no list, and its error shows below the menu. **Other…** still works then.
The tool editor in Settings also tells where each list comes from, and it has **Refresh
list**. A draft and the **Continue in new terminal** dialog show only the error of a
failed list. A refresh also updates each other
model menu of the type that is in view. A chosen model stays, also when the new list does
not have it. When two refreshes overlap, only the later one updates the menus.

The **Thinking effort** menus follow the type. For Codex, they list the efforts of the
chosen model and show its default, for example **Model default (Medium)**. Claude Code
has **CLI default** and `low`, `medium`, `high`, `xhigh`, and `max`. For Antigravity,
the menu lists the efforts of the chosen model and shows no default, because the
effort is part of the model ID. Code Puppy has no effort.

#### Limits of tool types and models

- The list commands run the [program](#tool-program) of the built-in tool of the type.
  Without a CLI path, the list needs the CLI on the PATH of the server.
- A browser waits 35 seconds for a model list, a little longer than the 30-second limit
  of a list command on the server.
- A built-in tool has no other options. A command with other options or a wrapper is a
  Custom tool, which has no model choice. Its command holds its model option.
- `codex debug models` is a debugging command of Codex 0.171.0. Other Codex versions
  can change its output.
- The built-in list of Claude Code is fixed in the bbflow release.
- The session records its startup command, with the options, in its start event. The
  toolbar shows only the tool name. A model change inside the agent, such as `/model`, is
  not recorded.

#### Preparation

The server copies defaults when it creates a preparation. Non-Git folders do not enable
the worktree default. A preparation stores its chosen tool name and command
independently of later preset changes, including deletion. Startup commands are edited
only in Settings. When the user selects a different tool, the server copies its current
name, type, and command. Shell clears the command. The view then selects the default
model and effort of the tool.

**Session name** has its own row. Below it, one group holds **Tool**, **Model**, and
**Thinking effort** in a row. A line above and below the group separates it from the
other fields. **Model** and **Thinking effort** are hidden for Shell and for a Custom
tool. A change of the model or the effort applies only to the draft. The draft shows no notes about the model list or the options. Settings shows
them. Only a failed model list shows its error in the draft, with **Refresh list**. At
the end of the group, **bbflow submits** shows the command with its options. For a newly
selected tool, it shows the command of that tool at once, also before the save. For
Shell, it shows **(no startup command)**.

The preparation keeps its project and workspace. Message drafts and attachments work
before a run exists. Each project supports multiple independent drafts. Each draft
keeps its own name, tool snapshot, worktree choices, message text, and attachments
across views and server restarts. **＋** always creates a new draft.

A reopened sidebar entry keeps its choices and message. Launch settings use optimistic
revisions, separately from message revisions. A launch settings conflict preserves the
local edits and reports an error. Message drafts sync between views, as described in
[Message editor](#message-editor). Unsent edits warn before unload.

#### Start

Start claims the saved revision before creating files or a process. Duplicate starts and
edits to an already claimed preparation fail. Reopening or reconnecting never resubmits
the startup command. Failed preflight checks keep the preparation editable.

The server preserves an uncertain checkout or launch and marks it interrupted. It does
not retry automatically, including after server restart. Start creates an interactive
shell and records the configured command as input before writing it once to the PTY. The
shell remains after an ordinary command exits. Shell startup files that read or discard
stdin can affect queued input. bbflow does not detect prompt readiness or retry this
input.

#### Managed worktrees

The server uses the installed Git executable to detect repositories, including linked
worktrees and repository subfolders. Creating a worktree requires an existing commit.
Repositories and bases containing submodules are rejected.

#### Base and fetch

- The chosen base (default HEAD) resolves to a commit at Start.
- If the base names a remote-tracking branch, such as `origin/main`, Start first
  fetches only that branch from its remote. Thus the checkout starts from the current
  remote commit, not from the last fetch.
- A branch that is on the remote but was not fetched before also works if a fetch
  refspec maps it.
- A single-branch clone maps only its branch, so Start fails early for other branches,
  and the error names the tracking ref.
- bbflow does not add tracking refs that the repository does not map. To map a branch,
  add a fetch refspec, for example with `git remote set-branches --add origin feature`.
  A negative refspec still excludes the branch.
- HEAD, local branches, tags, commit IDs, and expressions such as `origin/main~1`
  resolve locally without a fetch.

The configured `remote.<name>.fetch` refspecs of the repository select the remote branch
that a tracking ref copies. For example, with the refspec
`+refs/heads/main:refs/remotes/origin/stable`, the base `origin/stable` fetches the
remote `main`. The most specific destination wins. Negative refspecs exclude a branch.

The fetch updates only the selected tracking ref. Other matching refspecs, local
branches, tags, and `FETCH_HEAD` do not change. If no refspec maps to an existing
tracking ref, or two remotes map it equally, bbflow does not fetch. The launch then
uses the local ref and shows a start warning.

The fetch runs before the launch lock, so a slow remote does not delay other launches.
It stops after 15 seconds. The server then stops Git and its transport helpers, such as
`ssh`. Server stop does the same. Until the session message, the starting view gets a
`running` status every 5 seconds, so that the browser does not end the wait.

Git runs without a terminal and without askpass programs, so it shows no credential
prompts. bbflow sets `GIT_ASKPASS=false` and `SSH_ASKPASS_REQUIRE=never`. Credential
helpers and SSH agents still work. A remote that needs a typed password or passphrase
fails.

If the fetch fails and a local copy of the branch exists, the launch uses that copy. The
view that started the session then shows a start warning with the Git error and the
commit of the worktree record. See [page messages](#page-messages). bbflow does not
record this warning. If no local copy exists, Start fails and the preparation stays
editable.

#### Checkout

bbflow creates a fresh branch (user-named or generated as bbflow/TIMESTAMP-SUFFIX) and
checkout under `<instance>/worktrees/YYYYMMDD-HHMMSS-XXXXXXXX`, using UTC and a random
suffix. Repository subfolder projects launch in the corresponding subfolder. Missing or
escaping subfolders fail the launch and preserve the checkout for inspection and
explicit cleanup.

SQLite records the checkout path, repository, requested base, resolved commit, creation
branch, and lifecycle state. Sessions retain their actual launch paths. The session
header shows the creation branch and launch path. After removal, **(worktree removed)**
follows the path, and the tooltip shows the creation branch.

Only committed files are checked out. Uncommitted changes, untracked/ignored files,
dependencies, and local environment files are not copied. Worktree files remain outside
SQLite and outside the planned database backup. Git worktrees share repository metadata.
They provide independent working files. They are not a security sandbox.

#### Worktree removal

Closing views, stopping sessions, and removing projects preserve worktrees. **Remove
worktree** checks all live bbflow session paths and refuses active or overlapping
workspaces. It also refuses detached HEADs, replaced repositories, and modified,
untracked, or ignored files, and uses Git removal without force. It preserves the branch
and all session history.

External processes and concurrent edits outside bbflow are not coordinated. Git manages
its locks and linked-worktree metadata. Missing or moved repositories cause explicit
errors.

### Usage limits

**Usage** in the bottom row of the sidebar opens a dialog with the usage limits of the
agent tools. For each limit of the plan of the account, the dialog shows the part that
is left and the reset time. The server asks each agent CLI. A check starts no agent turn
and sends no history.

#### Usage dialog

- The dialog has one section for each built-in tool that has a check and is on:
  **Codex**, **Claude Code**, and **Antigravity**, sorted by name. Shell, Code Puppy,
  and custom tools have no check. Without such a tool, the dialog tells the user to turn
  one on in Settings.
- Each section has a row for each limit. A row shows the name of the limit, a bar, the
  part that is left, and the reset time. An example is **5-hour**, **62% left**, and
  **Resets 6:32 AM · in 3 h 52 min**.
- A reset on another day names the weekday. A reset 6 or more days away names the date.
- The bar is green. With less than 20% left, the bar and the value are amber. With
  nothing left, they are red.
- A limit for one model names the model, such as **Weekly (Fable)**. Antigravity shows
  a heading for each model group, such as **Gemini Models**.
- The head of a section shows the plan when the CLI tells it, such as **PLUS**. It also
  shows the time of the check, such as **Checked 10:41 AM**.
- The dialog reads the settings when it opens. Then it sends one `tool-usage` request
  for each tool, all at the same time. Each section shows **Checking…** until its
  answer.
- **Check now** asks each CLI again. While a check of the dialog runs, the button shows
  **Checking…** and is off. The old values stay, dimmed, until the new answer.
- A failed check shows its error. When the server has a report from an earlier check,
  the section shows that report with a warning. The warning names the time of the report
  and the error.
- **Close**, **✕**, and Escape close the dialog. An answer after the close changes
  nothing.
- The times do not change while the dialog stays open. A new open or **Check now** shows
  new times.

#### Checks of each CLI

The server runs the [program](#tool-program) of the built-in tool in the shell of the
server, in an empty temporary folder:

| Type | Command | Output |
| --- | --- | --- |
| Codex | `codex app-server`. Standard input gets the JSON-RPC requests `initialize`, `initialized`, and `account/rateLimits/read`. | The JSON reply of `account/rateLimits/read`: the used percent, the length, and the reset time of each window, and the plan. |
| Claude Code | `claude -p /usage --no-session-persistence` | Text. bbflow reads the lines that start with `Current session` and `Current week`. |
| Antigravity | `agy -p /usage --output-format json` | JSON: the model groups, and the remaining part and the reset time of each limit. |

- Codex exits at the end of its input without the answer of a pending request. Thus
  standard input stays open until the reply line arrives. Then bbflow closes standard
  input. If the process still runs 2 seconds later, bbflow stops its process group.
- A Codex window of 300 minutes is **5-hour**. A window of 10,080 minutes is
  **Weekly**. Another length gets a name such as **8-hour**.
- The **Current session** line of Claude Code is **5-hour**. Each **Current week** line
  is **Weekly**. A line for one model, such as `Current week (Fable)`, names the model.
- The windows `5h` and `weekly` of Antigravity are **5-hour** and **Weekly**, in this
  order. Another window of Antigravity keeps its name.
- A model group of Antigravity without limits does not show. An output without any limit
  is an error, as for the other CLIs.
- Claude Code prints its reset times without a year, such as `Nov 25 at 4:49am
  (America/Los_Angeles)`. bbflow uses the first such time after one day ago. A time
  without a date is today. It is tomorrow when it is more than an hour ago.
- A line that starts with `Current ` in another format is an error. Thus a change of the
  output cannot hide a limit or show a guessed number.
- A check fails after 20 seconds. The browser waits 25 seconds for the reply.

#### Cache of the server

- The server keeps the last check of each type in memory. A server restart forgets it.
  A check is not history, so it is not in SQLite.
- A request without `refresh` gets the last check when it is less than 1 minute old.
  Otherwise the request runs a new check.
- One check of a type runs at a time. A request that waits for the check of another
  request gets the result of that check.
- A failed check keeps the last report. The reply then has the report, its time, and the
  error.
- A failed check counts as a check. Thus a request without `refresh` does not run it
  again within 1 minute.
- A change of the program, such as a new CLI path, forgets the last check of the type.
- A disconnect stops the command and saves nothing.
- `tool-usage` rejects a type without a check, and a type whose built-in tool is off.

#### Limits

- The checks were verified with Codex 0.172.0, Claude Code 2.1.332, and agy 1.5.17.
  `codex app-server` is an experimental interface of Codex. The output of `claude -p
  /usage` is text for people. Other versions can change either output. A changed output
  shows as an error.
- bbflow reads only the default limit of Codex, `rateLimits`. It ignores the other limit
  IDs of the reply.
- An account without plan limits, such as a login with an API key, shows the error of
  the CLI.
- A check uses the installation, authentication, and account of the user. The CLI sends
  its own request to its provider. bbflow adds no history, message, or file to it.
- When Claude Code cannot read its limits, it can show the last values that it read in
  the past 60 minutes. The dialog then shows those values with the time of the bbflow
  check.
- The dialog shows only the built-in tools. A custom tool that starts an agent CLI has no
  check.

### Session status

Each session shows one status. The server derives it. SQLite keeps the run status and
the preparation state without change, so `bbflow query` results do not change.

| Status | Meaning |
| --- | --- |
| `draft` | The session did not start. |
| `running` | The live terminal had application output in the last 10 seconds. Worktree creation and process start also show as `running`. |
| `idle` | The live terminal had no application output in the last 10 seconds. |
| `ended` | No terminal is live. The latest run `exited`, `stopped`, `failed`, or was `interrupted`. |

#### Activity detection

The server records the time of the latest application output of each live terminal in
memory. It does this without views too. The detection does not depend on the tool.

Application output is output that changes what a view shows. The server compares its
terminal screen before and after each output. A change of a character, a color, or a
style of a screen cell counts. The server compares the rows that it draws for a view, so
another SGR form of the same color is not a change. New rows in history count too. A cursor move, a title, an
input mode, a bell, or a terminal query alone does not count. Thus an agent CLI that
redraws an unchanged screen while it waits does not show `running`.

Output in the 300 milliseconds after an input, a PTY size change, or a signal from a
view does not count either. Thus the echo of typed input and the redraw after a size
change do not make a session `running`. A view that joins or reconnects sends its size
again. The PTY ignores an unchanged size, so that size does not hide the output that
follows.

The archive marks output that does not count as a quiet event. See
[session list order](#session-list-order).

`idle` means only that there was no recent application output. The application can be
complete, can wait for an answer or a permission, or can work without a change on the
screen. A spinner, a clock, or other output that changes the screen shows as `running`,
even without progress. The same row written again and again adds history rows, so it
shows as `running` too. No completion, readiness, or message boundaries are inferred
from silence. bbflow never sends input because of a status.

#### Status in the sidebar

Each sidebar row has one line: a status icon, then the title. Standalone sessions add
their workspace on a second line. A top-level row in **Pinned** adds the name of its
project, or its workspace without a saved project. The icon has a different shape for each status:

| Icon | Status |
| --- | --- |
| A green dot with a slow pulse | `running`. With the reduced motion setting, the dot does not move. |
| A green ring | `idle` |
| A gray dashed ring | `draft` |
| A gray dot | `ended`, after an exit or a stop |
| An amber dot | `ended`, when the latest run `failed` or was `interrupted` |

The sidebar shows the status with these rules:

- The tooltip of the icon gives the status text, for example **Idle: live, with no
  screen change in the last 10 seconds** or **Ended · stopped**. It adds **Archived**, the
  view count, and the place of a sub-session.
- The tooltip of the row adds the same text to the title, workspace, ID, and update
  time.
- A label for screen readers gives the short status, for example **idle, 1 view**.
- Each page keeps one `status-watch` stream open. The server pushes the statuses of all
  live terminals on it, at most 200 milliseconds after a change. Thus the sidebar shows
  brief activity of each session, even without a view of that session.
- The `session-list` refresh every five seconds supplies all other session data. It
  also supplies the statuses while the watch reconnects.
- When a terminal starts or ends, the page reads the list at once.
- A status change updates the icon, the tooltips, and the label of a session button in
  place. The button stays, so the keyboard focus stays on it.
- Other list changes replace the buttons of the list. The page then moves the keyboard
  focus to the new button of the same session or project control.

#### Status in the session header

The session header shows **Running**, **Idle**, or **Ended**. A live view gets each
status change on its terminal stream. An ended session adds the reason. The `exit`
message carries the recorded run status, so each view shows the same reason:
**Ended · exit 0** for a normal exit with its code, and **Ended · stopped** or
**Ended · failed** for the other ends. A saved terminal shows the stored run status, for
example **Ended · interrupted**.

The `exit` message also carries the run ID. A view shows the reason from an `exit`
message only while that run is the latest run. After another view starts and ends a
later terminal, each view shows the stored status of the later run.

#### Session toolbar

- The session toolbar shows the status next to the session title.
- Below the title, a line shows the tool of the shown terminal, the worktree branch,
  and the workspace path, for example `Codex · ⑂ feature · /path/to/workspace`.
- Each terminal records its own tool, so the line changes when a view shows an earlier
  terminal with another tool. A draft shows only its path.
- Until the terminal list loads, or when it cannot load, the line shows no tool. A
  start or a continue clears the list of the view, so the line shows no tool until the
  list with the new terminal arrives.
- The toolbar does not show the startup command. The shell usually echoes it at the top
  of the terminal, and the start event records it.
- At the right, a search icon opens **Search history**. Four icons show the Messages,
  Changes, Files, and Terminal views of the workspace pane.
- When the session ends, **Continue in new terminal** shows to the left of the icons in
  the latest terminal view.
- **Stop session** is in the [More actions menu](#more-actions-menu), not in the
  toolbar.
- During worktree creation, the session shows `running` before a terminal exists.
- Each toolbar icon and text button shows a tooltip on hover and on keyboard focus. The
  tooltip of an icon gives its name and its keyboard shortcut. Each icon also has an
  accessible name.
- A long title or workspace path shortens before the actions wrap.
- The [mobile layout](#mobile-layout) has a shorter toolbar.

#### Hint below the terminal

A hint below the terminal shows only when the view cannot send input. This occurs when
the process ended, when the view shows an earlier terminal, or when the connection is
lost. A view of the live terminal has no hint. A lost connection of a live terminal
also shows the reason, and **Reconnect** shows next to the hint.

#### More actions menu

**More actions** (⋯) opens a menu that lists only the actions that apply:

- **Rename** shows for started sessions. The field shows the user title, or the derived
  title as a placeholder. An empty field removes the user title.
- **Copy session ID** copies the ID of a started session to the clipboard. The menu
  button then shows **Session ID copied** for a short time.
- **New sub-session** shows for a session that is not archived and has a saved project.
  See [session families](#session-families).
- **Pin** shows for a top-level session that is not archived. It changes to **Unpin**
  for a pinned session. See [pinned sessions](#pinned-sessions).
- **Archive** shows for `draft` and `ended` sessions. It changes to **Restore** for an
  archived session.
- **Remove worktree** shows for a session that is not live and has a managed worktree.
- **Stop session** shows when you view the live terminal. It stops the terminal of the
  session for every view. It is the last item, away from the toolbar icons. Thus a
  missed click on an icon cannot stop a session. When the server reports that it
  stopped no terminal, the hint below the terminal says so, and the status stays as is.
- In the [mobile layout](#mobile-layout), **Continue in new terminal** shows at the top
  of the menu, with the rules of the toolbar button.

The menu button does not show when no action applies. A choice, Escape, or a click
outside the menu closes it. The Up and Down arrow keys move between the items that are
on. Tab or Shift+Tab closes the menu and moves the focus to the control after or before
the menu button. After a choice, the focus is on the menu button. A dialog that the
choice opens returns the focus to that button when it closes.

The terminal selector shows the stored status of each run, where `running` means a live
process.

#### Limits

- The session status uses the times of screen changes only. It cannot tell a completed
  task from a permission question. It shows `idle` for a command that works without a
  change on the screen.
- An application that changes its screen while it waits shows as `running`.
- The server compares the screen after each read from the PTY. An application frame can
  arrive in two reads. Then the first part can change the screen and count, even when
  the whole frame changes nothing.
- Typed input at short intervals for more than 10 seconds can show `idle` while the
  application works.
- While the status watch reconnects, the sidebar can show a status change up to five
  seconds late.
- A start screen that an application draws in the 300 milliseconds after its command
  does not show `running`.
- The 10 second and 300 millisecond values are not verified with an agent that works on
  a task.

### Session titles

A session shows the title that the user set, or else a derived title. bbflow can also
make an automatic title from the first message. For this, the user selects a title tool
in Settings. The title tool runs once for each session, outside the session terminal.

#### Title fields

A session has two title fields. `sessions.title` holds the title that the user set in
the draft form or in **Rename**. It is empty when the user set no title.
`sessions.auto_title` holds a derived title. The UI shows the user title. Without it,
the UI shows the derived title. Search matches both fields.

Each launch writes the tool name and workspace basename to the derived title, also
under a user title. A rename to an empty title removes the user title, and the session
shows its derived title. Neither field ever changes the other.

Automatic titles apply only to sessions that start after the upgrade to format 10. An
older session keeps its title and has an empty derived title. The archive cannot show
which send was its first, so it never gets an automatic title, even after the user
clears its title.

#### Title tool setting

**Automatic titles** in Settings selects the title tool: None, Claude, Codex, Code
Puppy, Apple, or Custom. The settings JSON stores `titleTool` as `none`, `claude`,
`codex`, `code-puppy`, `apple`, or `custom`. None turns automatic titles off. This is
the default. `bbflow title-tool` selects and tests the title tool from the CLI. See
[title tool commands](COMMANDS.md#title-tool).

For a built-in tool, the settings JSON stores the choice, and for Claude, Codex, and
Code Puppy also `titleModel` and `titleEffort`. The server supplies the command, so a
later release can change it. See [Title models](#title-models). Custom runs the command in `titleCommand`.
This command stays saved when the user selects another tool, so a later selection of
Custom can use it again. Only Custom has a saved command.

#### Custom command

A custom command follows the rules of a tool startup command: one line, at most 1,000
bytes, and no control characters. It runs as a built-in command runs, with the same
request on standard input. It must print a line that starts with `bbflow-title:`. The
request asks the model for this line. A custom command does not get the limits of the
built-in commands, such as turned-off tools, hooks, and MCP servers. The user is
responsible for what it does. A command that reads the request with `"$(cat)"` puts the
message in the command arguments, where other programs on the Mac can read it.
Standard input does not do this.

#### Test before save

A change to a title tool other than None saves only after the tool passes a title test.
The server runs the tool once with the fixed sample message, as **Test** does. When the
tool gives a title, the server saves the tool and returns the title. For Custom, the
command saves together with the choice. A change to None saves at once, without a test.
Only the ID `none` turns automatic titles off. An empty ID is an error. A change to the
saved tool tests that tool again and saves it again. When the client disconnects during
the test, the server stops the test and saves nothing.

When the test fails or times out, the server saves nothing. The error names the tool
that is saved after the test, because another change can save during the test. It also
gives the reason:

- `Codex is not configured. The title tool is still None. The test failed: …` for a
  change to another tool.
- `Codex is still the title tool, but its test failed: …` for a new test of the saved
  tool.
- `Custom is not configured with the new command. The title tool is still Custom, with
  its saved command. The test failed: …` for a new custom command that replaces a
  saved one.

A passed test saves only when the title tool and the custom command are the same as at
the start of the test. Otherwise another change of the title tool saved during the test.
Then the server saves nothing, so a test that ends late cannot undo a later change, for
example a change to None. The error is, for example, `Custom did not save, because
another change selected None during the test`. A change of another setting during the
test does not block the save.

Each test and each change of Custom needs its command. The UI and the CLI send the
custom command that they show. Thus a test runs the command that the user sees, even
after another client saves another custom command.

The test runs in the server environment, as the title runs of sessions do. Thus a CLI
that works in a terminal of the user, but is not on the PATH of the server, fails the
test. The test holds no lock, so other settings can save while it runs. A passed test
does not prevent later failures, for example after a sign-out, a CLI update, or a macOS
update that needs a new `fm` license acceptance. These later failures go only to
`server.log`. **Test** and `bbflow title-tool test` check the saved tool again.

Only `title-tool-set` changes the title tool and the custom command. `settings-save`
keeps both. A title tool change gives the settings a new revision, so a save from an
earlier revision fails.

#### Title controls in Settings

- In Settings, a selection of None, Apple, or Custom with a saved command in the tool
  list starts the change. A selection of Claude, Codex, or Code Puppy waits for **Save
  and test**. See [Title models](#title-models).
- A spinner shows after **Test** until the change ends. It also shows during a test
  that **Test** starts. The spinner does not turn when the system asks for reduced
  motion.
- The list, **Test**, and the custom command controls stay disabled during the change.
  The list shows the new tool, and the status shows **Saving…**.
- The result area shows the sample message and a line such as **Testing Codex. This can
  take up to 90 seconds.**
- After a passed test, a green line tells that the tool is configured, with the title
  from the sample message.
- After a failed test, the view reads the settings again, and the list shows the saved
  tool. A red line under it shows the error and tells the user to fix the problem and
  select the tool again.
- At the end of a test, focus goes back to the title controls only when focus is not in
  another field. Thus a test does not move focus out of a field that the user types in,
  and the blur does not save a partial value there.
- A reload or close of the page during the test cancels the change. The page asks for
  confirmation first.

A built-in tool and Custom have different controls:

- For a built-in tool, Settings shows the exact command from the server under the list.
  The test result does not repeat it.
- A list below the controls tells what the built-in tools need and where they send the
  message. It shows for each selection, so that the user can read it before a
  selection starts a test.
- A built-in tool has no edit action. To run another command, select Custom. The CLI
  also has no edit command for a built-in tool. Use
  `bbflow title-tool set custom COMMAND`.
- A selection of Custom with a saved command tests that command at once. Without a
  saved command, the field waits for a command, and **Save and test** starts the
  change.
- A custom command that fails its test stays in the field, so that the user can fix it.
- When Custom is not saved, the list also keeps Custom. When Custom is saved, the list
  shows it, and the failed command is an edit of the saved one. The status then shows
  **Not saved: Custom title command** until the field shows the saved command again or
  the edit saves.
- An edit in the field hides an earlier result.
- **Test** runs the saved custom command, so it does not show until the edit saves.
  Only **Save and test** shows then.
- When another change of the title tool saved during the test, the note under the error
  tells about that change, because the tool or the command can have no fault.

#### Title models

Claude, Codex, and Code Puppy have **Model** and **Thinking effort** below the title
tool list. They use the menus and model lists of
[Tool types and models](#tool-types-and-models). Apple and Custom have no model choice.

- A selection of one of these title tools shows its default model and effort, and
  **Save and test**. It saves nothing yet, and the status shows **Not saved: Title
  tool**. Thus the user can choose another model before the first test. The defaults
  are Haiku for Claude, Luna with low effort for Codex, and `codex-gpt-6-luna` for Code
  Puppy.
- A failed test of a selection keeps the selection, its model, and the error, so the
  user can choose another model and test again. The saved title tool stays. A selection
  or a model edit that is not saved goes when the user leaves Settings, also when its
  test ends later.
- A newer title model from another view replaces the shown model when this view has no
  edit of it.
- A change of the model or the effort does not save at once. **Save and test** shows,
  and the status shows **Not saved: Title model**. **Test** waits, because it runs the
  saved model.
- **Save and test** runs the title command with the new model. The model saves only
  after a passed test, and only while no other title change saved meanwhile. The save
  also needs the [CLI path](#tool-program) of the built-in tool that the test ran, so a
  change of that path during the test saves nothing.
- The command under the list shows the command with the chosen model.
- An empty model or effort adds no option, so the CLI uses its own default. For Codex,
  the title command ignores `config.toml`, so the CLI default is the default of Codex.
- The server builds each command from a fixed start, the options of the model and the
  effort, and a fixed end. The end reads the request, so the options cannot go at the
  end. Thus the user cannot add other options to a built-in title command.
- The start of each command is the [program](#tool-program) of its type, so the CLI
  path of the built-in tool also serves its title tool.
- After the page asks the server which CLIs it finds, the list marks a title tool
  without its CLI with **(not found)**.
- The upgrade to SQLite format 17 saves the model and the effort that the earlier
  command of the saved title tool had. So the command stays the same.
- Antigravity has no title tool. bbflow has not verified options that turn off its
  tools for one request.

#### Title tool in the CLI

In the CLI, `bbflow title-tool set` writes the tool name and its exact command to
standard error before the test. It waits 100 seconds for the reply, longer than the
90-second server limit. After a passed test, it prints that the tool is configured, with
the title from the sample message. After a failed test, it prints the error and exits
with status 1. An interrupt of the command cancels the test, and the tool does not save.
`set custom` without a command sends the saved custom command, and it fails when no
custom command is saved. An empty tool and an empty custom command are errors. They do
not change the settings.

#### Built-in commands

The server owns the command of each built-in title tool. Users cannot edit these
commands. The table shows each command with its default model and effort. Another
model replaces the model and effort options. See [Title models](#title-models).

| Title tool | Command |
| --- | --- |
| Claude | `claude -p --model haiku --restricted --tools "" --strict-mcp-config` |
| Codex | `codex exec --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --disable shell_tool --disable unified_exec --disable view_image --disable code_mode_host --disable apps --disable plugins --disable hooks --disable multi_agent --disable browser_use --disable computer_use --disable image_generation --disable mentions_v2 -c web_search=disabled --model gpt-6-luna -c model_reasoning_effort=low -` |
| Code Puppy | `code-puppy --no-tools --model codex-gpt-6-luna -p "$(cat)"` |
| Apple | `/usr/bin/fm respond --model system --guardrails permissive-content-transformations --greedy --no-stream` |

By default, Claude uses Haiku, and Codex and Code Puppy use Luna. Apple uses the on-device Apple
Foundation Model. Settings shows the command of the selected tool. Each command gives
the model only the request text:

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
- Apple: `/usr/bin/fm` is the Apple Foundation Models CLI of macOS 27. It needs a Mac
  with Apple silicon and Apple Intelligence.
  - The command uses this full path, so no other program named `fm` on the PATH of the
    server gets the message. The command also works when the PATH of the server does
    not include `/usr/bin`.
  - Without a prompt argument, `fm` reads the prompt from standard input.
  - `--model system` selects the on-device model, so the request stays on the Mac.
  - The command adds no image, tool, or transcript, so the model gets only the request
    text.
  - The `permissive-content-transformations` guardrail level is for a summary or other
    change of supplied text. Coding text can still trigger the safety guardrails.
  - `--greedy` gives the same title for the same message. `--no-stream` prints the
    answer once.
  - `fm` runs only after an administrator accepts its terms with
    `sudo /usr/bin/fm license`. Until then, it ends with exit status 69. The terms can
    change with a macOS update, and then need a new acceptance.

The empty temporary folder alone is not a file access limit, because an absolute path
or `~` reaches other folders.

#### First message

- The title command runs once, after the terminal accepts the first send with text from
  the message editor.
- The editor saves a pending draft revision before it writes to the terminal. It sends
  the input with the ID `draft-REVISION`, where `REVISION` is that pending revision.
- The server records the input bytes and writes them to the PTY. After the PTY accepts
  them, the server reads that revision.
- The input ID comes from the browser, so the accepted bytes must be exactly the input
  that the editor writes for the revision: the text, then each attachment path in
  single quotes on its own line, with line breaks as carriage returns, in a bracketed
  paste or not, and a final carriage return.
- Thus only text that reached the terminal goes to the title provider.

The archive records the first message as a `title` event:

- The first such verified send with text records a `title` event in the archive, on the
  PTY receipt and in the order that the PTY accepts input. Its data holds the draft
  revision, the selected title tool, and `requested`.
- The event is recorded also when the send starts no request, because the tool is None
  or the session has a user title. So a later send never becomes the first message, even
  after the user selects a title tool or removes a user title.
- One statement checks that the session has no `title` event and inserts it. Thus each
  session gets at most one title request, even after a server restart, a lost receipt in
  the browser, or an unlocked draft.
- Only the command runs later, in a job. A failed request does not run again.
- The command does not run for autosaves, sends without a receipt, attachments without
  text, or terminal input from the keyboard.

#### Command run

The server runs the command with `$SHELL -c`, or `/bin/sh -c` when `$SHELL` is unset. It
uses the server environment. The shell is not interactive, so it does not read
interactive startup files. The command runs in a new empty temporary folder, so agent
CLIs do not read project files. It is not a session terminal, and the archive records
no events for it.

#### Request text

- Standard input holds a fixed instruction and the message text.
- The server removes terminal escape sequences from the text and cuts it at 2,000
  bytes.
- It replaces each `/` with `∕` (U+2215) and each `~` with `∼` (U+223C). Thus no path,
  home reference, or link in the request names a file. The server changes these
  characters back in the title.
- Message text never enters the command line that bbflow writes. Code Puppy takes the
  prompt only as an argument, so its command reads standard input with `"$(cat)"`. The
  shell does not parse the text again.
- The request starts with plain text, so a CLI does not treat it as a `!` or `/`
  command.

The instruction asks the model for one line that starts with `bbflow-title:`. The
instruction describes this marker but does not contain it. The server breaks each
marker in the message text, for example `bbflow-title :`. It does this after it removes
the escape sequences, because the answer parser also removes them. Thus a CLI that
prints the request back prints no marker.

#### Answer

The server reads up to 64 KiB of standard output. It uses the last line that starts
with the marker, after Markdown marks and spaces. The server rejects output without
such a line, also one line of text, because agent CLIs can print status lines and errors
on standard output with exit status 0. It removes terminal escape sequences, such as
colors, control characters, `Title:` labels, Markdown marks, quotes, and a final
period. It keeps at most 200 characters.

#### Failures of a title command

- The server stops the command process group after 90 seconds or at server stop.
- A nonzero exit, a timeout, or empty output keeps the current title.
- Exit status 127 reports that the CLI is not installed or not on the PATH of the
  server.
- The server writes the error and the first 4 KiB of standard error to `server.log`,
  without terminal escape sequences.
- Server stop waits for title commands before the archive closes.
- A title command that is running at a server crash or restart is lost. The server does
  not run it again.

After each title change, the status watch sends a new title revision. Each view then
reads the session list again.

#### Test button

- **Test** in Settings runs the saved title tool once. It does not show for None, or
  for a Custom that is not saved or has an edit. It is disabled while the list shows
  another tool that is not saved.
- Test and the tool list stay disabled until the test ends, even when another setting
  saves.
- A result shows only while its tool stays selected, even after another view changes the
  tool.
- The browser waits 100 seconds for the reply, longer than the 90-second server limit.
- It sends a fixed sample message, not a message of a session, and saves nothing. The
  server owns the sample message, and `title-tools` returns it with the built-in tools.
- The result shows the sample message first. Under it, a green line shows **Test
  passed** with the title from the sample message. A red line shows **Test failed**
  with the error.
- A change of the title tool replaces the result with the result of the change.

#### Data that leaves bbflow

Claude, Codex, and Code Puppy send the first message to their provider. They use the
installation and authentication of the user. Claude and Code Puppy can save each call in
their own history. Codex saves none. Apple keeps the message on the Mac. `fm respond`
saves a transcript only with `--save-transcript`, and the command does not use it.

Code Puppy prints status lines and the request before the answer. It prints request
errors on standard output with exit status 0. It also asks for `puppy_name` and
`owner_name` at each start until `puppy.cfg` has values. Complete this setup before you
select Code Puppy.

### Message editor

The message editor is a multiline editor below the terminal. **Send** writes the
message to the session terminal as one input. Each session has one saved draft, and all
views of the session show it. The **＋** menu attaches files and puts the handoff prompt
or a saved prompt at the cursor. The **Messages** view of the workspace pane lists the
sent messages.

#### Layout and size

The multiline composer stays visible below preparation and terminal views. A horizontal
divider with a centered grip resizes the terminal and editor after launch. Drag it with
a mouse or touch. Or focus it and use Up/Down to resize.

Use Home/End to reach the limits. Both panes keep a minimum height. Editor contents
scroll when needed. The editor size stays with the browser view across session switches
and resets on reload. Size changes use the existing terminal viewport updates.

The [mobile layout](#mobile-layout) has no divider. Its editor has the height of its
text. See [message editor in the mobile layout](#message-editor-in-the-mobile-layout).

A viewport change resizes the PTY only from the size owner view. Direct terminal
interaction remains available.

#### Action row

The editor has no visible label or help text. Its action row holds **＋**, the draft
status, and **Send ⌘↵**. The tooltips of these buttons explain them. The row wraps when
the editor is narrow, for example while the workspace pane is open. **Send** stays at
the right end of its line. A device without a pointer that hovers, such as a phone,
shows **Send** without the key symbols.

#### Add to message menu

**＋** opens the **Add to message** menu. The menu opens above the button, at its left
edge. It has these items, in this order:

| Item | Effect |
| --- | --- |
| **Attach files…** | Opens the file selection of the browser. See [Attachments](#attachments). |
| **Handoff prompt…** | Opens the dialog of the [handoff prompt](#handoff-prompt). The item shows only when the handoff folder of the session has its README. |
| Saved prompts | One item for each [saved prompt](#saved-prompts), in the saved order, below the label **Saved prompts**. A click puts the text of the prompt at the cursor. |
| **Manage prompts…** | Opens Settings at the **Prompts** card. |

- A saved prompt and the handoff prompt go into the editor at the cursor, or in place
  of the selected text. The rest of the draft and its files stay. The editor keeps its
  cursor while the menu has the focus. Without an earlier cursor, the text goes at the
  end of the draft.
- An insert is a normal edit. It saves as a draft and sends nothing. Command+Z or
  Ctrl+Z undoes it where the browser supports the `insertText` editing command.
- The item of a saved prompt shows the name and up to 120 characters of the text, on one
  line. Its tooltip shows up to 600 characters.
- The menu reads the saved prompts each time it opens, because another view can change
  them. Until the reply, it shows the prompts of the last read. Before the first reply,
  a note tells that the prompts load. A failed read keeps the earlier list.
- While a send may have reached the terminal, the draft is locked. Then **Attach
  files…** and the saved prompts are off, and a note tells why. **Handoff prompt…** and
  **Manage prompts…** stay on, so **Copy prompt** still works. An open menu follows each
  change of the lock, also a send from another view. When the focused item turns off,
  **Manage prompts…** gets the focus.
- When another view changes the order of the prompts, the focused prompt keeps the
  focus. When another view removes it, **Manage prompts…** gets the focus.
- Up and Down move between the items that are on. Escape and Tab close the menu, as does
  a click outside it.

#### Saved prompts

Saved prompts are global. They are part of the settings in SQLite, so every session,
view, and device shows the same list. The **Prompts** card of
[Settings](#settings-page) manages them:

- A table shows the **Name** and the start of the **Text** of each prompt. The text
  shows on two lines at most, with its lines joined. Each row has **Edit**, **↑**, **↓**, and **Remove**. The order of the table is the
  order of the ＋ menu.
- **＋ Add prompt** and **Edit** open one editor dialog with **Name** and **Text**.
  **Add prompt** or **Save** saves the entry. **Cancel** and Escape discard it. The
  fields do not save when they lose focus.
- The page checks the entry before the save. It shows a problem in the dialog and
  moves the focus to the field of the problem.
- An edit applies only the changed fields to the latest saved prompt, as an edit of a
  tool does. A name that another view saved first stops the save.
- **Remove** asks first, because a removal has no undo. Drafts and sent messages keep
  their text.
- The server removes the spaces around the name. The text keeps its spaces and lines.
  The editor changes each CR LF and CR to LF.

#### Limits of saved prompts

- At most 100 prompts can be saved. A name has 1 to 200 characters without control
  characters. Names are unique without regard to letter case. The text of a prompt has
  at most 16 KiB and at least one character that is not a space. It can have tabs and
  new lines, but no other control characters. The server rejects a save with another
  list and saves nothing.
- Send needs bracketed paste for a prompt with a new line or a tab, as for other
  multiline text.
- An open ＋ menu shows a prompt change of another view only after the reply of its
  read. A view reads the prompts again at the next open of the menu.

#### Send

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

#### Draft save and sync

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

#### Pending draft and receipt

Before submission the editor saves `pending: true`. An optional input ID requests an
`input-ack` after recording and PTY write. The browser clears the draft only after a
successful receipt. This does not confirm application acceptance. A lost receipt, failed
write, or reload during submission retains the draft without retrying it.

The user must check the terminal and explicitly unlock that draft before editing and
submitting again. Users can edit drafts before launch, while detached, or after the
process ends. Send is disabled in these states.

#### Sent messages

The **Messages** view of the [workspace pane](#workspace-pane) lists the sent messages
of the session. The oldest message is at the top and the newest is at the bottom. The
list opens scrolled to the bottom and shows the newest 20 messages. **Show older
messages** at the top loads 20 more and keeps the visible messages in place.

The `composer-sent` operation derives this list from the existing pending draft
revisions, so the list also includes sends from before this feature. Direct terminal
input is not listed. When the newest sent messages change, the list reads them again.
This applies to a send from any view and to the receipt of a send. It also applies to
a send with a lost receipt, because the archive then has the pending revision. The
list shows that message as **Not confirmed**.

Each message shows its time, text, and attached file names. **Sent** means that the
editor got an input receipt and then cleared the draft. **Not confirmed** means that
there was no receipt, or the user unlocked the draft. This status is derived. It does
not confirm that the application accepted the message.

A long message shows its first 8 lines, and the list is the only scroll area. **Show
more** below the text shows 16 more lines. Each later click shows double the lines of
the previous click. The button shows the number of hidden lines. When fewer than 4 lines
would stay hidden, all of the text shows. **Show less** returns to the first 8 lines.
When a click hides its button, the other button gets the keyboard focus. The line count
follows the current text wrap.

**Show in terminal** scrolls the shown terminal to the message. See
[Sent messages in the terminal](#sent-messages-in-the-terminal). The list marks the
message that the terminal view reads. When that message changes, the list scrolls it
into view.

In a session with several terminals, the list shows a heading above the messages of
each terminal. The heading names the terminal, its tool, its status, and its times. It
stays at the top of the list while the list shows the messages of its terminal. The
heading of the shown terminal has the label **Shown**. A message belongs to the
terminal that ran at its send time. Without such a terminal, the heading is **Unknown
terminal**.

The button of a message of another terminal names that terminal, for example **Show in
terminal 1**. Its tooltip says whether that terminal is the live terminal or a saved
final screen. A click opens that terminal, then scrolls it to the message. See
[Jump to another terminal](#jump-to-another-terminal).

The button is off for a message of the shown terminal that the terminal does not show.
After a failed read of the sent messages of the shown terminal, the button stays on, and
its tooltip says so. A click then reads the sent messages again. A change of the shown
terminal keeps the messages and the position of the list.

**Copy** puts the message text on the system clipboard. Users can then paste it into
any session. Copy does not include attachments or their file paths. It is not available
for a message without text. The list does not change the draft or send input.

#### Attachments

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

#### Limits

- Each session has one shared draft. Other views update after each save, about half a
  second after typing stops. They do not show each keystroke.
- When two views edit at the same time, the latest save wins. The earlier text then
  stays only in archived draft revisions. The draft does not merge edits from two
  views.

### Sent messages in the terminal

The view finds each sent message in the text of the session terminal. A bar above the
terminal names the message that the view reads. Buttons, keys, and the list of the sent
messages scroll the terminal to a message. The list can also open another terminal of
the session at a message. The browser derives the positions. The server, the protocol,
and the archive do not change.

#### Search of the terminal rows

The view reads the text rows of its terminal: the screen and the scrollback rows that
the view keeps. It searches these rows for the text that Send wrote for each message.
That text is the message, then each attached file path in single quotes.

- The search ignores spaces and line breaks. Thus it finds a message that the
  application wraps or indents.
- A message must start its row, after at most a prompt. A short prompt has at most 6
  characters without spaces, such as `> ` or `demo> `. A longer prompt must end with
  one of the characters `$ % # > ❯ › ➜ »`.
- A message must also end its row. At most 2 characters that are not letters or digits
  can follow it, such as a frame character.
- The search first looks for all of the text. Then it looks for the first line alone,
  because an application can show a long message in a shorter form. Last, it looks for
  the first 32 characters of the first line, without the rule for the row end. This
  last form needs at least 12 characters. Each count is without spaces.
- The search takes the messages from the newest to the oldest. It takes the last place
  of each message, above the place of the message after it. An application that draws
  its output again can leave earlier copies of a message in the scrollback, for example
  after a change of the terminal width. The last copy has the current output below it.
- The rules for the row start and the row end keep a quote of a message in running
  text from the search.
- A view of an [earlier terminal](#earlier-terminals) searches only the messages that
  were sent while that terminal ran.

The view searches again after new output, at most each 300 milliseconds. A search that
takes longer waits 10 times its own duration. A jump or a step searches first. Thus the
positions follow an application that draws its output again.

The view reads the sent messages in pages of 20, from the newest message. It keeps only
the messages of the terminal that it shows, at most 200. After the limit, a new message
replaces the oldest one.

- While the terminal shows the oldest message that the view keeps, the view reads the
  next older page.
- Messages of a later terminal can fill the newest pages. The view of an earlier
  terminal then reads older pages until it reaches the messages of its terminal. It
  reads at most 1,000 messages of the session for this.
- A message from before the start of the terminal ends the read.
- A send from this view, and a change of the shown terminal, read the newest page
  again.
- Each newer draft that the editor gets from another view also causes this read. A
  send saves a pending draft and then a clear draft, and the server gives a view only
  the latest draft. Thus a newer draft of any kind can follow a send. This also covers
  a draft watch that connects again. A save that the server rejects, because another
  view sent a message, causes the same read.
- A read that gives a different newest page tells the Messages view to read its list
  again. A read that arrives during another read causes one more read after it.
- The newest page continues the kept messages only when it reaches a message that the
  view read before. Otherwise the view starts again from that page and reads the older
  pages again. Thus more than 20 new messages leave no gap.

#### Message bar

The row above the terminal shows the message bar at its right end. The bar shows for
each session terminal, also for an ended session and an earlier terminal. Thus the
terminal keeps its height when the first message is sent. When the row cannot hold the
[terminal selector](#terminal-selector) and the bar, the bar goes to a second row below
the selector.

- The bar names the message that the view reads: the last found message at or above
  the top row of the view. Its label has the number of the message among the found
  messages, the count of the found messages, and the send time, for example
  `Message 3 of 9 · 14:02`. The tooltip of the label has the text of the message.
- When the top row is above the first found message, the label gives the count of the
  messages below. Without a found message, the label is **No sent message in this
  terminal**.
- A click on the label opens the **Messages** view of the workspace pane.
- **Earlier message** scrolls to the start of the message that the view reads. When
  the view is at that start, it scrolls to the message before it.
- **Later message** scrolls to the next message. After the last message, it scrolls to
  the latest output.
- **Latest output** scrolls to the end of the terminal.

A jump puts the row of the message at the top of the view. The row has a highlight for
1.2 seconds. Near the end of the output, the row cannot reach the top. The bar then
names the jump target until the view scrolls. After a scroll, the bar again names the
last found message at or above the top row.

In a narrow main area, the workspace pane can take the place of the session. A jump
from the **Messages** view then closes the pane and shows the session. A jump gives the
keyboard focus to the terminal, except on a device without a mouse or a trackpad.

#### Marks

Each found message has a mark at the left end of its first row and a mark in the scroll
bar of the terminal. The mark color follows the appearance. The scroll bar keeps its
width of 14 pixels, so the terminal keeps its columns.

#### Step keys

While the session terminal has the keyboard focus, Command+Up and Command+Down step to
the earlier and the later message. Ctrl+Shift+Up and Ctrl+Shift+Down do the same. The
view does not send these keys to the terminal. Ctrl+Up and Ctrl+Down remain available
to terminal programs.

#### Jump to another terminal

**Show in terminal** in the **Messages** view can name another terminal of the session,
for example **Show in terminal 1**. A click opens that terminal in the session view. The
view then scrolls to the message as it does for a jump in the shown terminal.

- First the view reads the [terminal list](#terminal-list) again, because another
  view can have started a terminal. The request then names the run of the terminal.
  Thus a newer terminal cannot take the place of that terminal. Without the list, an
  error toast says that the list is not available.
- An earlier terminal shows its saved final screen, with input and Send off. The latest
  terminal joins its live process. A view that names the latest terminal by its run is
  a view of the latest terminal.
- In a narrow main area, the view first closes the workspace pane. Thus the terminal
  opens at its shown size, and a later fit does not scroll it away from the message.
- The view waits until the terminal draws its first frame. It also waits until it reads
  the sent messages of that terminal, as described in
  [Search of the terminal rows](#search-of-the-terminal-rows). Then it searches the
  rows.
- When the search does not find the message, the view shows the terminal without a
  jump. An error toast says that the terminal does not show the message.
- When a read of the sent messages fails, the jump ends. An error toast gives the
  reason. A later read does not complete the jump that ended.
- After such a failure, **Show in terminal** of a message of the shown terminal stays
  on. A click reads the failed page again, the newest page or an older page. Then the
  view scrolls to the message. A second failure shows the error toast again.
- A change of the session or of the shown terminal cancels the wait. Another jump and a
  step also cancel it.
- A newer click stops an older click, also when the reply for the older click arrives
  later. A click during the open of an older click waits until that open ends. Then
  the older click stops before its scroll, and the newer click opens its terminal.
- A move in the shown terminal also stops an older click: **Show in terminal** on a
  message of the shown terminal, a bar button, or a step key. Another open of the
  session view, for example from the terminal selector, also stops it.

The bar buttons and the step keys stay in the shown terminal. They do not open another
terminal, because an earlier terminal turns off input and Send.

#### Limits

- A position is derived from the terminal text. An application that shows a message in
  a different form can give no position, or a position on a row with the same text.
- A response can repeat a message on a row of its own after a prompt character, for
  example as a quote with `>`. That row is below the message, so it takes the position.
- Text typed directly in the terminal has no position, because the list has only the
  messages from Send.
- A message whose rows are no longer in the scrollback of the view has no position. See
  [Terminal scrollback](#terminal-scrollback).
- The frames draw an alternate screen on the screen rows of the view, below the normal
  scrollback. The search reads these rows as it reads the other rows. An application
  that uses the alternate screen keeps its earlier output itself. Thus one of its
  messages has a position only while that screen shows the message.
- The message numbers count only the found messages. They change when the oldest
  message leaves the scrollback.
- A full frame scrolls the view to the latest output, for example after a change of the
  terminal width. The view does not keep its message.
- The view keeps at most 200 sent messages of the terminal that it shows. For an
  earlier terminal, it reads at most 1,000 messages of the session. A message beyond
  these limits has no position.
- The **Messages** view takes the terminal of a message from the send time and the
  start and end times of the terminals. A jump opens that terminal before the view can
  search its rows. When the terminal does not show the message, the view shows that
  terminal without a jump.

### Continue in a new terminal

After the latest terminal of a session ends, **Continue in new terminal** starts a new
terminal in the same session and workspace. First the server writes a read-only
handoff folder with the earlier terminals and messages. The user sends the handoff
prompt when the new agent is ready. bbflow sends no prompt by itself.

#### Button and dialog

A session can have several terminals, one after another. Each terminal is a run with its
own PTY, emulator, saved screen, and recording. **Continue in new terminal** appears
while you view the latest terminal of an unarchived session after that terminal ends
(`exited`, `stopped`, `failed`, or `interrupted`). A managed worktree needs the stored
state `ready` to enable the button. If the worktree state blocks the action, hover over
the button or use Tab to see the reason.

The dialog shows the session workspace, the tool group of a draft, the handoff prompt,
and a Copy button. The tool group has **Tool**, **Model**, and **Thinking effort** in one
row, then the **bbflow submits** line with the command. These fields work as in a
[draft](#preparation). A newly selected tool brings its default model and effort.
**Model** and **Thinking effort** are hidden for Shell and for a Custom tool.

The dialog selects the tool of the latest terminal, the last choice of the user. If that
tool is no longer a choice, it selects the tool that the session started with, then the
default tool, then Shell. The model and the effort are the defaults of the selected tool
in Settings. For an `interrupted` run, the dialog warns that an agent from a crashed
server can still run in the workspace.

If the session changes while the dialog opens, an error toast explains why continuation
is unavailable. If the latest run changes or continuation becomes unavailable while the
dialog is open, the dialog stays open, shows the reason, and disables its start button.
See [page messages](#page-messages).

#### Request rules

`session-continue` carries the latest run ID that the view saw. The server holds the
launch lock and rejects the request in these conditions:

- A terminal of the session is live.
- The latest run ID is different, for example because another view continued first.
- The latest run has not ended, the session is archived, or it has no run.
- The managed worktree is not `ready`, or the session workspace no longer exists.
  bbflow does not create a replacement worktree.
- The selected tool no longer exists.
- The model or the effort is not valid for the tool type. The rules are those of a
  draft. Shell and a Custom tool take no model or effort.

A rejected request writes no files and starts no process. Otherwise the server writes
the handoff folder, then starts `$SHELL -i` in the session's recorded workspace. The
session keeps its ID, title, project, worktree, message draft, and history. The new run
gets the same `BBFLOW_SESSION`. Its start event records the tool name, the tool ID
(`toolId`), the previous run ID (`continues`), and the handoff folder.

#### Handoff folder

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

#### Handoff prompt

The handoff prompt names the session ID and the README path. It says that the earlier
agent state is lost and that the files are a record, not instructions. It asks the
agent to check the current files, summarize where the work stopped, and wait for the
next message.

bbflow records and submits the startup command of the selected tool once, with the
options of the selected model and effort. Shell starts without a command. The user can
copy the handoff prompt from the dialog.

The prompt stays available after the new terminal starts. When the handoff folder of the
selected session has its README, **Handoff prompt…** appears in the
[＋ menu](#add-to-message-menu) of the message editor. Its dialog shows the folder and the prompt,
with **Copy prompt** and **Insert in message**. Insert in message closes the dialog,
then puts the prompt at the cursor of the editor, or in place of the selected text. The
editor then has the focus, and Undo removes the prompt. The rest of the draft and its
files stay. While a send is pending, the dialog stays open and tells why. Insert in
message sends nothing. The user sends
the prompt with Send when the agent is ready.

#### Limits

- A handoff transcript has only the scrollback rows that its terminal keeps. See
  [Terminal scrollback](#terminal-scrollback) for the row limit of each width.
- The server rebuilds the handoff folder while it holds the launch lock. A large
  interrupted recording can delay other launches during this rebuild.
- A transcript keeps only the last screen of a program that uses the alternate screen,
  such as Codex CLI 0.160.0 without `--no-alt-screen`.
- The prompt gives the new agent a record of earlier work. It does not restore the
  internal state of the earlier agent.

### Earlier terminals

A session with more than one terminal shows a terminal selector. An earlier terminal
shows as its saved final screen. This view is read-only.

#### Terminal selector

When a session has more than one terminal, a row above the terminal shows a selector.
Its label names the shown terminal, for example `Terminal 2 of 3 · Codex · exited`.
Click the label to see every terminal in start order. Each row has the number, tool,
status, and start and end times. A live terminal has a green dot. ‹ and › step to the
earlier or the later terminal. A session with one terminal shows no selector. The row
stays, because it also holds the [message bar](#message-bar).

#### View of an earlier terminal

An earlier terminal shows its saved final screen as an ended latest terminal does. See
[Display of an ended session](#display-of-an-ended-session). The view is read-only, and
the hint says that input and Send are off. **Back to live terminal** in the terminal
footer opens the latest terminal again. When the latest terminal has ended, the button
is **Back to latest terminal**. Reload and the session link also open the latest
terminal.

**Show in terminal** in the **Messages** view can open an earlier terminal at a sent
message. See [Jump to another terminal](#jump-to-another-terminal).

A view of an earlier terminal leaves the live process, its capture, and its views
active. Only views of the live terminal can change its size. The status badge applies to
the whole session. While you view an earlier terminal, the session toolbar hides
**Continue in new terminal**, and the More actions menu hides **Stop session**.

#### Terminal list

The UI reads the list with `session-terminals` when it opens a session, when a terminal
starts or exits, and when the selector opens. It also reads the list when the
`status-watch` stream reports that a terminal of the selected session started or ended,
for example in another view. The session list refresh, every five seconds, also causes a
read when the latest run of the selected session changed. Thus the view also finds a
terminal that started and ended between two status messages. A start or a continue first
clears the list of the view, because the list then lacks the new terminal. The selector
hides until the new list arrives.

A failed read keeps the list that the view has. Thus the selector and the buttons of
the **Messages** view stay. A view without a list shows no selector.

The tool name comes from the start event of each run. Start events from bbflow 0.0.4
and earlier have no tool, so the first run uses the tool of the preparation. A new
terminal has no run record until its process starts. Until then, the list ends with a
`starting` terminal without a run ID. The UI reads the list again every five seconds
until that terminal has a run.

Each start event also records the tool ID, and the list gives it as `toolId`. Shell has
the empty ID. The **Continue in new terminal** dialog uses this ID to select the tool of
the latest terminal. Start events from bbflow 0.0.23 and earlier have no tool ID. The
first run then uses the tool ID of the preparation, and a later run has no known ID.

A view of the saved screen of the latest terminal keeps that terminal when another view
starts a newer terminal. The view then shows its terminal as an earlier terminal, with
**Back to live terminal** or **Back to latest terminal**. Thus the selector label and
the message marks continue to match the screen. Each read after the read for the open
keeps the shown terminal this way. The read for the open does not, because the list
before it can lack the terminal that the server chose.

#### Limits

- The UI shows an earlier terminal only as its saved final screen, one terminal at a
  time. It cannot show two terminals side by side.
- The terminal list reads every start event of the session, so a long session makes the
  list slower to load.
- Search history can read matching output and bounded context from earlier terminals.
  Their saved transcripts remain available in the handoff folder, and `bbflow query`
  reads their original events.

### History search

**Search history** finds literal text in the recorded terminal output of one session,
one project, or all sessions. Each result shows a snippet, and a context pane shows the
text around it. The search reads the archive only. It does not change a session.

#### Dialog and scope

**Search history** opens a modal dialog with a result list and a context pane.
Command+Shift+F on macOS and Ctrl+Shift+F open the same dialog. Ctrl+F remains available
to terminal programs. The dialog does not send input, resize the PTY, or change
sessions. Closing it leaves recording and the active session connection running.

The selected session is the default scope. This scope includes all its earlier
terminals. **This project** uses current project membership. **All sessions** includes
standalone sessions and other projects. Every scope includes archived sessions. Without
a selected session, the dialog selects **All sessions** and waits for search text.
**Search this project** in the [project menu](#project-menu) selects **This project**
for that project.

#### Matching

Search matches literal text of 1–256 Unicode characters. It ignores case through simple
Unicode folding unless **Match case** is selected. It does not expand characters or
normalize Unicode. Wildcards, SQL syntax, and markup have no special meaning.

The history service uses parameterized SQLite reads on a separate read-only connection.
It streams existing `output` event text through bounded matching state for each run.
Matches can cross any number of event boundaries. They never cross terminals or
sessions. Original events remain unchanged. Format 7 supplies event indexes for
run-scoped reads. There is no full-text search index.

#### Results and pages

Results follow recording order, from oldest to newest. A match uses the event that
completes its text. Each result identifies its session, terminal number, recorded tool,
and time. Search and the terminal selector use the same tool-name fallback. For an older
first terminal without a recorded tool, they use the saved preparation. Other missing
names appear as **Tool not recorded**. The initial page has at most 20 results. **Show
more results** appends the next page below them.

The status says **results loaded** while more matches remain. Otherwise, it reports the
final count and hides that button.

#### Scan limits

The first page fixes the highest event sequence. Later pages and context reads use that
same cutoff, so new output does not move existing results. A new search includes later
output. Each page scans at most 32 MiB or 100,000 nonempty output events, with a
five-second deadline. Empty text does not consume the event limit.

Search reads fixed ranges of 4,096 event sequences in primary-key order. Project scope
cannot sort the whole project before returning its first row. Each completed range
advances the cursor, including ranges with only empty or out-of-scope events.

An incomplete scan can continue:

- A bounded scan returns its results, an `incomplete` flag, and a cursor for the next
  character when progress permits continuation.
- The status shows **Search incomplete**, and **Continue search** reads forward from
  that cursor.
- If the deadline permits no progress, search replaces continuation with **Retry
  search**. Retry keeps the attempted cursor and fixed recording cutoff.
- A changed query or scope starts a new search. It preserves the incomplete state and
  any results. An empty partial page remains incomplete.
- A later page restores bounded lookbehind per terminal, so split phrases and
  overlapping matches survive the boundary.
- Completed scans report the final count. Caller cancellation stops the request.

The service bounds matcher storage to 262,144 source positions. Evicted state is rebuilt
from recorded lookbehind. Requests allow at most 50 results. There is no result-offset
limit or rescan of the whole prefix. Large-archive performance remains unverified.

#### Snippets and context

- Each result includes a snippet with the complete match, up to 120 preceding
  characters, and up to 180 following characters across output events of the same
  terminal.
- Following-text and display reads share a separate one-second budget per page. A
  failed snippet read preserves the available text.
- Selecting a result loads its full initial context separately. A context error
  preserves the snippet and results.
- **Show more before** and **Show more after** add 512 characters on their respective
  side. Each side stops at 8,192 characters with an explicit limit label.
- Context reads skip empty text and stay within the selected run's output bounds and
  recording cutoff. They have a five-second timeout.
- Source references retain session, run, sequence, and character offsets.

#### Reads and cancellation

Each read caches metadata only for the runs it uses. First and last nonempty output and
the first start event use direct indexed lookups. Context and lookbehind queries use
those bounds. Search does not aggregate all events of a session. Terminal lists and
handoff run bounds use the same run indexes.

Changing the query or scope, closing the dialog, or selecting another result cancels
obsolete requests. The client closes their WebSockets. The server cancels their SQLite
work on disconnect and stops its disconnect reader after a reply.

#### Display of results

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

### Workspace pane

The workspace pane is to the right of the terminal and the message editor. It shows one
of four views:

- **Messages** lists the [sent messages](#sent-messages) of the session.
- **Changes** lists the changed files and shows their diffs.
- **Files** shows the workspace folder as a tree and the current files.
- **Terminal** shows the [side terminal](#side-terminal).

#### Pane controls

Each view has an icon in the session toolbar, after the search icon. The tooltips are
**Show messages**, **Show changes**, **Show files**, and **Show terminal**. A click on
an icon opens the pane with its view, or changes to its view. The icon of the shown
view is pressed. A click on it closes the pane. **×** in the header of each view also
closes the pane. Each view has a header with its name and only its own controls. In a
narrow main area, the [view switch](#view-switch) replaces the icons and **×**.

Drafts have no workspace pane. Ended sessions keep it while their workspace exists. A
drag on the divider or the Left and Right arrow keys change the pane width.

#### Pane width

The session keeps a width of at least 740 pixels, so that its terminal keeps about 80
columns. The pane keeps at least 420 pixels. That gives a file view about 50 characters
and the side terminal about 50 columns. When the window becomes narrower, the pane
becomes narrower first. When the window becomes wider again, the pane goes back to the
width that the user set. A drag cannot make the pane wider than the session allows.
When the main area is narrower than 1187 pixels, it cannot hold both minimum widths.
Then the open pane takes the place of the session, and the divider is not available.
See [view switch](#view-switch). With the sidebar at its default width, this applies
below a window width of 1484 pixels. A hidden sidebar gives its width to the main area.

#### View switch

When the main area cannot hold the session and the pane, a view switch shows below the
toolbar. It has five buttons: **Session**, **Messages**, **Changes**, **Files**, and
**Terminal**. The button of the shown view is pressed. The switch is in the center of
the main area. In the [mobile layout](#mobile-layout), it uses the full width.

- **Session** shows the terminal and the message editor of the session.
- The other buttons show a view of the pane in the full main area. A hidden session
  terminal stays connected and keeps its PTY size.
- A session can open while a view of its pane shows. Its hidden terminal then joins with
  its last shown size in the browser tab. Without that size, it uses the last shown size
  of another session terminal. Without any such size, it joins with 80 columns and 24
  rows.
- The switch replaces the four pane icons of the toolbar and **×** in the header of
  each view. The switch and the icons use the same [pane state](#pane-state). Thus a
  change of the window width keeps the shown view.
- The sidebar stays, except in the [mobile layout](#mobile-layout).
- Drafts, Settings, and the welcome view have no switch.

#### Pane state

Each session has its own open state and view in the browser tab. A session that the
browser tab has not shown yet starts with a closed pane. A session that you start from a
draft also starts with a closed pane. When you select a session again, its pane shows
the view that it showed before. The width belongs to the browser tab, and all sessions
use it. Other browser tabs keep their own state. A reload resets the open states, the
views, and the width.

### Changes pane

The Changes and Files views of the [workspace pane](#workspace-pane) show the files of
the session workspace. Both views are read-only. They never change files, the Git
index, or SQLite.

- **Changes** lists the changed files and shows each file as a diff. A scope menu
  selects the changes to show: all changes since the session base, the uncommitted
  changes, one commit, or a range of commits.
- **Files** shows the workspace folder as a tree, with the current content of each
  file.
- Both views show images, give a preview of Markdown files, and have a
  [file menu](#file-menu).
- In a folder that is not a Git repository, only **Files** works.

The sub-sections that follow give the exact rules.

#### View headers

- Each view has its own selected file and its own filter text.
- Only the Changes header has the scope button, **Split**, **Unified**, and the file
  count.
- The Files header has **Refresh** and **×** only.

#### Session base

- The session base is the recorded commit of a ready managed worktree.
- Other sessions use the merge base of `HEAD` and the default branch. The default
  branch is the target of `origin/HEAD`, or else `main`.
- A session has no base without such a branch, without a merge base, or when `HEAD` is
  the merge base.
- `HEAD` is the merge base when it has no commit that the default branch does not have,
  for example on `main` without local commits.
- Local commits on `main` that `origin/main` does not have, such as commits that are
  not pushed, get `origin/main` as their base.

#### Scope menu

- The scope button shows the selected changes. A click opens the scope menu. A click
  outside the menu, or Escape, closes it.
- The width of the button comes from the pane width and not from its label. Thus the
  other controls do not move when the label changes.
- **All changes** is at the top of the menu when the session has a base. It is the
  default when the session has a base.
- Below it, a timeline lists **Uncommitted changes** and the commits since the base,
  newest first.
- Each commit row shows its short ID, its subject, and the number of files that it
  changes in the session workspace. The tooltip has the full subject.
- A click on the text of a row shows only that change and closes the menu. The focus
  then goes to the scope button.
- When the focus is in the Changes view, `[` steps to the older row and `]` to the
  newer row. From a range or **All changes**, a step goes to its end in that direction.
  A field, such as the filter box, keeps the keys.
- The labels do not claim that one session made the changes, because other sessions and
  tools can share a workspace.

Each choice compares two sides:

| Choice | Old side | New side |
| --- | --- | --- |
| **All changes** | The session base. | The current files. Thus it includes the commits since the base and the uncommitted changes. |
| **Uncommitted changes** | `HEAD`. A repository without commits uses the empty tree. | The current files. |
| One commit | Its first parent. A root commit uses the empty tree. | Its own tree. |
| A range | The first parent of the oldest selected commit. | The newest selected commit, or the current files when the range has **Uncommitted changes**. |

A diff that ends at a commit has no untracked files. In it, **View file** shows the file
at that commit. Files always shows the current files.

#### Commit ranges

- Each row of the timeline also has a dot. Rails join the dots. The dots are for
  ranges.
- One selected row is highlighted, and its dot stays empty.
- A click on a dot selects its row and puts a ring on the dot.
- A click on a second dot selects all changes between the two dots. Their dots fill,
  and a thick line joins them.
- Before the second click, the pointer over a dot shows that range.
- A click on the same dot, or Escape, cancels the range.
- A range of every row stays a range. It can differ from **All changes**, for example
  when a commit merged the default branch.
- The menu stays open after a dot or **All changes**, so that the line stays in view.

#### Commit list

- The commit list follows the first parent from `HEAD`, up to 30 commits. It stops at
  the base. Without a base, it lists the latest commits of `HEAD`.
- A shallow clone does not have the parent of its last commit. The list omits that
  commit.
- The menu shows "Older commits are not listed." when the list omits commits, even when
  the list is empty.
- When a rebase or a reset removes a selected commit, or the session loses its base,
  the next refresh uses the default changes.
- When a file read finds this first, the pane reads the list again. If that read fails,
  the pane shows no file until a later refresh succeeds.
- A refresh cancels the file request of the earlier list, so a late file reply cannot
  change a newer choice.

#### Diff layout and colors

- **Split** shows the old and new file side by side. **Unified** shows one column with
  removed and added lines.
- When the editor area is narrower than 520 pixels, the pane shows Unified and marks it
  as pressed. Split keeps a dashed border until the pane is wide enough.
- Unchanged regions fold into bars. Click a bar to show its lines.
- Both layouts use green for added lines and red for removed lines. Stronger fills mark
  changed text.
- Split shows a gutter marker for each changed line. Unified shows one `−` per block of
  removed lines and one `+` per added line.
- Syntax colors, line numbers, and folded regions follow Appearance. The file view uses
  the same syntax colors.
- Markdown files use GitHub Flavored Markdown colors. Headings, links, code, and quotes
  have their own colors. Markup characters, such as `#` and `**`, are muted.
- A fenced code block gets the colors of its language when the first word of its info
  string names a language that the pane supports, such as `go`, `ts`, or `bash`.

#### File list of Changes

- The **Changes** view lists the changed files with Git status letters A, M, D, R, and
  T.
- An untracked file has A. After `git rm --cached`, the path has one row with M. An
  untracked nested repository shows as one folder row.
- The filter box matches any part of a path without case.
- A long path keeps its file name in view and shortens its folder.

#### Tree of Files

- The **Files** view shows the workspace folder as a tree. Click a folder to open or
  close it. The pane reads a folder when it opens.
- The tree puts folders first and sorts names without case. It omits `.git`.
- The tree includes the entries that Git ignores, in a muted color.
- A changed file shows its status letter. A folder with a change below it shows a dot.
  A deleted file is not in the tree.
- An open folder without entries shows "Empty folder".
- With text in the filter box, **Files** shows a list in place of the tree. The list has
  the paths that match, from the paths that Git tracks or does not ignore, and from the
  deleted files.

#### File view

- A file that you select in **Files** shows its current text. A file that you select in
  **Changes** opens as a diff. A symlink opens as a file with its target text.
- In Changes, the file header shows the path and the line counts. **View file** and
  **View diff** change between the current text and the diff.
- In Files, the file header shows the path only. For a changed file, **View diff**
  opens the diff of that file in the Changes view.
- In both views, a ⋯ button at the right end of the file header opens the
  [file menu](#file-menu).
- In a narrow pane, the line counts, **View source**, **View file**, and the ⋯ button
  go to a second row of the file header. The path and **Preview** keep at least 200
  pixels.
- The ⋯ button stays at the right end of the second row, so its tooltip opens to the
  left. The tooltip is at most 280 pixels wide, so it stays in a pane of 320 pixels,
  the width of a small phone.

#### Images

- PNG, JPEG, GIF, WebP, and SVG files show as images in both views. The server reads
  the raster format from the first bytes of the file, not from its extension.
- The file view shows one image. The diff shows the old and the new image. **Split**
  puts them side by side, and **Unified** puts the old image above the new image.
- An added file shows only its new image, and a deleted file only its old image.
- A text side without an image, for example the text side of a type change, shows its
  text in place of the image. Another side without an image shows a note.
- Each image fits in its side and never gets larger than its actual size. A click on an
  image shows all images at their actual size, with scroll bars when necessary. The
  next click fits them again.
- An SVG file without its own width and height has no actual size, so it fills its side
  in both cases.
- A checkerboard shows transparent pixels.
- A caption above each image shows **Old** or **New** in a diff, the format, the pixel
  size, and the file size. An SVG file shows no pixel size.
- An image that the browser cannot decode shows "The browser cannot show this image."
- Images show only in `img` elements, from `data:` URLs. There, an SVG file cannot run
  scripts or load other files. The page policy also allows images only from the page
  and from `data:` URLs.

SVG files have these additional rules:

- An SVG file shows as an image only when its root element is `svg` in the SVG
  namespace, `http://www.w3.org/2000/svg`.
- The XML parser of the browser reads the text, as for an `img` element, so the text
  must be well-formed XML. The parsed document stays detached, so it runs no scripts and
  loads no files.
- Other text in an SVG file, such as the pointer text of Git LFS or an `svg` element in
  a comment, shows as text.
- The old side of a rename uses its old path, so a rename from an SVG file to another
  file type shows the old image.
- **View source** shows the text of an SVG file, or the diff of its text. **View
  image** shows the image again.
- Next to a raster image or a side without text, such as a binary side, the SVG side
  shows its text in place of its image. The other side keeps its image or its note.
- The choice of **View source** applies to all SVG files in both views of the browser
  tab. A reload resets it.

#### Markdown preview

- For a Markdown file (`.md` or `.markdown`), **Preview** shows to the right of the
  path in both views.
- **Preview** opens a dialog with the file path, a close button (✕), and the rendered
  current text.
- The button is not shown for a deleted file, a binary file, a file above 1 MiB, or a
  symlink.
- The dialog keeps its text while it is open. Use **Refresh**, then **Preview** again,
  to see a later change.
- Preview uses markdown-it with CommonMark, GitHub tables, strikethrough, and task
  lists.
- Raw HTML shows as text.
- Images do not load. The dialog shows "Image not loaded" with the alternative text and
  the source.
- Task list checkboxes are disabled. In forced colors mode, they use the checkbox of
  the browser. An escaped marker, such as `\[x]` or `&#91;x]`, stays text.
- A fenced code block gets the syntax colors of the file view when the first word of
  its info string names a language that the pane supports. Other code blocks show as
  plain text.
- Only `http:`, `https:`, and `mailto:` links open, in a new tab. Other links, such as
  relative paths, show as text with the target in their tooltip.
- `javascript:`, `vbscript:`, `file:`, and most `data:` links stay Markdown source
  text.

#### File menu

The ⋯ button of the file header, **More file actions**, opens the file menu. It shows
when a file is selected, in Changes and in Files. The menu has these items:

| Item | Effect |
| --- | --- |
| **Copy path** | Copies the absolute path of the file. The page joins the workspace path of the session and the path of the file relative to that workspace. |
| **Copy relative path** | Copies the path relative to the workspace. This is the path that the file header shows. |
| **Show in Finder** | Asks the server to show the file in a Finder window. Finder selects the file and does not open it. |
| **Open in browser** | Asks the server to open the file in the default browser of the user. It shows only for an HTML file (`.html` or `.htm`). |

A line separates the copy items from the other items. The menu has the keys of the
[More actions](#session-status) menu.

**Show in Finder** and **Open in browser** have these rules:

- They show only for a current file that is in the workspace now. They are not shown
  for a deleted file, a symlink, or a diff that ends at a commit.
- They go away when Changes selects such a scope, before the file reply.
- The server also rejects a path through a symlink.
- For **Show in Finder**, the page sends `workspace-reveal`, which accepts the same
  paths as `workspace-open` without the HTML rule. On macOS, the server runs `open -R`
  with the absolute path.
- For **Open in browser**, the page sends `workspace-open`. The server asks macOS for
  the application that opens `https` links. Then it runs `open -a` with that browser and
  the file, so an editor that owns HTML files does not open the file.
- A file above 1 MiB can open in the browser.
- The browser loads the file from the disk as a `file:` page. Thus relative styles,
  images, and scripts load, and external scripts load too. To see a later change,
  reload the page in the browser.
- A `file:` page has an opaque origin. The server rejects its WebSocket connections, so
  a report cannot control bbflow.

The tooltip of the ⋯ button shows the result of a choice:

- After a choice, it shows **Path copied**, **Relative path copied**, **Shown in
  Finder**, or **Opened in browser** for 1.8 seconds.
- An error shows there for 6 seconds. It names the action, then gives the reason from
  the server or the browser, for example
  `Cannot show the file in Finder: exit status 1: …`.
- A screen reader reads the result from a status element.
- Only the result of the latest click shows. A change of the selected file or of the
  session ends the result at once. A reply that comes after such a change does not
  show.

#### File list width

- A vertical divider between the file list and the file view changes the list width.
  Changes and Files use the same width.
- Drag the divider with a mouse or touch. Or focus it and use Left/Right to resize. Use
  Home/End to reach the limits.
- A double-click restores the default width, 24% of the pane but at least 140 pixels.
- The list stays at least 140 pixels wide, and the file view keeps at least 280 pixels.
- In a narrower pane, the list gets narrower and keeps the selected width for a wider
  pane.

#### File list in a narrow pane

A view of Changes or Files that is narrower than 560 pixels cannot hold the list and a
file view of a usable width. It shows them one at a time, and the divider is not
available. The file view then has the full width of the pane.

- The view starts with the file list.
- A click on a file shows the file view in place of the list.
- **← Back** in the file header shows the list again and gives the focus to the row of
  the file.
- **View diff** from Files shows the diff of the file in Changes.
- A change between Changes and Files, or a change of the session, shows the list again.
  The two views have different lists.
- Session and Terminal keep the state of the view. A return to Changes or Files shows
  the same file view or list as before.
- A wider pane shows the list and the file view side by side again, with the same file.

This applies to a narrow pane next to the session and to the
[mobile layout](#mobile-layout). A pane that the [view switch](#view-switch) shows in a
main area of 560 pixels or more keeps the list and the file view side by side.

#### Refresh

- The pane reads its lists when it opens, on **Refresh**, on a change of the view, and
  when the window gets focus. It does not watch files.
- A refresh reads each open folder again. It closes a folder that is gone.
- A refresh keeps the shown file when its content is the same.
- Only the latest request for a folder changes its entries. A reply or a failure of an
  earlier request does nothing, even after the folder closes and opens again.
- The keyboard focus stays on its row when the list changes, so Tab moves from an opened
  folder to its entries.

A folder read can fail or reach a limit:

- The open folders of a refresh share the entry limit of one reply. When the limit cuts
  the list of a folder, the pane keeps the shown entries of that folder. It then reads
  the folder again in a request of its own.
- A failed request for one folder shows its error. A folder with shown entries stays
  open and keeps them. A folder that opened without entries closes.
- After a failure, a refresh continues with the other folders that need a request of
  their own. The pane keeps the first error of that refresh in view.
- When the request of the refresh fails, the pane reads each open folder that has no
  entries yet in a request of its own. Thus no folder stays on "Reading…" without a
  request.
- When the first read of the workspace folder fails, the tree shows "Cannot read this
  folder. Click Refresh to try again." in place of "Reading…".

#### Folders outside Git

- In a folder that is not a Git repository, the Changes view shows "Not a Git
  repository. Files shows the workspace." The scope button and the filter box are off
  there.
- Such a folder has no changes and no filter.
- The Files view shows the tree and the current files.
- When the server has no Git executable, Files works in the same way, and Changes shows
  the error.

#### Browser tab state

- The selected changes, the open folders, the filter text, and the selected file of
  each view belong to the browser tab. Other browser tabs keep their own state.
- A visit to Settings or the home page keeps this state. A different session or a
  reload resets it.
- The layout and the list width also belong to the browser tab. A different session
  keeps them. A reload resets them.

#### Server rules

The server finds the workspace and reads the files with these rules:

- The server resolves the workspace and the baseline commit from the session ID. It
  never accepts a workspace path from the client.
- A repository subfolder session sees only its own folder, with paths relative to it.
- The server reads current files through `os.Root`. `..`, absolute paths, and symlinks
  that leave the workspace are refused.
- A symlink shows its target text on both sides, as in Git, and is not followed.
  Special files are not opened.
- A folder list has a symlink as one entry. The server does not list a path that is a
  symlink or that goes through a symlink.

The server runs Git with these rules:

- Git runs with `GIT_OPTIONAL_LOCKS=0`, so it does not take `index.lock` from a live
  agent.
- Git also runs with literal pathspecs, `core.fsmonitor=false`, `--no-ext-diff`,
  `--no-textconv`, and a 10-second timeout.
- A client disconnect cancels the Git work, and the scan of untracked files stops at
  the file limit.
- Clean filters from the repository configuration, such as Git LFS, still run when Git
  compares work files.
- Git messages use the C locale. Only a "not a git repository" message from Git shows
  "Not a Git repository." Other failures, such as a missing Git executable or a
  `safe.directory` refusal, show their error.

The server gets the ignore marks of the tree with these rules:

- The server runs `git check-ignore` in each listed folder, so a submodule and a nested
  repository use their own ignore rules.
- This command does not support literal pathspecs. The server sends each name with a
  `./` prefix through standard input, so that Git reads it as a path.
- When this command fails, the tree shows the entries without ignore marks, and the
  pane shows the error.

#### Limits

| Item | Limit | Above the limit |
| --- | --- | --- |
| Text side of a file | 1 MiB | A note shows instead of its content. |
| Image side of a file | 5 MiB | A note shows instead of its content. |
| Changed list | 5,000 files | The list shows a note. |
| Filter list of **Files** | 20,000 paths | The list shows a note. |
| Entries in one reply of folder lists | 20,000 | The folder shows a note and an arbitrary part of its entries. |
| Folders in one request | 200 | A refresh closes the open folders above this number. |
| Reads for the line counts of untracked files, for each list | 32 MiB | Later untracked files show no count. |
| Commits in the commit list | 30 | The menu shows "Older commits are not listed." |

File content has these limits:

- An SVG file is text, so the limit of a text side applies to it.
- The limit of an image side lets two image sides in base64 fit in one 16 MiB protocol
  message.
- A side with a NUL byte in its first 8000 bytes, or with invalid UTF-8, is binary. A
  binary side that starts with the signature of a PNG, JPEG, GIF, or WebP file is an
  image.
- Text stays text, even when it starts like an image, so text above 1 MiB is too large.
- The pane shows a note instead of the content of other binary sides.
- Other image formats, such as AVIF, HEIC, TIFF, BMP, and ICO, show as binary files.
- An untracked file above 1 MiB has no line count. When its first 512 bytes are binary
  data with a PNG, JPEG, GIF, or WebP signature, it counts as binary.
- In a Git LFS repository, Git gives the LFS pointer text for a committed side. Then
  the diff shows that text in place of the old image.

The views have these limits:

- The pane shows one file at a time.
- The **Uncommitted changes** row has no file count.
- The filter of **Files** does not find ignored files.
- The tree has no arrow key navigation. Use Tab and Enter.
- Git detects a rename only between tracked files with similar content. An untracked
  new file and its deleted original show as two changes.

**Show in Finder** and **Open in browser** have these limits:

- They need the browser and the server on the same computer.
- Only macOS has these two openers now. On other systems, a click shows an error.
- **Open in browser** uses the default browser, which can be different from the browser
  of the bbflow tab.
- Browsers can block module scripts and `fetch()` in a `file:` page. A report that must
  work in all browsers keeps its scripts and data in the HTML file or in classic
  `<script>` files.
- bbflow does not confine the browser to the session workspace. A `file:` page can load
  any local file that the browser can read, for example as a style sheet or an image.
- The server checks the path, and then the browser reads the path again. A process that
  changes the path between these steps can make the browser show another file, also a
  file outside the workspace.
- The browser does not run the file as a program. By default, a script in a `file:`
  page cannot read another local file.

### Side terminal

The side terminal is a shell for ad hoc commands in the session workspace. It is the
Terminal view of the [workspace pane](#workspace-pane), so the session terminal keeps
its full height. Drafts have no side terminal. Ended sessions have one while their
workspace exists.

- When you click the terminal icon, the server starts `$SHELL -i` in the session
  workspace. When the session already has a live side terminal, the view joins it.
- Each session has at most one live side terminal. All views of a session share it.
- The server does not record the side terminal. SQLite has no events, run, or screen of
  it. Search history, the handoff folder, and `bbflow query` cannot read it. The view
  shows "Not recorded. Runs in the session workspace."
- The side terminal does not change the session status, the view count, or the session
  order.
- Type directly in the view. The message editor sends only to the session terminal.
- A finger drag scrolls the view. See
  [touch scroll in a terminal](#touch-scroll-in-a-terminal). The view keeps its PTY
  size while an [on-screen keyboard](#on-screen-keyboard) shows.
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

#### Limits

- The side terminal keeps its screen only in server memory.
- Its output is lost when it ends, and no history can read it.

## Terminal runtime

Each session terminal is a shell in its own PTY and process group. The server records
the input and output of a session terminal before it delivers or shows them. A closed
view never stops the work. A session terminal ends when its shell exits, on an explicit
stop, or when the server stops. The [side terminal](#side-terminal) is not recorded.

### Launch and recording

Before launching a shell, bbflow records its resolved command, arguments, workspace, and
terminal size. The server launches it in a new PTY and process group. Commands retain
their normal authentication, terminal interface, and permissions.

Input bytes are committed before PTY delivery. Output bytes and derived text are
committed before updating the server emulator. Input records describe attempted
delivery. They do not prove application acceptance. Terminal replies, control bytes,
escape sequences, and redraws are retained.

### Signals and exit

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

### Terminal scrollback

The limit of normal-buffer history rows depends on the terminal width. A terminal keeps
about 1,000,000 history cells (rows × columns), with at least 10,000 rows and at most
50,000 rows:

| Columns | History rows |
|---|---|
| 20 or fewer | 50,000 |
| 40 | 25,000 |
| 80 | 12,500 |
| 100 or more | 10,000 |

#### Reason for the limit

The emulator allocates all cells of a row, including blank cells, so rows × columns sets
its memory, not the length of the text. A narrower terminal wraps the same text into
more rows, so the limit keeps about the same amount of wrapped text. The 10,000-row
minimum keeps the row count of earlier releases at every width. The 50,000-row maximum
limits the fixed memory cost of each row.

#### Resize

The emulator itself allows 50,000 rows. After a resize or a terminal reset, the server
decreases the buffer to the limit of the width. Thus a resize to fewer columns reflows
all rows before the server drops the oldest rows. The emulator makes the new rows of
that reflow at the earlier width. After the reflow, the server releases the extra cells
of each row. Short lines do not join when a terminal gets wider, so a wider terminal can
drop the oldest rows above its smaller limit.

The emulator widens all history rows before it joins wrapped rows. Before a resize to
more columns, the server thus keeps at most 5,120,000 history cells: 10,000 rows at 512
columns. A resize from a very narrow to a very wide terminal can thus drop wrapped rows
that the new limit could keep.

#### Views and saved screens

Each view keeps the limit of its own width. A view wider than the terminal gets only the
newest rows of its smaller limit. The 8 MiB budget of rendered rows can keep fewer rows.
Before the browser parses a full frame, it sets the xterm.js scrollback to the limit of
the frame width. A saved final screen keeps the rows of its terminal. When the server
reads a saved screen, it keeps the newest rows within the limit of the saved width.

## Session views

Several views can show one session at the same time. All views are equal: each view can
send input, and no view is a controller. The PTY uses the size of the view that most
recently sent input. A closed view never stops the session.

### Shared views

The server holds a registry of live sessions. Each run owns its PTY, terminal emulator,
controls, and durable capture independently of clients. Multiple views share the run.
Every view can send input and signals. There is no controller role or Take control
button.

### Size owner

The PTY uses the viewport size of one view, the size owner. A view becomes the size
owner when it joins and no view owns the size. A view that sends user input becomes the
size owner before the server writes that input. User input is typed keys, a paste, or a
message from the message editor. Signals do not change the size owner.

A report does not change the size owner. A report is a focus report or a mouse report
that the application turned on. The server writes the report to the PTY, as it writes
other input. Thus a click, a tap, a pointer move, or a focus change in a view does not
resize the PTY. A frame causes no input, see [Frames](#frames). The page marks its
reports. See [Reports of a view](#reports-of-a-view) for the exact rules.

A socket closing only removes that view. When the size owner leaves, the PTY keeps its
size. The next view that sends user input or a new viewport size becomes the size owner.
Stop ends work for all views. There is no Detach button.

### Viewport of each view

Each view has its own viewport size. Smaller views crop columns and show the bottom
screen rows, putting clipped top rows in scrollback. Larger views pad unused space.

A web view asks for at least 20 columns and 5 rows, for the session terminal and the
side terminal. When the terminal area of the view is smaller, the terminal scrolls in
the view. Thus a narrow view does not make an agent redraw and hard-wrap its output at
a few columns.

A session view fits its terminal to the terminal area. The request that opens the
session has the size of that fit. In a window that does not change, the view sends at
most one `resize` after the request.

#### Size of a session view

- Before the first fit, the row above the terminal shows the
  [message bar](#message-bar), and the hint of the earlier view goes. The size in the
  request thus includes these rows.
- A new terminal starts at 20 columns and 5 rows, so that it does not overflow the
  terminal area. Then one fit sets its size. A hidden terminal does not fit. It joins
  with the size that the [view switch](#view-switch) gives.
- A fit gives the largest number of columns and rows that xterm.js draws in the
  terminal area. xterm.js draws n cells in Math.round(n × cell / ratio) CSS pixels.
  The cell is the unrounded cell size in device pixels, and the ratio is the device
  pixel ratio. The fit compares whole pixels, so its result does not depend on the
  current size of the terminal. The side terminal uses the same fit.
- While the view opens, it sends no `resize`. The terminal selector and the draft load
  after the request. They can change the height of the terminal area. When the open completes, one fit sends a `resize` if the size changed.
- The view sends each size once on a connection. The frames keep the old size until the
  server applies the `resize`. A fit with the same size in that time sends nothing. The
  size of the request counts as sent.
- A live view gets each frame at its own size. After a size change, the terminal is
  larger than its area until the frame of the new size arrives. Thus the terminal area
  of a live view shows no scroll bar, but it still scrolls. A scroll bar would take
  space from the area and make the next fit smaller.
- The terminal area shows scroll bars for an ended terminal, for an earlier terminal,
  and while the on-screen keyboard shows.

#### Limits

- In a narrow window, the terminal selector can move the message bar to a second row
  after the request. This occurs in the mobile layout and in narrow desktop windows,
  for example 768 pixels wide. A session with more than one terminal then gets one
  `resize` when the open completes.
- The fit reads the unrounded cell size from private renderer state of xterm.js 6.0.0.
  The fit addon of xterm.js reads the same state. A new version of xterm.js can change
  the state or the size that the renderer draws. Then the fit can overflow the area or
  leave an unused column or row.
- A full frame resizes the view in a parser handler, during the parse of the frame.
  xterm.js 6.0.0 allows this. In xterm.js master, a resize first parses the waiting
  writes, which includes the write in progress. Check the [frames](#frames) of a view
  again before an xterm.js upgrade.
- When the terminal area of a live view is smaller than 20 columns or 5 rows, the
  terminal scrolls with no scroll bar.
- These rules apply only to the session terminal. The side terminal fits once from the
  default size of xterm.js, and its scroll bars take space from its area.

### Reports of a view

The page marks each focus report and each mouse report that it sends, with the `report`
field of the input. A paste can have the same bytes as a report, so the bytes do not
identify a report. The page marks input only when both conditions are true:

- xterm.js emits the data while the browser dispatches a focus, blur, mouse, or wheel
  event. Typed keys and a paste come in other events. Composed text comes from a timer,
  after its event. When a handler starts another event, the page uses the innermost
  event that is still in dispatch.
- The data is one focus report or one mouse report, and the view has that mode on.

The server accepts marked input as a report only when a frame of the view makes it a
report. A view makes a report from the frame that it shows. Thus the server uses the
frames of the view, not the current modes of the application. It uses the frame that
the view acknowledged last. If that frame does not make the input a report, it uses the
frame that the view did not acknowledge yet.

| Mode of the application in the frame | Marked input that is a report |
| --- | --- |
| Focus reporting is on. | `ESC [ I` and `ESC [ O`. |
| Mouse tracking is on. | A mouse report in the default encoding or in an SGR encoding. |

All other input is user input. The server writes and records its bytes with no change.
This includes input without the mark, marked input with other bytes, and marked input
while the mode is off. The `id` of an input does not change these rules.

A view can show other cells than the PTY has, because only the size owner has the size
of the PTY. See [Viewport of each view](#viewport-of-each-view). The server changes each
mouse report of a view, so that the application gets the terminal cell under the
pointer:

- A view with fewer rows shows the last rows of the terminal. The server adds the number
  of the rows above the view to the row of the report.
- A larger view shows padding at the right of the terminal and below it. The server
  does not write a report for the padding to the PTY.
- A press on a terminal cell starts a gesture. While that button is down, the server
  writes a motion or a release in the padding with the nearest terminal cell. Thus the
  application gets the end of the gesture.
- A motion with no button down ends each gesture of the view. So does a frame that
  makes xterm.js stop the reports of a gesture, after the view acknowledged it. See
  the limits.
- The server records a report with the bytes that the PTY gets.
- A report with an `id` gets its receipt, also when the server does not write it.

#### Limits

- In the SGR pixel encoding (mode 1016), a report gives pixels, and the server does not
  know the height of a cell. The server does not write a pixel report to the PTY when
  the view does not show the first terminal row. It does not change other pixel
  reports, also for the padding of a larger view.
- The default mouse encoding has no byte for a row or a column after 223. The server
  does not write such a report to the PTY.
- A release in the default encoding does not name its button. It ends the gestures of
  all buttons of the view.
- A full frame and a frame with another mouse tracking mode make xterm.js stop the
  reports of a gesture. The application then gets no release for that gesture. A resize
  of the view or the PTY gives a full frame. A view with fewer rows than the PTY also
  gets a full frame when a row above the view changes.
- A client that does not mark its reports gets the earlier behavior: each input is user
  input and makes its view the size owner.

### Input and output order

Only a size owner resize reaches the shared emulator and PTY. The server orders accepted
input with size owner changes. A size change reaches the PTY before the input that
caused it. The server sends receipts to their original view. Input that two views send
at the same time can interleave.

Committed output and size events update the emulator in order. Terminal query responses
are recorded as `terminal-response` before PTY delivery. One notification combines
render requests. There is no per-client queue of raw output. Each attachment has its own
immutable render baseline and one outstanding frame.

### Emulator panic

An emulator panic does not stop the server. Live updates and the replay of a stored run
recover the panic for that terminal only. The server writes the session, the event
sequence, the event kind, and the stack to `server.log`. It then starts a blank emulator
at the size of the event, and views get a full frame. The process and the archive do not
change. The rendered screen and history before the panic are lost from that view.

### Frames and reattachment

After its acknowledgment, the server computes changes from the latest state, at most 20
times per second. Final output is acknowledged before exit. Input receipts use a
separate bounded queue.

A new attachment always starts with a full frame. Reconnecting does not change the PTY
size while another view owns it. The server updates PTY size when the size owner's
dimensions change.

The size owner gets no frame while its size differs from the emulator size. When the
emulator applies the resize, the view gets one full frame of its new size, with the
output of the wait. Thus the view never shows a crop of the screen at another size
first. This rule also applies to:

- the first frame of a view that joins as the size owner with another size.
- a view that takes the size after the size owner leaves. It keeps its own picture, not
  the size of the view that left.

A view without the size gets a crop or a padding of the screen at its new size at once.
A resize of the size owner to the emulator size also gets its frame at once, because the
runtime ignores it. Each wait ends. The runtime records each resize that it accepts, and
the emulator applies the record. The runtime ignores only a resize to its PTY size, which
is the emulator size after each control. A failed record stops the run, and the end of
the run wakes each view.

Reattaching at the same size uses the saved screen without requesting an application
redraw. An ended view never starts another process or invokes native provider resume.
Only an explicit `session-continue` starts a new terminal in an ended session.

### Session list order

The server orders families by the most recent member in the collection, with the rules
below. A family lists its top-level session first, then its sub-sessions in creation
order. The UI requests 101 to display 100 entries and detect another page. Normal
listing excludes archived sessions. Archived listing includes only archived sessions,
and the parents of archived sub-sessions as context. Ordering follows the latest
terminal input, output, or run lifecycle event (`start`, `run`, or interruption
`notice`), newest first. Quiet events do not count. Sessions without these events use
their creation time.

Timestamps compare in whole milliseconds. For equal timestamps, the higher event
sequence comes first. Sessions without these events sort after sessions with them.
Remaining ties use creation order, newest first. The order is deterministic, so offset
pages do not overlap while the list is unchanged.

The server sets the derived `events.quiet` flag for an event that is not session
activity:

- A focus report or a mouse report of a view. The server sets the flag when it records
  the input.
- Output that is not [application output](#activity-detection): output that changes
  nothing on the screen, and output in the 300 milliseconds after a view action. The
  server records output before it compares the screen, and it sets the flag just after.
- No other event. Only `input` and `output` events can be quiet. Events from before
  format 21 are not quiet.

The session list does not count the output of a terminal before the server sets its
flag. For each list read, the server gives the query two bounds:

1. The sequence of the latest event in the archive, or 0 without events. The server
   reads it first.
2. For each live terminal, the sequence of the latest event that the server classified.

The output of a session counts up to its second bound, or up to the first bound when
the session has no live terminal entry. A terminal that starts during the list read
records only output after the first bound. A `bbflow query` read can see the output
with `quiet` 0 before the server sets the flag.

Viewing, resizing, focus changes, renaming, saving drafts, attachments, terminal replies,
and saved screens do not change recency. Fresh application output still counts,
including output while detached. The redraw after a size change does not count.
Summaries contain ID, title, project ID
(empty for standalone), parent ID (empty for a top-level session), workspace, update
time, status, archive flag, view count, and a context flag.

## Concurrency and recovery

Sessions can share a workspace, and bbflow uses no workspace locks. One server owns
each data directory. After a crash, the next start marks the open runs as interrupted.
It never replays input and never stops a process from a stored PID.

### Shared workspaces

Workspace paths are canonicalized without locking. Multiple live or detached sessions
can use the same workspace, symlink aliases, or parent and child directories. Each
session has its own PTY, run state, history, and stop operation. Sessions share file
changes. bbflow does not serialize writers or isolate filesystem changes.

### SQLite access

SQLite uses WAL, full synchronization, and a busy timeout. Concurrent opens serialize
schema creation and upgrades. Switching journal mode retries lock contention for up to
five seconds because SQLite can skip its busy handler during this lock upgrade. The
server owns the live connection. Reading history does not reset active state. An
exclusive archive lock prevents two servers from owning one data directory, even on
different ports.

### Crash recovery

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

All durable bbflow data is in one SQLite database, `history.sqlite`, in the instance
directory. SQLite also keeps committed data in its write-ahead log (WAL) file, so the
main database file alone is not a consistent copy while writes are active. Events are
append-only and have stable sequence numbers. The original terminal bytes are
authoritative, and the readable text is derived from them.

### Archive contents

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

The server upgrades the database by itself at start, in one transaction. A failed
upgrade changes nothing and stops the start. The current format is 21. Formats 3
through 21 are supported. Format 3 shipped in v0.0.1.

#### Upgrade transaction

`internal/history/migrations/*.sql` is embedded in development and release binaries. The
server opens the archive after acquiring its exclusive instance lock, before
interruption recovery or serving requests. A pinned SQLite connection uses
`BEGIN IMMEDIATE` to serialize the version read and all pending migrations.

`PRAGMA user_version` tracks the last applied format. Scripts and version changes commit
as one transaction after column, index, and foreign-key checks. Any failure rolls back
the entire upgrade and stops startup. A failed SQL step reports its migration number.
WAL is enabled after the schema transaction commits.

#### Formats

- Empty databases run the format 3 baseline, then migrations 4 through 21. In the same
  transaction, a new database sets `worktree` to true in the settings JSON, so new
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
  the daily release check starts on, even after an upgrade. The settings revision and
  the other values stay.
- Format 12 gains the nullable `sessions.parent_id` column and its index through
  migration 13. Existing sessions stay top-level sessions.
- Format 13 gains `port: 0` in the settings JSON through migration 14. Port `0` selects
  the automatic port, so the server keeps its last port. The settings revision and the
  other values stay.
- Format 14 gains `titleCommand: ""` in the settings JSON through migration 15. The
  custom title tool runs this command. The upgrade saves no command and keeps the
  selected title tool, the settings revision, and the other values.
- Format 15 gains `remoteHost: ""` and `remoteLogin: ""` in the settings JSON through
  migration 16. Thus remote access starts off, also after an upgrade. The settings
  revision and the other values stay.
- Format 16 gains tool types, built-in tools, and title models through migration 17:
  - Each tool gains a type, a default model, and a default thinking effort. The type
    comes from the first word of the command, without its folder: `codex`, `claude`,
    `agy`, and `code-puppy` keep that name, and other commands are `custom`. The model
    and the effort start empty, so each launch submits the same command as before.
  - A saved tool becomes the built-in tool of its type when its command is the command
    of the built-in tool, with the CLI name or a [CLI path](#tool-program) as the first
    word. A path of more than 500 bytes or a relative path is no CLI path. The path
    becomes its CLI path, and the tool keeps its ID and name. Only the first such tool
    of a type does. Other saved tools stay tools of the user, with the type `custom`
    and an empty `path`. Every saved tool stays on, and each launch submits the same
    words as before.
  - A type without such a tool gets a new built-in tool that is off. Its ID is
    `builtin-` and the type, or a random ID when a saved tool has that ID. A new name
    that another tool has gets the suffix ` (built-in)`, and a random suffix when that
    name is taken too. The built-in tools then come first in the list: the saved ones
    in their order, then the new ones. The other saved tools follow in their order.
  - The migration sets `checkTools`, so the next start runs the tool check.
  - The settings gain `titleModel` and `titleEffort` with the model and the effort of
    the earlier command of the saved title tool.
  - Each preparation gains `toolType`: the type of its tool when that tool is a
    built-in tool, `custom` for other tools, and an empty type for Shell. Its `model`
    and `effort` start empty.
  - The upgrade keeps the settings revision and the preparation revisions.
- Format 17 gains `remoteOn`, the switch of [remote access](#remote-access-settings), in
  the settings JSON through migration 18. The switch starts on only when `remoteHost`
  and `remoteLogin` are both saved, because remote access was on there before.
  Elsewhere it starts off. The settings revision and the other values stay.
- Format 18 gains the nullable `sessions.pinned_at` column through migration 19. It
  keeps the time of a [pin](#pinned-sessions). Its check allows a pin only on a
  top-level session that is not archived. Existing sessions start without a pin.
- Format 19 gains `prompts: []`, the [saved prompts](#saved-prompts), in the settings
  JSON through migration 20. The settings revision and the other values stay.
- Format 20 gains the `events.quiet` column through migration 21. It marks the
  [quiet events](#session-list-order) that the session list order skips. Existing events
  are not quiet. The column has no `CHECK` constraint, so the addition of the column does
  not read the existing events. The foreign-key check of the upgrade transaction still
  reads all events, as in each upgrade.
- Format 21 opens without running scripts or rewriting history, settings, or metadata.

#### Preserved data

The upgrade preserves IDs, timestamps, event sequences, original blobs, text, drafts,
and attachments. It also preserves the highest allocated event sequence. Migration
starts no agents and replays no input. Startup interruption recovery still runs
afterward. Repeated or concurrent opens see the committed version and skip completed
steps.

#### Rejected formats

Formats 1 and 2 have no known migration path in this repository. They, nonempty
unversioned databases, and formats newer than the
[current format](#database-upgrades) are rejected without changing their schema or
records. A newer format error asks for a newer executable. There is no
downgrade path, external migration command, or automatic backup.

### Read-only SQL

`bbflow query` runs one read-only SQL statement on a separate connection. SQLite
enforces the read-only rule. bbflow has no SQL parser.

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

#### Read method

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

#### Reply size

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

#### Estimates

Event counts and the bytes of each events column are exact. The embedded SQLite build
has no `dbstat` table, so the report cannot measure each table or index. SQLite also
does not record which pages belong to a session. Thus each size for a session, project,
kind, or day is an estimate: its data and text bytes, plus its event count times the
average overhead for each event. The average overhead is the used space, less all data
and text bytes, divided by the event count. The estimates add up to about the used
space.

### Data handling

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

## Limitations

Each feature section has its own Limits sub-section. This section has only the limits
that apply to bbflow as a whole.

- Native session mapping/resume, forks, imports, native agent attachments, and Windows
  support are absent.
- Recording bytes does not preserve hidden agent state or guarantee complete semantic
  messages.
- Host crashes and server SIGKILL can lose uncommitted bytes and prevent cleanup.
- Provider-owned daemons retain their lifecycle.
- bbflow stops the launched group and a shell's foreground job. It does not track other
  background groups.
- A session has at most one live session terminal, and at most one live side terminal.
- Linux runtime behavior and large archives are unverified.

## Validation

This section records the checks of each feature. The groups follow the order of the
feature sections. A fixture is an automated test. A browser check or a live check was
one run by hand or by an agent, and its text states what it used.

### Checks of builds and the core workflow

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

- Go integration tests use temporary instances, real server processes, synthetic shell
  commands, and WebSocket views. They cover raw bytes, arguments, resize, Ctrl+C, exit
  status, closed views, and background capture. They also cover reconnect to the same
  PID, explicit stop, foreground job cleanup, shared workspaces, and SQL scope.
- They verify interrupted runs without input replay. They also verify that input from
  either of two views moves the real PTY size to that view.
- Two draft watches on a real server receive each save and a pending send, and a stale
  save gets the latest draft back.

Earlier browser checks with synthetic terminals verified creation, direct input,
multiline composition, file selection, and clipboard images. They also verified saved
drafts, session changes, stopped-screen reload, and reconnection after a paused server.
Two-tab checks verified shared output and stop for all views. Those
checks do not establish compatibility with real agent approval flows or untested agent
CLI versions.

### Checks of release and update

- Release check fixtures use a fake curl, a synthetic release, and this test binary as
  bbflow 0.0.1 and 0.0.2. They verify that a server start offers the release without a
  download, and that `update-start` installs it and starts a new server. They verify a
  restart without a download when the executable already has the release, the reason of
  a failed download, and an unchanged server after it.
- A server stop during a hanging check ends at once and leaves no temporary files.
- A failed server check gives the installer message as its reason, not the exit status.
- An in-process server fixture with a fake release source verifies a single check across
  setting changes, the offer in the status watch, rejected versions, a second update,
  and a failed restart. The offer stays when the setting changes to off.
- The fixture verifies that the status watch shows a running check, the check time, and
  a failed check, which keeps the earlier offer.
- `update-check` runs a check while the setting is off. A request during a running
  check starts no other check. A view can start the offer of that check.
- Quick checks with the same result change the status watch by their count, also when
  the watch does not see them run.
- The checks that end during an update apply after the update fails. The failure
  stays with its release when a check finds the same release, a newer release, or no
  newer release. A failed check keeps the offer of a successful check before it, and
  a successful check after a failed one applies. Until the failure, the state keeps
  the update in progress and the earlier check time. At most two held results remain.
- A development build sends its version and no check state. It rejects `update-check`
  and `update-start`.
- A newer save can reply first, and an earlier save does not then apply.
- A stale offer starts a check at once.
- A release fixture changes the executable back to 0.0.1 after a restart offer: the
  confirmed restart downloads nothing, and the server offers the download.
- A second confirmation of the restart then fails.
- A check of the same release and action keeps the revision.
- Web fixtures verify the text of the **Updates** card, the check times, the dialog
  text, and the session warning.
- A fake DOM fixture verifies that the open dialog counts the live sessions of the
  latest status message and shows the titles of the current list. It also verifies that
  a new offer closes the dialog, that the view confirms the revision of the shown offer,
  and that a lost status watch hides the offer.
- The fixture verifies the dot on **Settings** and its accessible name. A failure stays
  when the offer changes or goes, and the red dot shows it. **Check now** shows
  **Checking…** until the status watch reports the check. A status message from before
  the request does not end it. A new count of checks ends it, also with the same check
  time. A failed request shows its reason until a later check.
- A lost watch during a pending start that then fails allows no other attempt.
- A failed start without a change allows one.
- A failed settings update in migration 12 rolls back and keeps format 11.

### Checks of the server and the menu bar

Menu fixtures cover repeated start, restart, server crashes, shutdown with an active
session, and protection against stopping a replacement instance. A manual macOS check
confirmed Open UI and Quit bbflow from the standalone executable. The shared logo was
checked in light and dark browser themes. The generated menu bar PNG was checked to
contain only fully transparent or fully opaque pixels. A manual check confirmed the icon
in the dark macOS menu bar. A unit test verifies that the page links the
apple-touch-icon, and that the icon is a 180-pixel PNG with only opaque pixels. It also
verifies the mid-gray tile and the dark band colors of the logo. The updated native
companion also launched and exited with its server.

The automated checks of [remote access](#remote-access) use no Tailscale Serve proxy.
Each check sends the requests of such a proxy to the loopback port:

- A test of a real temporary server sets `remote`, `remote-host`, and `remote-login` with
  the CLI, and it checks the printed status. It verifies status 403 for a page request
  and a WebSocket upgrade while remote access is off, with one value only, and with both
  values while the switch is off.
- While the switch is off, it verifies the body `remote access is off` for the saved
  host and `invalid host` for another host.
- With the switch on and both values, it verifies the page, the policy with the remote
  WebSocket origin, and the unchanged policy of a local page.
- It verifies status 403 for no login, another login, two login headers, a request with
  only the Funnel header, another host, a longer host, and the remote host with a port.
- It verifies status 403 for a remote upgrade with a foreign Origin, the HTTP origin of
  the remote host, another port, and no Origin.
- It verifies status 403 for a page request and an upgrade with a loopback Host and the
  headers of a proxy. The cases are remote access off, the saved login, another login,
  no login, and the Funnel header. It verifies that each proxy header alone has this
  effect, and that a direct local request still gets the page.
- It verifies that a change of a value closes a remote status watch and keeps a local
  one, and that a save of another setting keeps the remote one. It verifies that the
  switch closes a remote status watch too when it turns off, and that it keeps the login.
- It verifies that the saved switch and values apply again after a server restart.
- It verifies that a saved host with a port admits that Host and rejects the host
  without the port.
- Server tests apply settings of revisions 3 and 2 in that order and verify that the
  switch that revision 3 turned off stays off. A table test verifies the body of each
  failed check, in the order of the Host, the switch, and the login. Other tests cover
  the proxy headers and the remote Origin rule. One test changes the remote host between
  the check and the upgrade of a request, and verifies that the Origin of the new host
  fails.
- Store fixtures cover the rules of the two values, a save of one value alone, and a
  title tool change that keeps them. They also cover a switch without the values, a
  switch that keeps the values when it turns off, and a save of the values that keeps
  the switch off.
- Migration fixtures upgrade a frozen format 15 archive with a saved custom title
  command. The upgrade keeps it and adds the two empty values. A blocked settings update
  rolls back migration 16.
- Migration fixtures upgrade a frozen format 17 archive with both values saved, and the
  switch turns on. Fixtures with one value, the other value, and no value keep the switch
  off, with the same values and revision. A blocked settings update rolls back migration
  18. Four concurrent opens upgrade a format 17 archive once.
- Web fixtures cover the **Remote access** card. A field saves alone on blur and on
  Enter, and Enter with the blur after it sends one save. An input during the save makes
  the blur save again, for a saved value and for a rejected value. The fixtures also cover the
  saved lower case host name, the status texts, a rejected value, Escape, and a
  rejection before and after **Done**. A protocol fixture verifies `wss://` on an HTTPS
  page and `ws://` on an HTTP page.
- Web fixtures cover two views: one view removes the login, and a save of the host in
  the other view applies to the latest settings. The login stays removed.
- Web fixtures cover the switch: a save at once with the saved values, field saves that
  keep it off, the status of a switch without both values, and a switch that keeps the
  host name when it turns off. After another view changed the login, a click sends no
  save, the field shows the new login, and a second click turns remote access on for
  it. A failure after **Done** gives a toast.
- Web fixtures cover a click on the switch while a field still has focus: the field saves
  first, then the switch. With a rejected login, two clicks send no save of the switch,
  and the error of the field stays. After Escape, the click turns remote access on for
  the saved login.
- Web fixtures cover the order of a press: the press keeps the focus, and Off saves
  before an edited login. A host save at the click that takes a login from another view
  sends no save of the switch, and a second click turns access on for the login in view.
  A save of the login keeps the error of a rejected host, and **Done** repeats that
  error in a toast.
- Model fixtures verify that a field save before the switch in the queue is no conflict,
  and that a click that turns the switch off needs no check.
- `curl` requests to that demo server, with the Host and the login header of a proxy,
  gave status 200 for the page and 101 for the WebSocket upgrade. They gave 403 without
  the login, with another login, and after remote access went off.
- A browser check of a demo instance clicked the switch before any value was saved. The
  status told that remote access needs both values. After a save of a sample host name
  and login, the card showed that remote access is on. `curl` requests with the headers
  of a proxy then gave status 200.
- After `bbflow settings set remote false`, the same request gave status 403 with
  `remote access is off`. A request for another host gave `invalid host`. The login
  stayed saved. In the page that still showed **On**, a click read the new settings,
  sent no save, and showed **Off**. A second click turned remote access on. The card
  also fit a view 375 pixels wide.
- In the card without **Save**, Tab from **Tailscale host name** saved the host name in
  lower case, and Enter in **Tailscale login** saved the login. The status then showed
  **All settings saved**. A save of the host name while the switch was off kept it off.
  Escape in the login field restored the saved login.
- In the browser pane of the desktop app, a mouse click on the switch kept the focus in
  the login field with an edit. With access on, the click saved Off first, and the saved
  login stayed the earlier login. A second click saved the edited login, then turned
  access on for it. No check used Safari.

A manual check used a real Tailscale Serve proxy of Tailscale 1.104.7 on macOS, with
`tailscale serve --bg PORT` for a demo instance:

- While remote access was off, the HTTPS address gave status 403 with `invalid host`,
  from the Mac and from an iPhone in the tailnet.
- After a save of the host name and the login in the **Remote access** card, `curl` on
  the Mac got status 200 and the policy with the remote WebSocket origin.
- A WebSocket upgrade through the proxy got status 101. An upgrade with a foreign Origin
  got status 403.
- A request with a `Tailscale-User-Login` header of another user got status 200. Thus
  the proxy replaced the header of the client with the login of the device.
- The iPhone then loaded the web UI in its browser. The check did not record the
  operations that the user tried there.
- Before the local request rule had the proxy headers, a request with the Host
  `localhost:PORT` through the proxy got status 200. With the rule, a page request,
  `GET /client-config`, and a WebSocket upgrade with a loopback Host got status 403. A
  request that named the forwarding headers in its `Connection` header also got 403.
- With the remote Origin rule, an upgrade through the proxy got status 101 for the
  HTTPS origin, and 403 for the HTTP origin of the same host and for no Origin. The
  policy of the remote page named only the `wss://` origin.
- A direct request to `localhost:PORT` still got the page and the upgrade.
- After a rebase onto the mobile layout and a server restart, the same address gave
  status 200 and 101 again, with the saved values.
- `tailscale serve --bg --https=8443 PORT` for a local test server gave the Host
  `my-mac.example.ts.net:8443`, with the real host name, and a login header. Remote
  access of bbflow was not used on that address.
- The same address for a port with no server gave status 502.

### Checks of the sidebar and archive

Archive fixtures cover more than 100 saved drafts, search before pagination, and literal
wildcard characters. They cover restoration after project removal and preservation of
draft revisions and original attachment bytes. They also verify rejection of active runs
and unfinished launch claims.

A real temporary server test creates two drafts in a project and saves independent
messages. It archives one draft, restarts the server, then finds and restores that
draft. It starts a synthetic shell and verifies rejection of an archive request while
the shell is active. Then it stops the shell, archives the session, and replays its
output. Restoration starts no process.

Web fixtures check that the default sidebar width in `style.css` stays inside the divider
limits for every window width from 951 to 3000 pixels. They also check the default width
at window widths of 1200, 1600, and 1920 pixels.

- Browser checks with a temporary instance verified separate sidebar drafts and saved
  session names and multiline messages before launch. They verified session changes,
  exact draft reload, archive and restore, and disabled launch for archived drafts. They
  also verified preservation of the unsent editor after launch and stop. They also
  verified archived search, page 2 with over 100 synthetic archived items, search for an
  item outside page 1, and narrow-layout search.
- No browser errors were reported.
- The tests used synthetic shells, not a real agent CLI.

### Checks of session families

- Family fixtures verify family order by the latest member, paging by family, an
  included sub-session that brings its family, search context, and context parents in
  Archived. They verify family archive and restore, live members that block an archive,
  and the rules of a sub-session draft.
- Server fixtures create sub-session drafts with a Git repository. They verify the base
  from the parent branch, a start in the parent worktree, a new worktree from the parent
  commit, and the rejection of a parent draft workspace.
- A failed index creation in migration 13 rolls back and keeps the earlier format.
- Web fixtures verify the families of the list, context families, the place labels, and
  the merge of pages without a repeated family.
- A browser check of a demo instance with the Demo agent verified a start in the parent
  workspace, the family archive dialog, the welcome view after the archive of a selected
  sub-session, restore of the family, and search context.
- No real agent CLI was used.
- Web fixtures also verify the status icons and texts and the first 5 sub-sessions of a
  family.
- Family fixtures verify a rejected archive when the confirmed sub-sessions differ.
- Server fixtures verify the base from a parent worktree after a branch switch and on a
  detached commit, and the rejection of a parent workspace before the first terminal of
  the parent.
- Server fixtures verify that a family stop ends only the confirmed members. A live
  sub-session that the user did not confirm continues, and so does another family. A
  member of another family, a sub-session in place of the top-level session, and a
  missing session stop nothing. Members without a live terminal are skipped.
- Web fixtures verify the sessions that Stop session and Stop family list, when each
  item shows, a member that creates its worktree, and the dialog text.
- A browser check of a demo instance stopped a family with three live members and one
  draft. It used the Demo agent and the Busy agent. The dialog listed the live members
  with their status, and not the draft. The members ended with the run status
  `stopped`. Live sessions outside the family continued. A stop with the keyboard only
  ended a selected sub-session and returned the focus to the ⋯ button of the row.
- A second browser check used **Stop session** on a top-level session without
  sub-sessions, and on a family parent with a live sub-session. Each dialog named one
  session. Only that session stopped, and the sub-session continued. The menu of the
  parent then showed **Stop family** below its line, and it stopped the sub-session.
- A third browser check used the row menus of a family. While only the parent was live,
  its menu had **Stop session** and no **Stop family**. With a live sub-session, the
  parent had both items, and the sub-session had **Stop session** with no line above
  it. **Stop session** on the sub-session stopped only the sub-session. The parent
  continued, and its menu then had no **Stop family**. Other live sessions continued.
- A fourth browser check simulated another view with separate WebSocket requests. It
  chose **Stop session** with the keyboard in these cases:
  - After a cancel and after Escape, the focus returned to the ⋯ button of the row.
  - When another view had stopped the session, no dialog opened, and the focus returned
    to the ⋯ button.
  - When another view had stopped and archived the session, no dialog opened.
  - When another view had removed the project of the session, the dialog still opened.
  - After the stop, the focus returned to the ⋯ button.

### Checks of pinned sessions

- Pin fixtures verify the Pinned group: the newest pin first, also for pins in quick
  succession and after the clock moved back, an order that activity does not change, families that leave their project group, sub-sessions, search
  context, paging, and an included session. They verify that Archived ignores pins, that
  an unpin returns the family to its project group, and that a pin stays after project
  removal.
- Pin fixtures verify the rules: a sub-session, an archived session, and a missing
  session cannot get a pin. A repeated pin keeps its time. Archive removes the pin, and
  restore does not add it again. The table check rejects an invalid pin. The 21st pin
  fails, and an unpin allows a new pin.
- A real temporary server test pins a family through `session-pin`, lists it in
  `pinned` and not in its project group, and finds the pin after a restart. An archive
  then removes the pin.
- Web fixtures verify the Pinned group first, a pinned session without a saved project,
  search in Pinned, Archived without Pinned, and a merge of pages in which pins do not
  count against the step of their project.
- `TestDemo` verifies the two pinned sessions of the demo.
- A browser check of a demo instance with the Demo agent verified **Pinned** above the
  projects, with the project name of each row. It verified a pin and an unpin from a row
  menu and from the More actions menu. It verified the focus after a pin with the
  keyboard, a pin of a live session, a pin that expands a collapsed **Pinned**, and no
  **Pin** for a sub-session. It also verified search context in **Pinned**, Archived
  without **Pinned**, an archive that removed the pin, and the phone layout. The browser
  reported no errors. No real agent CLI was used.
- A second browser check with two views verified that an open draft shows **Pin** after
  the other view unpins it. It also verified that a keyboard unpin expands a collapsed
  project group, with the focus on the ⋯ button of the row. After an unpin of a family
  behind **Show more**, the focus moved to the nearest later row.
- A third browser check collapsed **Pinned** and the project group. **New sub-session**
  of a pinned session, and the restore of a sub-session of a pinned family, expanded
  **Pinned** and showed the selected row there. In a window 420 pixels high, a keyboard
  pin from the end of the scrolled list, and a keyboard unpin from its top, scrolled the
  list to the focused ⋯ button.

### Checks of projects and launches

- Project fixtures cover a new instance without projects, launches in two projects,
  name order, canonical folder uniqueness, renaming, removal while a session runs, and
  restart persistence.
- Draft fixtures cover concurrent creation of independent drafts, preserved tool
  snapshots, Shell selection, attachment persistence, and starting a fresh draft after
  launch.
- Browser checks verified that project names are plain text without click actions. They
  verified that separate arrows expand or collapse groups and **＋** creates draft
  entries. They also verified that a new project leaves the current view unchanged. They
  also verified draft restoration after switching, reload and server restart, Shell
  launch in a worktree, and separate drafts for subsequent sessions.
- A headless Chrome check with the demo instance verified the project menu with the
  mouse and the keyboard. It verified the order of the items, the line above **Remove
  project**, the arrow keys, Escape, and a click outside the menu. It also verified that
  no later row covers an open project menu or session row menu.
- The same check renamed a project in **Edit** and saw the list sort it again. It saw
  the folder path on the clipboard and the confirmation of the ⋯ button. It ran
  **Search this project** with the scope **This project**. It removed a project with the
  keyboard while one of its sessions was open. The sessions then showed under
  Standalone, the pin stayed, and no error toast showed.
- A second check stopped a session in another view while a project menu was open. After
  **Copy folder path**, the list refresh replaced the ⋯ button, and the new button
  showed the confirmation. A rename moved the first of eight projects to the end, and
  the list scrolled to its focused ⋯ button.
- The second check also removed a project while Settings was open. Settings stayed
  open, and after **Done** the session was standalone. In a 390-pixel window, a keyboard
  removal of the project of the selected draft kept the drawer open and moved the focus
  to the search box.
- Web fixtures check the order of the project menu items, the line above **Remove
  project**, and a copy confirmation that stays on the new ⋯ button after a list
  refresh.

No real agent CLI was used for these project checks.

### Checks of settings, preparation, and worktrees

Launch fixtures cover persistent defaults, stale settings and configuration saves,
command snapshots after preset removal, and interrupted launch claims. They cover Git
subfolder and linked-checkout detection, clean creation, and rejection of removal for
active or dirty worktrees. Synthetic sh, bash, and zsh runs verify one startup input,
shell availability afterward, reconnect without replay, and an untouched composer draft.
These shell fixtures do not establish model availability or agent CLI compatibility.

Title model fixtures verify that the default models give the commands of earlier
releases and that a chosen model goes between the fixed start and end of a title
command. They verify that Apple and Custom reject a model, that a settings save keeps
the title model, and that a stale title change saves nothing. A server fixture changes
the CLI path of Claude Code during a title test and verifies that the title tool does
not save. CLI fixtures cover `title-tool set --model` and its errors. Web fixtures
verify that a selection of an agent title tool waits for **Save and test** with its
default model, that a failed test keeps the selection and the model, and that a model
change waits for **Save and test**. They verify that a model edit goes when its test
fails after a close, and that a newer model from another view is no edit.

Upgrade fixtures verify that 100 custom tools still save after the upgrade adds the
built-in tools, and that a 101st fails. They give new built-in tools free IDs and names
when a saved tool has `builtin-codex` or `Codex (built-in)`. They leave a relative or
an overlong program a custom tool. Web fixtures verify that a refresh in one model
picker updates a picker of the type that is in view, with its chosen model, that the
later of two overlapping refreshes reaches every picker, and that the browser waits 35 seconds
for a model list.

Tool menu fixtures verify the order of the menus: the built-in tools and Shell by name,
then the custom tools in their saved order, with a line between the groups.

Shell fixtures verify that Shell that is off cannot be the default tool, that the
fallback default skips Shell and tools that are off, and that a draft and a new terminal
cannot choose Shell that is off. CLI fixtures cover `settings set shell`, and web
fixtures cover the switch of Shell and the menus without Shell. A web fixture verifies
the command that a draft shows for each choice, also for Shell before a save.

Built-in tool fixtures cover the migration of saved tools to built-in tools, the
presets that start off, and the suffix of a name that another tool has. Store fixtures
verify that a save keeps the built-in tools first, keeps their type, starts a new tool
on, turns a tool of the user off, and rejects a default tool that is off. They verify that the tool check turns on only installed tools, once,
and keeps the revision. Server fixtures verify the check at start, a failed check, and
that a draft and a new terminal cannot choose a tool that is off, while a draft keeps a
tool that turned off later. CLI fixtures cover `tool enable`, `tool disable`, the `on`
and `off` column of `tool list`, and the refusal to remove a built-in tool. Their
server finds no CLI, so the result does not depend on the computer. Web fixtures cover
the two tables and their columns, the switch of each tool, the **NOT FOUND** mark, the moves among the
tools of the user, and the **Default tool** menu without tools that are off.

CLI path fixtures cover the accepted and the rejected paths and the command of each
built-in tool. A server fixture saves a built-in tool with the path of a synthetic CLI.
It verifies that the check finds that file, that the model list and the title command
run it, that a change of the path runs the list again, that the session command takes
the path, and that a tool of the user takes no path. Store fixtures verify that a save
keeps the name and the command of a built-in tool, and that a tool of the user is a
Custom tool. The migration fixture has saved tools with the
command of a built-in tool, a path, other options, and a quoted program. Only the first
two become built-in tools. The others become Custom tools. A web fixture verifies that the editor of a built-in tool
shows only the CLI path and the model fields, and that a saved path starts the check and
the title commands again.

Model fixtures cover the options of each tool type, the inferred type of a command, and
the rejection of model and effort names that are not safe in a shell line. They parse
synthetic output of `codex debug models`, `agy models`, and `code-puppy --setup model
list`, including hidden Codex models, Antigravity efforts in model IDs, and progress
lines. Server fixtures verify that a draft copies the defaults of its tool, saves its
own model and effort, and launches with their options. They verify that a new terminal
launches with the model and the effort of its request, and that it rejects the choices
that a draft rejects and a model or an effort for Shell. They verify that a model list
runs once until a refresh, and that a failed list command keeps no list. Web fixtures cover the model and effort menus of
each type and the merge of a tool edit. The view and the server build the same command
for the same cases. Interface inspection of Codex 0.171.0, Claude Code 2.1.330,
Antigravity 1.5.15, and Code Puppy 0.0.969 found the list commands and the options. A
live run of each list command confirmed the output formats. No fixture starts a real
agent with a chosen model.

Web fixtures cover settings comparison, edits that preserve fields changed by another
view, and repeated add requests. View fixtures run the Settings view on a small fake DOM
and send each server reply at a chosen time. They cover a tool save, a port, a default,
and a custom title command that fail after **Done**, each with its toast and no entry
left. They cover a corrected port that saves after **Done** without a toast, and a
removal that asks again. They cover the status text with the names of the
entries that are not saved, and the check for a tool name that another tool has. They
cover that check after a revision conflict, and a removal that asks again after the
tool became the default tool. They cover a rejected default that the page discards, and
a default whose save runs during the discard. They
cover the range check of the Port field and a reset of that field during a save. They
verify that the page has the tool table with its columns, one hidden tool editor, the
Remove dialog, and Tools before the session defaults. They verify that a new tool is a
Custom tool without model fields, that **＋ Add custom tool** waits while the editor
dialog is open, that Escape closes it, and that **Edit** opens it with the
saved values. Protocol fixtures verify that a server error reply is
marked apart from a transport failure.

- CLI fixtures run `bbflow tool` and `bbflow settings` against a temporary server. They
  verify that a repeated `tool add` updates the same tool, that removal of the default
  tool selects Shell, and that duplicate names stop `add` and `remove`. They verify that
  a tool named `shell` can be the default tool, and that only an empty value selects the
  built-in Shell.
- They verify the text of `tool list`, also for an empty list, and the error for
  `--default` after `NAME`. They verify that `--` before a name `--default` adds that
  tool, and that `settings get default-tool` fails when two tools have the name of the
  default tool.
- They verify that `settings set` prints the saved value, and that `settings get KEY`
  prints one value in the form that `set` accepts. They verify that the restart note
  prints only for a changed port, that only `true` and `false` are on and off values,
  and that the `title-tool` key names the `title-tool` command.
- They verify that server validation errors change nothing, and that a change applies
  again after a revision conflict.

Browser checks with a temporary instance verified settings, project drafts, saved
preparations after refresh, and startup in a timestamped worktree. They verified
preservation of the message draft and worktree after stop. No browser errors were
reported.

Appearance fixtures verify the System default, successful Dark saves, and rejection of
an invalid value. The migration tests preserve other settings and verify rollback and
concurrent opens. A Chrome check with a synthetic Shell session verified Light, Dark,
and System, saved appearance on reload, terminal replay, dialogs, and both diff layouts.

A browser check with the demo instance verified that tool fields do not save on blur.
**Add tool** and **Save** saved the requested changes. **Cancel** discarded an edit.
A rejected command stayed in the editor, and a session default saved during the edit.
After a reload, the tool and the default showed their saved values. A move changed the
tool order. A new terminal started the Demo agent. The handoff prompt went into the
message editor, and **Send** delivered it to the simulated agent.

A later browser check with the demo instance verified the saves in Settings:

- The status bar stayed at the top of the page while the page scrolled.
- A second tool with the name Codex did not save, and the status showed
  **Not saved: New tool**.
- **Remove** opened the dialog. For the default tool, the dialog named Shell as the
  next default tool. **Remove tool** removed a tool, and focus went to **Edit** on the
  nearest row.
- Port 80 showed the range message of the page. Escape restored the saved port.
- **Done** with the port text 99 showed the toast that the port did not save.
- **Done** with a name in the new tool editor and an open Custom field discarded both.
- **Test** did not show for None or for a Custom that is not saved.
- With the CLI as a second client, a tool name that the CLI added stopped the add in
  an open page. A removal asked again after the CLI made the tool the default tool.
- A starting branch of 270 UTF-8 bytes, which the server rejects, went away on Escape.
  **Done** discarded it with a toast, and a later appearance save passed.
- A click on **Done** with port 6000 in the field gave one toast.
- A custom title command that failed after **Done** gave a toast. The hidden page then
  had no entry, and the browser did not warn at a close of the tab.

### Checks of usage limits

- Usage fixtures parse synthetic outputs in the formats of Codex 0.172.0, Claude Code
  2.1.332, and agy 1.5.17. They verify the windows, the plan, and the reset times. They
  also verify a reset in the next year, a reset on December 31 seen on January 1, a
  reset without a date, the order of the Antigravity windows, and an Antigravity group
  without limits.
- Usage fixtures verify the errors: a JSON-RPC error, missing rate limits, an
  unanswered request, an unknown `Current ` line, an unknown reset time, an output
  without limits, and a failed Antigravity status.
- Server fixtures with scripts in place of the CLIs verify the cache: reuse within 1
  minute, a new check after a refresh or after 1 minute, one check for requests that
  wait together, and a new check after a change of the CLI path. They verify that a
  failed check keeps the last report with the error, and that a canceled check saves
  nothing. They verify the rejection of a tool that is off and of a type without a
  check.
- A server fixture with a script that acts like `codex app-server` verifies that
  standard input stays open until the answer. The same script gives no answer when its
  input closes at once. Other fixtures verify the time limit, a command that ends without
  an answer, a missing CLI, a command that runs after its answer, a reply line that
  arrives in parts, and a canceled request that starts no command.
- Web fixtures verify the tools of the dialog, the part that is left, the levels, the
  names of the limits, and the reset texts.
- A live check ran the real Codex 0.172.0, Claude Code 2.1.332, and agy 1.5.17 through
  the server code. Each check returned the limits of the account.
- A browser check of a demo instance opened **Usage** with the real Codex and Claude
  Code CLIs. It verified the centered dialog in the dark and light appearances,
  **Checking…** before each answer, **Check now**, an error for a missing Antigravity
  CLI path, and the phone layout without a side scroll. It also verified the bottom row
  on one line at the default sidebar width of a 1200-pixel window, and **Usage** and
  **Settings** together on a second line in a 900-pixel window.
- A second browser check used a temporary server and a script in place of Claude Code,
  at a CLI path of 226 characters. After one good check, **Check now** failed. The
  warning with the long error wrapped in the dialog, without a side scroll.

### Checks of the session status and toolbar

- Session status fixtures use fixed times and a real PTY.
- Time fixtures cover the start of a terminal, background output, the idle delay, typed
  input at short intervals, and output after the echo window.
- A server fixture covers `draft`, worktree creation, a launch without a process, a
  starting terminal, recent and old output, each stored end status, and a new terminal
  in an ended session.
- A PTY fixture starts an application that writes on a trigger file. It checks `running`
  and `idle` in the list and on the stream, that typed input keeps `idle`, that a later
  view gets the current status, and `ended` after stop.
- A status watch in the same fixture gets each change and then loses the session after
  stop.
- A second PTY fixture sends an unchanged size and then triggers output. It checks that
  the application got no size change and that the session shows `running`.
- Screen fixtures check which output changes what a view shows. New characters, a
  style, a color, an underline style, new history rows, an erase of the history, a
  notice, the removal of the notice, a switch of the screen buffer, and a reset are
  changes. A frame that only puts the cursor back, a cursor move, a title, a bell, input
  modes, a query, text that the same output erases, a color in another SGR form for a
  row or for one cell of a row, protected cells, and an erase of an empty history are
  not changes. The comparison of
  an unchanged screen makes no allocation.
- A server fixture checks that output without a change keeps `idle` and is quiet. It
  also checks that the reply to a focus report and the echo of typed input are quiet.
- A server fixture holds the quiet flag of a frame before the server sets it. A list
  read in that time does not count the frame. In a second fixture, a terminal starts
  after a list read took its bounds, and the read does not count its frame either. This
  fixture runs in an empty archive and in an archive with events. A history fixture
  checks both bounds, the bound 0 of an empty archive, and that input after them
  counts.
- A third PTY fixture starts an application that turns focus reports on. It writes a
  frame without a change ten times each second. The session becomes `idle`. The frames
  and a focus report of a view are quiet and do not change the list order. List reads
  without a pause for 3 seconds never put the session first. Output that changes the
  screen then shows `running` and puts the session first.
- A server fixture checks that only input that the server accepts as a report reaches
  the runtime as a report.
- A server fixture checks the same rule and a changed size with fixed state.
- A PTY fixture with three shells checks that a view that did not stop a terminal gets
  `stopped` with code 129, and `exited` with code 3. It also checks that each `exit`
  message carries the ID of its run.
- Web fixtures cover the status text, the continue rule, the terminal rule for **Stop
  session**, the priority of a pushed status, the status line of a list entry, the end
  reason and its run, and the reconnection of a watch stream.

The next three live checks used the earlier idle delay of 3 seconds.

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

- A browser check of the session toolbar used a temporary instance, a fixture
  repository, and a Shell session. It checked the draft, running, and ended states, the
  tooltips, the pressed pane icon, and the **More actions** menu with its keys. It also
  checked a long workspace path, a 700-pixel window, and an empty browser console.
- A later check verified that Tab and Shift+Tab from each menu item close the menu and
  move the focus out of it. It also verified that the Rename dialog returns the focus to
  the menu button.
- A review check with a temporary Shell session verified that **Reconnect** restored the
  live view after a connection loss.
- No real agent CLI was used.

- A web fixture covers the send shortcut of the message editor.
- A live check of the simplified layout used a demo instance and headless Chrome.
- A live view had no hint and no row above the terminal. Its toolbar line showed the
  tool before the workspace path.
- A Shell session that continued with the demo agent showed **Shell** for terminal 1 and
  the demo agent for terminal 2.
- Command-Enter sent the saved draft, and the terminal printed the reply of the demo
  agent.
- An earlier terminal showed the selector, the hint, and **Back to live terminal**.
- An ended session showed **Continue in new terminal** in the toolbar.
- The home page, a draft, Settings, and two dialogs also showed correctly.
- With the Files pane open in a window 1,152 pixels wide, the action row of the message
  editor wrapped, and **Send** stayed inside the editor.
- A dropped `session-terminals` request left the toolbar line without a tool.
- During a continue with another tool, a delayed list left the line without a tool until
  the new list arrived. Then the line showed the new tool.
- After Command-Enter, the keyboard focus was in the editor again. The check did not use
  a pointer, so tooltip display on hover is not verified.

- A browser check of **Stop session** in the More actions menu used a demo instance.
- At a width of 1,280 pixels, the toolbar of a live session had no **Stop session**.
  The menu listed **Rename**, **Copy session ID**, **New sub-session**, and **Stop
  session**. The focus went to **Rename** when the menu opened.
- **Stop session** in the menu ended the session with **Ended · stopped**. The focus
  went back to the menu button. **Continue in new terminal** then showed in the
  toolbar, and the menu no longer had **Stop session**.
- A view of an earlier terminal had no **Stop session** in the menu.
- At a width of 375 pixels, the menu of a live session had **Stop session** last. The
  menu of an ended session had **Continue in new terminal** first.
- The browser console had no errors. The check used a desktop browser with a mouse.

### Checks of session titles

- Title fixtures verify the separate user and derived titles, search on both, and the
  title tool values.
- A failed settings update in migration 10 rolls back the new column and keeps format 9.
- Synthetic title commands verify standard input, path masking, the temporary folder,
  the marker rule, failures, cancel, and a missing CLI.
- Send fixtures verify that only the input receipt of the first send with text runs the
  command, with the text of that send.
- An autosave, a send without a receipt, a receipt for another revision or for other
  bytes, an emptied draft after a failed send, and later sends do not run it.
- A session without a derived title, as after an upgrade, starts no request after the
  user clears its title.
- Byte fixtures reject text inside another submission, text only in an attachment path,
  a missing attachment, and a missing final Enter. They accept valid sends with
  attachments and with several lines.
- A fixture turns titles on between two accepted sends, and the second send runs no
  request.
- A fixture reopens the archive after a request with a lost receipt, and a second send
  then runs no second request.
- Live checks used Claude Code 2.1.312, Codex CLI 0.160.0, and Code Puppy 0.0.969 with
  synthetic messages.
- A message that named a local canary file did not give its content to the hardened
  Claude and Codex commands.
- Fixtures verify that terminal escape sequences do not stay in a title or an error.
  They also verify that a marker which only escape sequences break does not reach the
  request, so an echoed request gives no title.

- Title tool change fixtures verify that a tool saves only after it passes a test with
  the sample message.
- A failed test, a canceled test, and an unknown tool save nothing and keep the
  revision.
- None saves without a run of the command.
- A built-in tool with a command is rejected.
- Custom saves its command with the choice, keeps it across a change to another tool,
  and needs its command in each test and change.
- A first send then runs the saved custom command.
- Custom without a command, with a second line, or with more than 1,000 bytes is
  rejected.
- A settings save keeps the saved title tool and custom command, and a save from before
  a title tool change fails.
- Migration fixtures upgrade a frozen format 14 archive with a saved port and title
  tool.
- The upgrade keeps them and adds an empty custom command.
- A blocked settings update rolls back migration 15.
- Server fixtures hold a test open while another change saves.
- A passed test then saves nothing, a failed test names the tool that is saved now, and
  a change of another setting does not block the save.
- Store fixtures reject a change from an earlier title choice and an empty title tool.

- A CLI test runs a real test server with synthetic Code Puppy, Codex, and custom CLIs
  on its PATH. It verifies `bbflow title-tool list`, `show`, `set`, and `test`: the
  exact commands, the configured and not configured messages, exit status 1, argument
  errors, and unchanged settings after each failure.
- Web fixtures verify the title control states and the 100-second wait of
  `title-tool-set`. They also verify that a late reply of an earlier settings save, or a
  late settings read after a conflict, does not undo a title tool change. They verify
  that **Test** waits for an edit of the custom command to save.
- A browser check of a demo instance used synthetic Code Puppy and Codex CLIs on the
  PATH of the server, before the Custom choice.
- A selection of Codex showed the test state, then the list showed None again with the
  error.
- A selection of Code Puppy saved it with its title.
- A later appearance save from the CLI and from the page kept Code Puppy.
- No real agent CLI or model was used in these checks.

- A later browser check of a new instance tried Custom.
- A selection of Custom without a saved command showed the empty field and **Changes not
  saved**.
- A failing command showed the spinner, then the not configured error, with the command
  kept in the field.
- A passing command saved and showed its title.
- Apple then passed its test with `fm`.
- A change to None kept the custom command, and a new selection of Custom tested it at
  once.
- A restart of a demo instance with the new build upgraded format 14 to 15. It kept the
  settings revision, the selected title tool, and the port.

- Live checks of the Apple command used `fm` of macOS 27.0.1 with the FM1 terms, version
  1.0. Before the terms were accepted, `fm` ended with exit status 69 and a colored
  notice on standard error. After acceptance, 11 synthetic messages each gave a marker
  line and a title in 0.2 to 0.8 seconds.
- The messages were in English, Chinese, Japanese, and German. They included paths,
  process and SQL injection words, and a 3,480-byte message that the server cut at 2,000
  bytes. No message triggered the guardrails.
- Three runs of one message gave the same title.
- A message that told the model to reply with a fixed title got that title, so the first
  message can choose its own title.
- In a demo instance, **Test** passed, and a first send in a new session set the derived
  title and recorded the `title` event. With the full path, the command also ran with
  only `/bin` on the PATH. There, the bare name `fm` ended with exit status 127.

### Checks of the message editor

A Chrome check with a temporary shell verified divider movement, arrow keys, size
limits, and terminal dimension updates. It also verified preservation of editor size and
text across a project draft change. A narrow layout at 250% zoom kept the editor
controls reachable. Reloading a stopped session restored its draft and reset the divider
size. Touch devices and real agent CLIs were not used for this check. The temporary
shell and server were stopped.

A browser check of live draft sync used a temporary instance and two tabs on one draft.
Text typed in either tab appeared in the other tab within two seconds, with no reload.
After a synthetic zsh session started, Send from one tab ran the message. The editor in
the other tab cleared at the same time. The archive held four draft revisions: two
edits, the pending send, and the cleared draft. No browser errors were reported.

Fixtures check the [Add to message menu](#add-to-message-menu) and the
[saved prompts](#saved-prompts):

- Go fixtures check the prompt rules of a settings save. They cover the order, the
  trimmed names, names that differ only in letter case, the limits, and control
  characters. A format 19 archive upgrades to an empty prompt list with the same
  settings revision.
- Web fixtures check the insert at the cursor and in place of a selection, with and
  without the browser insert command. No text goes in while a send is pending.
- Web fixtures check that the menu shows the prompts of the latest read, the items that
  are off with their note, and a failed read.
- Web fixtures check the Prompts card: the editor, a revision conflict during an edit,
  moves, removals, and the toast after **Done**.

A check with headless Chrome 158 and the demo instance used the dark appearance at
1200 x 836 and the light appearance at 390 x 844:

- **＋** opened the menu above the button, outside the clip of the editor. The menu
  listed **Attach files…**, **Handoff prompt…**, the three demo prompts, and
  **Manage prompts…**. The menu fit the phone width.
- A prompt went in at the cursor after typed text, and in place of a selected word.
  Undo removed it, and the draft saved. The handoff prompt went in at the start of a
  draft, and the draft kept its text.
- **Manage prompts…** opened Settings with the Prompts card below the bar of
  Settings, and the page did not move. A name that differed only in letter case did not
  save. A new prompt saved at the end of the list. **↑** moved it and kept the focus.
  **Remove** asked first. The menu of another session then showed the new order.
- Escape closed the menu and returned the focus to **＋**. No browser errors were
  reported.

A second check with headless Chrome 158 and the demo instance used a second connection
as another view:

- **Insert in message** replaced a selected word with the handoff prompt. The editor
  had the focus, and Undo restored the word.
- With the menu open, a pending draft from the other view turned off **Attach files…**
  and the four saved prompts, and the note told why. The menu stayed open. The release
  of the lock turned the items on again and hid the note.
- The lock turned off **Attach files…** while it had the focus. The focus moved to
  **Manage prompts…**, and Escape then closed the menu.
- With the lock, Down moved from **Handoff prompt…** to **Manage prompts…**, and Up
  moved back.

These checks did not use Safari or a real agent CLI. The pending drafts came from the
other connection. No send in these checks lost its receipt.

### Checks of sent messages in the terminal

- Fixtures in `web/message-marks.test.mjs` cover the search of the terminal rows: a
  prompt before a message, the prompt characters of Claude Code and Codex CLI, wrapped
  and indented text, several lines, a frame character, a later quote, a message that
  the rows do not show, short messages, a shortened message, a long shell prompt, and
  attached file paths.
- The same fixtures cover the message that the view reads, the steps to the earlier and
  the later message, the step keys, the terminal of a message, and the time label. They
  also cover the terminal of a message among several terminals, also with a terminal
  that is still starting.
- The same fixtures cover the pages of the sent messages: the read past the messages
  of a later terminal, the end of the read before the start of the terminal, the limit
  of 200 messages after a reload, and the limit of 1,000 read messages.
- The fixtures also cover an earlier copy of a message after the application draws its
  output again, a message that starts at the first character of the terminal text, and
  a newest page that does not reach the read messages.
- `web/message-nav.test.mjs` uses a real xterm.js terminal without a page. A step uses
  the new row of a message after the scrollback drops rows. **Earlier message** turns
  on when the view moves from the first message into its response. An earlier terminal
  gets its message when a later terminal fills the newest page. A jump target near the
  end does not return after the view scrolls away and back. A reload reports a change
  only when the newest sent messages differ. A view that leaves its session hides the
  bar, stops its search, and reads nothing more.
- In the same file, a jump to another terminal waits for the first frame of that
  terminal, then puts the row of the message at the top. It ends without a jump when the
  terminal does not show the message. A change of the terminal and a step cancel it.
  A failed read of the newest page or of an older page ends it with an error. A jump
  after a failed read reads the newest page again, and a later read does not complete
  a jump that ended.
- `web/terminal-picker.test.mjs` covers a view that names the latest terminal by its
  run. It is a view of the latest terminal until a newer terminal starts.
- `web/message-jump.test.mjs` uses a fake page with replies that the test releases.
  A jump reads the list again, then opens the run of the message, also for the latest
  terminal. An older click stops when a newer click opened its terminal first, or when
  another open came during its list read. A newer click during the open of an older
  click waits for that open, and only the newer click scrolls. A move stops a click
  that did not open its terminal yet. A jump without a terminal list reports it and
  opens nothing. The fixtures also cover the error toasts, another action of the page,
  and a change of the session.
- `web/message-nav.test.mjs` reports a jump, a step, and **Latest output** as moves of
  the user, and a seek as no move. A real `MessageNav` and a `MessageJump`, wired as in
  the page, show that a jump in the shown terminal stops a pending jump to another
  terminal.
- In the same file, a real `MessageNav`, a `MessageJump`, and the click of the
  **Messages** view go through a failed read during a jump. The button of the message
  stays on, and a click reads the sent messages again and jumps. Other fixtures retry
  a failed older page, and a failed reload of the newest page after an earlier read.
- `web/sent-history.test.mjs` also covers the button after a failed read and the choice
  of a click: a jump in the shown terminal, an open of another terminal, or a new read.
- `web/sent-history.test.mjs` covers the **Show in terminal** button: the label for the
  shown terminal, the label and the tooltip for another terminal and for the live
  terminal, and an off button. It also covers the text of a terminal heading.
- `web/composer.test.mjs` covers the report of a send to the list: one report after a
  send with a receipt, one report after a lost receipt with the draft still pending,
  and no report for a message that the editor rejects. A newer draft from another view
  gives one report, from a connected watch and from a watch that connects again, also
  while this view has an edit that is not saved. A save that the server rejects gives
  one report.
- `web/workspace-pane.test.mjs` covers the **Messages** view: its panel, its switch
  button, and the close of the pane for a jump.
- A second browser check verified the order of the view switch and the toolbar icons,
  the label of the bar without the message text, and the editor without a **Sent
  messages** button.
- A browser check used the demo session **Tune the orbit solver** with the simulated
  Detail agent at 1500 x 900 pixels. The bar named message 8 of 8. **Earlier message**
  and **Later message** stepped between the messages, and each jump put the message row
  at the top. The second of two messages with the same text was found on its own row. A
  message of two terminal rows was found on its first row.
- In the same check, **Show in terminal** in the **Messages** view scrolled to its
  message, and the list marked the message that the view read. Command+Down and
  Ctrl+Shift+Up in the terminal stepped between messages. A new message from Send got
  the position 9 of 9, and the list showed it.
- The mark of a message row and the marks in the scroll bar showed in the dark and the
  light appearance. After a full frame, the marks showed again.
- At 375 x 812 pixels, the view switch showed **Messages**. **Show in terminal** closed
  the pane, showed the session, and scrolled to the message. The terminal did not take
  the keyboard focus.
- At 375 x 812 pixels, the demo session with two terminals showed the terminal selector
  on one row and the message bar on a second row, with no overlap. The terminal list
  opened below both rows.
- In the demo session with two terminals, the earlier terminal showed the one message
  that was sent in it. The latest terminal showed its two messages. The ended demo
  session showed its two messages.
- A browser check at 1500 x 900 pixels used the demo session **Refactor orbit in a
  worktree**. The **Messages** view showed a heading for each terminal and **Shown** on
  terminal 2. **Show in terminal 1** opened the earlier terminal, and the bar named
  message 1 of 1. Then **Show in terminal 2** opened the live terminal, and the bar
  named message 2 of 2. The list kept its messages and its position.
- A second check stopped the demo session **Tune the orbit solver** and continued it in
  terminal 2. From terminal 2, **Show in terminal 1** on the fifth message put its row
  at the top of the saved final screen. The bar named message 5 of 8. At 800 x 600
  pixels, the same kind of jump to the seventh message closed the pane first. It put
  the row at the top, and the bar named message 7 of 8.
- The terminal headings stayed at the top of the list in the dark and the light
  appearance.
- A two-tab check with a custom tool `exit`, whose terminal ends at once: tab A showed
  the saved screen of the latest terminal 4. Tab B continued the session with that tool
  in terminal 5. Tab A then showed `Terminal 4 of 5 · Demo agent · stopped` and **Back
  to latest terminal**. The terminal list kept terminal 4 as the current terminal, and
  a click on terminal 5 opened it. A second continue to terminal 6, with the list opened
  in tab A one second later, gave `Terminal 5 of 6` in the same way.
- A two-tab check used **Refactor orbit in a worktree**. Tab A showed terminal 1 with
  the **Messages** view open. Tab B stopped terminal 2 and continued in terminal 3. Tab
  A then showed `Terminal 1 of 3`, and its heading of terminal 2 showed `stopped`.
  **Show in terminal 2** opened the saved final screen of terminal 2, and the bar named
  message 2 of 2.
- In the same check, a message that tab B sent in terminal 3 appeared in tab A under a
  heading of terminal 3. **Show in terminal 3** joined the live terminal, without **Back
  to live terminal**, and Send turned on for typed text. Then tab B stopped terminal 3
  and continued in terminal 4. Tab A showed `Terminal 3 of 4 · Demo agent · stopped`,
  the hint of an earlier terminal, and **Back to live terminal**.
- The error toast for a message that the opened terminal does not show was not checked
  in a browser. The fixtures of `web/message-nav.test.mjs` cover the end of that jump.
- A timing run in Node.js searched 10,000 rows of 100 columns for 20 messages in about
  21 milliseconds: 12 milliseconds to read the rows and 10 milliseconds to search.
- Recordings of Claude Code 2.1.330 and Codex CLI 0.171.0 showed the characters `❯ `
  and `› ` before a sent message.
- A browser check with a real Claude Code 2.1.330 session in a demo instance sent one
  message from the editor. The bar showed `Message 1 of 1`, and **Earlier message** put
  the row of the message at the top. A second view with a different terminal width made
  Claude Code draw its output again and leave an earlier copy of the message. The
  search then took the earlier copy. The search now takes the last copy.
- A session with Codex CLI was not used for these checks, so the positions in its
  output are not verified in a browser.

### Checks of continuation and earlier terminals

- Continuation fixtures cover per-run replay, where an interrupted second run does not
  show the saved screen of the first run. They cover handoff folders with three
  terminals, newest-first order, tool names from start events and preparations, and
  exact messages grouped by terminal. They also cover Sent and Not confirmed states,
  fenced text, read-only files, and rebuilds without leftover staging folders.
- Request fixtures reject live terminals, old run IDs, running records, archived
  sessions, removed worktrees, missing workspaces, and unknown tools. They also reject
  an effort for Shell, a model for a Custom tool, and an effort that is not one word.
- A rejected request writes no handoff folder.
- Request fixtures verify the command, the tool name, and the tool ID of a new terminal,
  also with the model and the effort of a built-in tool.
- Store fixtures read the tool ID of a start event, also the empty ID of Shell. An older
  first run without a tool ID uses its preparation, and an older later run has no known
  ID.
- Web fixtures verify the tool that the dialog selects: the tool of the latest terminal,
  then the tool of the first terminal, then the default tool, then Shell. When Shell is
  off, the first tool takes its place.
- A startup command can contain literal `{prompt}` text.

A temporary server test starts a worktree session with a synthetic tool and sends one
editor message. It stops the session and continues it with the same tool. It verifies
the startup command, absence of automatic handoff input, the worktree path, the handoff
files, and the rejection of a second continue request. A request with a model for its
Custom tool fails before the server writes the handoff folder. After a server restart,
it continues with Shell. The README lists both earlier terminals, newest first. The
terminal list then gives the tool ID of each terminal, with the empty ID for Shell.

Earlier-terminal fixtures cover the terminal list with tools from start events and from
the preparation, a `starting` terminal without a run record, and the change to its run.
They cover a resume of an earlier run while a later run is live. That view gets the
saved screen of its own run and `history-end`, and the live run gets no new view. A run
of another session is rejected before any frame. Browser fixtures cover the selected
run, steps at both ends, labels, local times, and a reconnect that keeps an earlier run.

- A browser check with a temporary instance and `/bin/sh` made three Shell terminals in
  one session.
- The selector was hidden for one terminal.
- The list showed three terminals in start order.
- Terminal 1 and terminal 2 showed their own output with input and Send off.
- The sidebar did not count those views of the live session.
- **Back to live terminal** joined the third terminal, and Send then reached it.
- After a server restart, the button was **Back to latest terminal**, and Escape closed
  the list.
- **Continue in new terminal** then started a fourth terminal.
- No browser errors were reported.
- No real agent CLI was used.

`codex sandbox` from Codex CLI 0.160.0, with default settings, read the handoff
`README.md` from outside its working directory. In the same sandbox, `bbflow query`
failed with "connect: operation not permitted". These checks ran no model.

Earlier live checks verified that Codex CLI 0.160.0 and Claude Code 2.1.312 could read
the handoff files. See the [v0.0.5 release notes](releases/0.0.5.md#validation) for the
agent versions, permission modes, and results.

### Checks of history search

History search fixtures cover scope, archived sessions, older terminals, literal
wildcard characters, Unicode folding, split output, overlapping matches, bounded
context, and fixed pagination cutoffs. Reopen checks preserve original recording bytes.
A concurrent read check leaves capture writable. Invalid requests and canceled reads
fail explicitly.

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
explicit scope changes. They verify that the project menu selects **This project**
without a session. They also verify rejection of stale search and context replies.
A real temporary server check searches two synthetic shell terminals while the latest
terminal remains writable. It reads earlier context, archives the session, restarts the
server, and searches the same recordings again. No real agent CLI is used.

A compiled server upgraded an 8.5-million-event synthetic archive from format 6 to 7.
Search pagination, context, terminal lists, and newest-result reads passed. Reopen
checks preserved event counts, sequence allocation, and original byte lengths. The
temporary server was stopped. No user archive or real agent was used.

A browser check with synthetic history verified session, project, and all-session
scopes. It verified archived results, oldest-first pagination, context expansion, case
matching, and plain-text rendering of markup. A live synthetic shell remained usable
after search. The dialog also fit a 390-pixel viewport. The browser reported no errors
or warnings. The temporary shell and server were stopped after validation.

### Checks of the Changes pane

These checks apply to the [Changes pane](#changes-pane) and its file menu.

#### Fixtures for diffs and scopes

- Changes pane fixtures use temporary Git repositories. They cover added, modified,
  deleted, renamed, binary, and untracked files, and names with spaces, Unicode, and
  newlines.
- They also cover files above 1 MiB, invalid UTF-8, symlinks inside and outside the
  workspace, `..` and absolute paths, and folders.
- Other fixtures cover subfolder sessions, repositories without commits, folders
  outside Git, missing workspaces, and both baselines of a managed worktree after an
  agent commit.
- Commit baseline fixtures cover the commit list with its file counts, a subject with a
  tab, the changes from a commit, one commit, a range of commits, and the file at a
  commit. They also cover a rejected to commit, a root commit, file counts with
  `diff.renames` and `log.showRoot` off, the list and output limits, a shallow clone,
  unknown commits, and a rebase.
- Merge base fixtures cover a feature branch, a subfolder session, `origin/HEAD` of a
  clone, local commits on `main` of a clone, and `main` without local commits. They
  also cover a base request after the base is gone, and branches without a common
  commit.
- Scope fixtures cover the requests and the labels of each scope, ranges in either
  order, and the steps of `[` and `]`.
- Pane fixtures cover the requests after a file reply without the selected commit, a
  failed list read after it, and a late file reply after a new choice. They also cover
  two dots, a cancel with the same dot, a range of every row, the focus after a row,
  the keys, a base that is gone, and the notice of omitted commits with an empty list.

#### Fixtures for folders and lists

- Folder list fixtures cover the entry order, ignore marks, a nested repository,
  `.git`, and symlinks inside and outside the workspace. They also cover missing
  folders, the entry limit, a folder outside Git, a missing Git executable, and a
  failed ignore check.
- A WebSocket fixture sends `workspace-file` and `workspace-folders` through the
  server.
- Web fixtures cover the file list, the filter, the tree rows and their notes and
  marks, the folders of a refresh, the language choice, the layout width rule, and late
  replies.
- They also cover replies for a folder that closed or opened again, a refresh at the
  shared entry limit, a folder that is gone, and a failed request for one folder. They
  cover the unread folders of a failed refresh, and a failed first read of the
  workspace folder.

#### Fixtures for images and Markdown

- Image fixtures cover PNG, JPEG, GIF, and WebP sides from Git and from the workspace,
  a format change, and an image above 1 MiB. They also cover an image and other binary
  data above the limits, text with an image extension or an image signature, text
  above 1 MiB with an image signature, and an SVG symlink.
- A change list fixture counts an untracked image above 1 MiB as binary. It also counts
  text above 1 MiB with an image signature as text, even when the read of its first
  bytes cuts a character.
- A WebSocket fixture sends two 5 MiB image sides in one reply.
- Web fixtures cover the image URLs, SVG text in a URL, the shown sides and their text
  or notes, a rename from an SVG path, Git LFS pointer text in an SVG path, the
  captions, and the size text.
- SVG root fixtures use a test double for the XML parser, because Node has no
  `DOMParser`. They cover the root name, the namespace, a parse error, and one parse
  for each side.
- Pane fixtures cover an image diff in both layouts, **View source** with an SVG file
  and next to a PNG file or a binary side, and a rename from an SVG path.
- Markdown fixtures cover raw HTML, script links, relative and allowed links, images,
  tables, task lists, and escaped task markers. They also cover syntax colors and
  escaped text in fenced code, and the files that Preview accepts.

#### Fixtures for the file menu

- File menu fixtures cover **Copy path** with and without a known workspace, **Copy
  relative path**, and a failed copy.
- They also cover the `workspace-reveal` request, **Shown in Finder**, the full text of
  an opener error, and a late reply of an earlier click.
- They cover the end of a result at a change of the file and of the session, and a
  reply after that change.
- They also cover no **Show in Finder** for a deleted file, a symlink, a commit scope,
  a file before its reply, and a file at a commit after a change to **Uncommitted
  changes**.
- Server fixtures check that an opener error has no prefix.
- Server fixtures for **Show in Finder** cover a file, a script file, and a folder.
  They also cover a symlink, a path through a symlink, a path outside the workspace, a
  missing file, `..` and absolute paths, an unknown session, a failed opener, and a
  server without an opener.
- A WebSocket fixture sends `workspace-reveal`.
- Opener fixtures replace `open`, so they show no Finder window. They cover the
  arguments of `open -R`, a relative path, and a failed exit with its output.

#### Fixtures for Open in browser

- Open in browser fixtures cover `.html` and `.htm` in any case, a Markdown file, a
  script file, a symlink to a script, and a path through a symlink.
- They also cover a path outside the workspace, a folder, a missing file, `..` and
  absolute paths, an unknown session, a failed opener, and a server without an opener.
- A WebSocket fixture sends `workspace-open`. The tests replace the opener, so they
  open no browser.
- Opener fixtures replace `open`, `xdg-open`, and `osascript`. They cover a child that
  keeps the output pipes open after a successful exit, a failed exit with its output,
  and a cancellation. They also cover the arguments of `open -a`, a relative path, and
  an empty or failed browser lookup.
- Web fixtures cover the files that the menu item accepts, the request, **Opened in
  browser**, and an error. They also cover a scope change before the file reply, a late
  reply of an earlier click, and a late reply after a change of the file.

#### Browser checks

**Diff views.** A browser check used a temporary instance, a fixture repository, and a
shell session in a managed worktree.

- It checked Split, Unified, folded regions, View file, deleted files, symlinks, binary
  files, both baselines, a session outside Git, and an ended session.
- It also checked two tabs with separate selections, a phone width without horizontal
  scroll, and an empty browser console.
- Script text in a file showed as text.

**Markdown preview.** A browser check of Preview used a demo instance with a synthetic
Markdown file.

- It checked an added file in Changes and an unchanged file in Files.
- It checked headings, a table, task lists, a code block, raw HTML and script links as
  text, an image placeholder, and an allowed and a relative link.
- It also checked that a deleted file and a Go file show no Preview button.
- It checked Esc, ✕, light and dark Appearance, a phone width without horizontal
  scroll, and an empty browser console.
- A later check of Preview covered fenced code with Go, shell, and no language, in
  light and dark Appearance. It also checked the syntax colors of a Go diff and a
  Markdown file view, a phone width without horizontal scroll, and an empty browser
  console.
- A headless Chrome check with emulated forced colors showed separate checked and open
  task boxes. Code in a level 4 heading kept its case.

**Images.** A browser check of the image view used a demo instance with a modified PNG
file and a modified SVG file that has only a `viewBox`. It also used an added PNG file
of 1.8 MiB and an added SVG file with a script, an `onload` attribute, and an external
image.

- It checked Split, Unified, the captions, **View source** and **View image**, the
  Files view, fit and actual size with scroll bars, and light and dark Appearance.
- The script and `onload` did not run, and the browser sent no request for the external
  image.
- It also checked a phone width without horizontal scroll and an empty browser console.
- A browser check compared the SVG root rule with the decoding of an `img` element for
  nine SVG texts. They had a prefix, a non-ASCII prefix, a character reference in the
  namespace, a comment in a document type declaration, an `svg` element in a comment
  before another root, no namespace, LFS pointer text, and malformed XML.

**File menu.** A browser check of the file menu used a demo instance.

- The browser pane did not allow clipboard access, so the check recorded the copied
  text in the page.
- **Copy path** gave the absolute path in the demo instance, and **Copy relative
  path** gave the path of the header.
- **Show in Finder** got a success reply, and the server ran `open -R` on macOS. The
  check did not examine the Finder window.
- It also checked the arrow keys, Escape, a deleted file, the Files view, the session
  More actions menu, light and dark Appearance, and an empty browser console.

**Open in browser.** A browser check of Open in browser used a demo instance with a
synthetic HTML report.

- It checked an added file in Changes, an unchanged file in Files, and no button for a
  commit scope.
- The server ran `open` on macOS, and the button showed **Opened**.
- A WebSocket upgrade with `Origin: null`, as a `file:` page sends, got status 403.
- The check did not examine the browser window that opened.
- A later check used `open -a` with the default browser. After the click, Chrome, the
  default browser, was the front application. On that computer, Chrome also owns HTML
  files, so this check cannot show the difference from the file type. The `open -a`
  fixture covers it.
- A headless Chrome check of a `file:` page loaded a style sheet from a folder outside
  the folder of the page. In the same page, `fetch()` of that file failed, and
  `self.origin` was `null`.

**Files tree.** A browser check of the Files tree used a temporary instance, a fixture
repository, and a folder outside Git, each with a shell session.

- It checked open and closed folders, ignored entries, status letters, folder dots, a
  symlink, a binary file, the file view and the diff of a changed file, the filter list
  with a deleted file, and a refresh after a folder was removed.
- It also checked the folder outside Git, an ended session, a phone width without
  horizontal scroll, and an empty browser console.
- A later check opened a folder with Enter and moved to its first entry with Tab. It
  also refreshed the tree with an open folder of 20,000 files, and each open folder
  kept its entries.
- A simulated connection failure of the request for one folder kept that folder open
  with its entries and showed the error.
- With a folder that opened just before the refresh, the pane still read that folder
  after the failure. It also read that folder after a failure of the refresh request.
- A simulated failure of the first read of the workspace folder showed the failed note
  and the error. A slow refresh then showed "Reading…", and the tree came back.

### Checks of the side terminal and the workspace pane

- A side terminal fixture uses a live server and `/bin/sh`. It checks the workspace and
  `BBFLOW_SESSION` of the shell, and that two views share one shell. It checks that the
  shell continues after its views close and after Stop session. It also checks
  `side-terminal-stop`, a shell that exits, archive, and refusal for drafts, archived
  sessions, and unknown sessions.
- It checks that a resume or stop with the ID of an ended shell does not join or stop a
  later shell. It checks that SQLite has no side terminal events and that the session
  gets no status messages or view count from them.
- Web fixtures check that a lost side terminal rejoins with `side-terminal-resume` and
  the ID of its shell, and never starts another shell.

- A browser check of the side terminal used a temporary instance and a shell session. It
  checked commands in the session workspace, hide and reopen with the same shell, the
  fit to a larger window, Stop shell with its exit code, and **Start shell**. It also
  checked that a return to the session joins without a start.
- A query found no side terminal output in SQLite.
- A later check of the workspace pane checked the three icons, a separate selected file
  in each view, **View diff** from Files, the Changes header only in Changes, a folder
  outside Git, and an empty browser console. It also checked that a hidden terminal
  stays connected and keeps its size.
- Web fixtures check the view switch: one pressed button, the same state as the icons,
  a shell start from **Terminal**, and no switch without a session. They also check
  that a click on a file shows the file view, that **← Back**, a change between Changes
  and Files, and another session show the list, and that a return from Session or
  Terminal keeps the file view.
- Web fixtures check the focus of the sidebar drawer. The open drawer gives the focus to
  the selected row or to itself, and the main area is inert. Escape and a click outside
  the drawer give the focus back to the terminal, or to the toolbar button when the
  terminal is gone. The sidebar of the regular layout does not make the main area inert.
- A browser check of the mobile layout used a demo instance at a width of 390 pixels.
  It checked that the page does not scroll, the drawer with its three ways to close, the
  four views of the switch, the file list and **← Back**, **Stop session** and
  **Continue in new terminal** in the More actions menu, a draft, Settings, and the
  welcome view. The browser console was empty. The check used a desktop browser with a
  mouse. It did not use a phone, touch input, or an on-screen keyboard.
- Web fixtures check the parts of the touch scroll: the whole rows of a drag and the
  rest for the next movement, the release speed from the last 100 milliseconds, no
  glide for a slow or rested finger, and the end of a glide. They also check the
  direction of a drag, with a horizontal swipe of 240 pixels that drifts 36 pixels
  down, and the shown part of a lower view at each end.
- Web fixtures run the touch handler with a simulated view of 30 rows. A movement of 75
  pixels across the first shown row moves the view 4 pixels, scrolls 4 history rows of
  16 pixels, and keeps 7 pixels for the next movement. A movement across the last
  shown row does the same in the other direction. With mouse reports on, the movement
  sends 4 wheel events. A horizontal swipe with a drift moves nothing. A glide ends
  when the stop function of typed input runs, and when a touch starts.
- Web fixtures check the end of a touch. A vertical drag cancels it, also a drag of 9
  pixels that scrolls no row. A touch that stops a glide cancels it too, also when it
  moves 8 pixels to the side. A tap, a movement of less than 8 pixels, a horizontal
  swipe, and a touch cancel do not cancel it.
- Web fixtures check that a glide has no frame after its last step. A glide runs one
  frame for each step of `glide` until the speed is 0, and a tap after it keeps its
  click. A fast drag with mouse reports asks for no frame, and a tap after it keeps
  its click. The touch events and the frames use one clock. The fixtures do not run a
  browser. No check used a phone or a simulator with real touches.
- Web fixtures check the shown part of a lower view after a frame. Without a drag, the
  view shows the new cursor row. After a drag, the view keeps its part until typed
  input, a size change, or a drag back to the cursor row. Other fixtures check the
  keyboard height from the visual viewport, with a low bar and a pinch zoom, and the
  shown part of a terminal that is higher than its view.
- A simulator check of touch input and the on-screen keyboard used a demo instance in
  Safari on an iPhone 17 simulator with iOS 27.2, in light Appearance. The simulator
  tool sent the touches and the text.
  - A slow drag of 163 points in the session terminal scrolled 7 rows of 21 points. A
    fast drag of 150 points scrolled 25 rows and stopped.
  - A tap in the message editor showed the keyboard with no zoom. The toolbar stayed at
    the top. The view switch and the bar above the terminal were hidden. Seven terminal
    rows with the cursor row, and the editor of 2 lines, showed above the keyboard.
    Typed text of 3 lines made the editor 3 lines high.
  - The keyboard went away and showed again two times. Each time, the page used the
    full window and then the part above the keyboard, with the toolbar at the top.
    Safari gave `window.innerHeight` the height of the visual viewport some time after
    the keyboard showed, so the page does not use that value.
  - **Send** showed without the key symbols. It sent the message, the keyboard went
    away, and the page used the full window again.
  - In the side terminal, the keyboard left 16 of 30 rows in the view, and the size
    stayed 50 × 30. After `seq 1 40`, the prompt row was the last shown row.
  - With the keyboard for the sidebar search field, the drawer ended above the
    keyboard, with no zoom.
  - With mouse tracking mode 1000 and the SGR encoding on in the side terminal, a fast
    drag of 100 points sent five wheel reports, one for each row that the finger
    passed. No report followed the release, and the size stayed 50 × 30.
  - With the keyboard and 30 full rows in the side terminal, a slow drag of 140 points
    down showed rows 6 to 22 in place of the last rows. The typed letter `x` showed the
    prompt row again.
  - In the session of the Busy agent, which prints one line each second, the view
    showed each new line while the keyboard showed. After a slow drag of 130 points
    down, the view kept the earlier lines for 3 seconds of new output. In an idle
    session, the same drag moved the view 126 pixels.
- A browser check with a keyboard state that a script set used a demo instance and
  touch events from the script.
  - At a width of 390 pixels with 10 terminal rows in a lower view, a drag of 75 pixels
    down from the first shown part scrolled 3 history rows. A drag of 400 pixels down
    from the last shown part first showed the first screen row and then scrolled the
    history. Two drags up went back to the prompt row.
  - A touch that moved 240 pixels sideways and 36 pixels down changed no row and no
    scroll position.
  - At a width of 844 pixels with 300 pixels above the keyboard, the main area had a
    height of 300 pixels and did not scroll. The toolbar ended at 96 pixels, the
    terminal had 44 pixels, and **Send** ended at 273 pixels. The divider was hidden.
  - At a width of 500 pixels, the search field of Changes and of Files and the message
    editor had a font size of 16 pixels. At 1280 pixels, the search field had 12
    pixels, and the session had its divider and its editor of 240 pixels.
- That simulator check did not use a real phone, a Home Screen web app, Android,
  landscape orientation, dark Appearance, or a real agent CLI. A tap in the session
  terminal did not show the keyboard. A second tap in the side terminal showed it. The
  cause was not examined.
- A simulator check of the toolbar used a demo instance as a Home Screen web app on an
  iPhone 17 simulator with iOS 27.2, in dark Appearance. Without the sticky toolbar,
  the system blurred the session title. With it, the title was sharp after a page
  reload and after a new start of the web app. The More actions menu opened above the
  view switch.
- A browser check at a width of 390 pixels and a height of 500 pixels scrolled a draft
  by 300 pixels. The toolbar stayed at the top, and its More actions menu opened above
  the form. These two checks did not use a real iPhone, light Appearance, a toast, or a
  visible page bar.
- A browser check at a width of 390 pixels and a height of 500 pixels moved the focus
  through the controls of a draft with Shift+Tab. Each control with the focus was below
  the toolbar. At a height of 188 pixels, the More actions menu of an ended session
  scrolled. Down Arrow moved the focus to **Archive** and showed it. The mouse wheel
  scrolled the menu and not the main area.
- A browser check of the view switch used window widths of 885, 1280, 1500, and 1700 pixels.
  At 885 and 1280 pixels, the sidebar stayed and the switch showed each view in the
  full main area. At 1280 pixels with a hidden sidebar and at 1500 pixels, the session
  and the pane showed side by side, with 82 terminal columns in the session. In the
  pane of 455 pixels at 1500 pixels, the file list and the file view showed one at a
  time. At 1700 pixels, the pane showed them side by side.
- A browser check at 390 pixels opened the drawer with Command-B from a focused live
  terminal, then typed `x` and pressed Escape. The drawer closed, the terminal got the
  focus again, and the archive recorded no input. A second check showed Changes,
  selected another session, and returned. The archive recorded no resize, and the PTY
  kept 40 columns and 18 rows.

### Checks of terminal views

- Frame fixtures cover independent viewport sizes, size owner changes, input from every
  view, receipt routing, slow views, final-frame ordering, and ended-screen
  reconstruction.
- A fixture checks that a new terminal starts at the smallest size that a view asks
  for. Another fixture checks that a hidden terminal joins with the size of its session,
  else the latest size of another session terminal, else 80 × 24.
- A connection fixture checks that a view sends each size once. A second fit with the
  same size before the frame of that size arrives sends nothing. A return to the size of
  the request before that frame sends that size. After a reconnect, the size of the new
  request counts as sent.
- Fixtures with the xterm.js engine check a full frame. At the end of the task that
  receives the frame, the view shows the earlier frame at the earlier size. With a
  resize that takes 15 ms, xterm.js still resizes the view and parses the frame data
  before the next task. Each frame gets one acknowledgment. A full frame that arrives
  just before the connection fails reaches the view with its history rows, and the
  stream does not acknowledge it.
- Fixtures with a fake view check that a full frame is one write, and that the handler
  of its reset sets the frame size. A delta frame has no erase, reset, or resize. A new
  stream of a view that still has a full frame of an earlier stream to parse keeps the
  size of each frame.
- A fixture checks the fit with the cell sizes that xterm.js 6.0.0 measured in Chrome
  for both terminal fonts, at device pixel ratios of 1, 1.5, and 2. For each area from
  20 to 2,600 pixels, the fit gives the largest count of cells that xterm.js draws in
  the area. In an area 2,278 pixels wide at a ratio of 1, the fit addon of xterm.js asks
  for 290 columns at 147 columns, then for 291 columns. In an area 130 pixels high at a
  ratio of 2, it asks for 6 and 7 rows in turn. The fit gives 291 columns and 7 rows.
- Go tests check that a resize of the size owner wakes its view only when the emulator
  applies the resize. A view without the size gets its frame at once. A resize of the
  size owner to the emulator size also gets its frame at once. Output before the
  emulator resize gives the size owner no frame. Then the resize gives one full frame
  of the new size, with that output. The same tests cover a view that joins as the size
  owner with another size, and a view that takes the size after the size owner leaves.
  A return to an earlier width waits again, also after a pause of more than a second.
- A browser check pushed full frames through `TerminalStream` with 10,000 history rows,
  and a resize that took 15 ms, so that xterm.js yielded where it could. It read the
  rows just before each paint, for four screens:
  - text only on the last row, from 24 to 12 rows.
  - text only on the first row, from 24 to 12 rows.
  - text only on the first row and a hidden cursor on the last row, from 24 to 12 rows.
  - a label at the right edge, from 80 to 40 columns.

  Each screen showed its earlier text until the new frame. Before the change, each
  screen painted an empty view.
- A browser check loaded xterm.js 6.0.0 in Chrome at device pixel ratios of 1, 1.5,
  and 2. It compared the fit addon of xterm.js with the fit for areas 220 to 2,620
  pixels wide and 100 to 1,400 pixels high, from several current sizes. The fit addon
  asked for a second size for 10 to 12.5% of the widths. At ratios of 1.5 and 2, it
  asked for a second size for 3 to 6% of the heights, and it never settled at 6 to 10
  heights for each font. The fit gave the same size from each current size. That size
  never overflowed the area, and one more cell always overflowed it.
- A browser check used the demo session **Review test failures** at 2560 × 1200 pixels
  and a device pixel ratio of 2. Its shell printed 4,000 rows of different lengths. The
  check opened and closed the side terminal three times, made the window narrower,
  wider, lower, and taller, and dragged the terminal divider and the workspace divider.
  It ran with an idle shell, then with a status line that changed every 60 ms. It read
  the rows of the main terminal just before each paint. Before the change, 75 resizes
  gave 85 full frames. Each full frame painted an empty terminal for 164 to 383 ms, 19
  seconds in total. A narrower window sent 196 columns, then 197 columns. With the
  change, 72 resizes gave 67 full frames, and no paint showed an empty terminal. Each
  window change sent one `resize`.
- In the same check, a window 1,186 pixels high gave a terminal area 722 pixels high.
  Before the change, the view then sent `resize` messages without end, for 38 and 39
  rows in turn. With the change, it sent none.
- A browser check with the demo instance at 1400 × 900 pixels loaded the page, then
  opened live sessions six times in turn. Before the change, each open sent the request
  at 23 × 130 and then one to three `resize` messages, such as 21 × 128 and then
  21 × 130. The archive recorded 20 `resize` events. With the change, each open sent
  only the request at 21 × 130. The archive recorded 4 `resize` events: one for the
  first view of each session, because the seed starts each PTY at 30 × 100.
- The same check opened an ended session, a Shell session, an earlier terminal, and
  **Back to live terminal**. Each sent only its request. Steps of the divider and
  changes of the window width and height each sent one `resize`. The other dimension
  stayed the same.
- At 375 × 812 pixels, each open sent only the request at 26 × 39. The demo session
  with two terminals also sent one `resize`, to 22 × 39, when the open completed. At
  400 × 812 and at 768 × 812 pixels, the results were the same: that session sent one
  `resize`, and the other sessions sent none.
- In a new tab at 375 × 812 pixels, **Messages** was selected before the first fit. The
  hidden terminal joined at 24 rows and 80 columns.
- Terminal tests cover the row limit of each width, the allocation of a resize to more
  columns, the scrollback size budget, frames at the message limit, and the
  narrower-view row cache.
- Fixtures with the xterm.js engine check the rows of an ended terminal. A taller view
  shows history rows above the last row with text. Blank rows fill the bottom when the
  history has too few rows. Blank rows below the last row with text do not hide the
  history, also at the saved number of rows. A cursor row below the last row with text
  stays the last row. A row with a background color, in the format of the server, counts
  as a row with text. A lower view keeps the last row with text. A full scrollback keeps
  all history rows after a lower and then a taller view. The cursor returns to its
  recorded row after a lower and then a taller view. Each fit ends with a cursor move,
  so that xterm.js moves its input element to the cursor. Requests during a fit end with
  the rows of the last request.
- A terminal test checks that the server renders a row with only a background color as
  styled spaces, and a blank row with no cells.
- A Go test ends a process with two views. The narrower view gets the saved screen at
  the terminal size as its last full frame before `exit`. The view of the terminal size
  gets no extra frame.
- A browser check used a demo instance. A session stopped while its view had 6 rows,
  so its saved screen had 90 columns and 6 rows. After the stop, the view had 20 rows in
  a window 900 pixels high. After a reload, it had 25, 6, and 34 rows in windows 1000,
  650, and 1150 pixels high. Each count was the number of rows that fit. The terminal
  area did not scroll, and the last recorded rows stayed the last rows. The view of an
  earlier terminal had the same results in windows 700, 1000, and 1150 pixels high.
- A browser check showed one demo session in two tabs, 92 and 61 columns wide. The
  wider tab owned the PTY size. After Stop in that tab, the narrower tab showed the full
  rows of 92 columns, as after a reload, and it had as many rows as fit. No event
  followed the saved screen in the recording.
- Cross-engine fixtures compare the input modes of a view with xterm.js after each
  frame: cursor keys, keypad, bracketed paste, focus reporting, each mouse tracking
  mode, and each mouse encoding. A Go test checks nine mode sets in two views. One
  view joins and gets a full frame. The other view shows the terminal and gets a frame
  with the changed modes. Both views get the modes of the application, and a second
  frame keeps them.
- A browser check with mouse tracking mode 1000 and the SGR encoding on showed that a
  click in the terminal sent one SGR report for the press and one for the release. The
  view that showed the terminal when the modes changed sent them, and so did a view
  that joined after the change.
- Cross-engine fixtures compare Go-generated frames with xterm.js for cells, styles,
  cursor, scrollback, resize, split escapes, Unicode, and alternate screens.
- Fixtures with xterm.js check the focus reports of a view. A frame that sets the focus
  reporting mode sends no input. A later focus report and typed data are sent, also
  after a frame that the view parsed while its input was off.
- The same fixtures check the report mark with events in dispatch. A focus report and a
  mouse report in each encoding have the mark while the mode is on. A paste and a key
  with the bytes of a report do not have it. Data after the end of a mouse event does
  not have it, as composed text from a timer. A mouse report after an inner focus event
  has it.
- A terminal test checks the modes of frames. A full frame sets each mode. A redraw
  writes no mode. A changed mode writes only that mode, and a mouse tracking mode
  turns off before another one turns on. A view that crops the cursor shows it again.
- A server test checks the size owner with reports. A focus report and a mouse report
  from another view reach the process, and the PTY keeps its size. A typed key from
  that view resizes the PTY first. Marked input resizes the PTY when the frames of the
  view have the mode off. A report also keeps the PTY size when the application changed
  the mode but the view did not acknowledge that frame.
- The server test checks input without the mark that has the bytes of a report, as a
  paste has. It resizes the PTY, and the process gets the same bytes, also for a
  position that a report would change or that is outside the terminal. A report with an
  `id` keeps the PTY size, gets its terminal row, and gets its receipt.
- The server test and a terminal test check the position of a mouse report. A click on
  row 2 of a view with 10 rows reaches a PTY with 24 rows as row 16. A click in the
  padding of a larger view does not reach the PTY. A press on a terminal cell with a
  release in the padding reaches the PTY with the release on the nearest cell, also
  with a frame between the press and the release. After a full frame, a motion in the
  padding does not reach the PTY. The terminal test also checks drags in each encoding,
  two buttons, a motion with no button after a press, the report formats for each mode,
  the pixel encoding, and the limit of the default encoding.
- A browser check used a PTY of 39 columns and 21 rows, and a second view of 82 columns
  and 16 rows. A click on row 5 of the second view reached a program in the terminal as
  row 10. A click on column 74 of that view did not reach the program. The PTY kept its
  size.
- A browser check dragged from a terminal cell to the padding of a view of 82 columns
  and 16 rows, with a PTY of 39 columns and 7 rows and mouse tracking on. A frame came
  between the press and the release. It was not a full frame, and it had no mode
  sequence. The view sent the release, and a program in the terminal got the motion and
  the release on column 39. A pointer move in the padding after the release did not
  reach the program. With a PTY of 21 rows, the frame was a full frame, and the view
  sent no release.
- A browser check read the input messages of a view with focus reporting and mouse
  tracking on. A focus change, a click, and a pointer move sent input with the report
  mark. A typed key and a paste of `ESC [ I` sent input without the mark. The paste
  reached a program in the terminal with the same bytes, and the PTY changed to the size
  of that view.
- A browser check showed one session with focus reporting and mouse tracking on in two
  views, of 82 and 39 columns. No view sent input in 4 seconds without a user action,
  and the PTY kept its size. A program in the terminal got one report for each focus
  change. A click and a pointer move in the view without the size sent a focus report
  and mouse reports, and the PTY kept its size. A typed key in that view then changed
  the PTY to the size of that view one time.

- TypeScript fixtures cover reconnect delays, canceled retries, uncertain session
  starts, identity checks, binary input, and input guards for inactive views. They also
  cover ended views, slow sends, disconnects without input retry, frame parsing and
  acknowledgments, paste boundaries, and file references.
- Draft watch fixtures cover the watch request, keepalive, reconnect, identity errors,
  and the rule for applying a pushed draft.
- Go tests check embedded assets and browser origin restrictions.
- CLI fixtures check the home-page opener, instance selection, invalid arguments,
  removed session commands, and opener failures.

Activity fixtures check stable ordering across same-size reattachment, real PTY resize
notifications, and promotion by detached output. The redraw after a real size change
does not promote the session. History tests exclude drafts, display events, and quiet
events from recency and its timestamp tie-break. They also check creation order
for equal timestamps. Server tests cover start/stop/restart, instance isolation, stale
or tampered metadata, protocol checks, idle peers, and shutdown with stalled views.

A browser check without the controller role used a temporary instance and a synthetic
zsh shell. Two tabs with 82 × 15 and 156 × 38 terminals shared one session. Each tab
typed `stty size` with no control step. The shell reported the size of the tab that
typed. Send from the larger tab reached the shell. The recorded PTY size changed only
when the other tab sent input. No browser errors were reported. No real agent CLI was
used.

A browser check with a synthetic terminal confirmed live reattachment, switching
sessions, stop followed by history reload, and page reload at a different window width.
The final display kept its recorded width. This check did not run a real agent CLI.

### Checks of storage and upgrades

- Frozen schemas from repository history test upgrades from formats 3–20 to format 21
  and verify that reopen preserves the upgraded data. The format 16 fixture has Codex
  and Code Puppy tools, and the upgrade gives them their types. A blocked preparation
  update rolls back migration 17. The format 17 fixture has both values of remote
  access, and the upgrade turns its switch on. A blocked settings update rolls back
  migration 18. No upgrade pins a session. A `pinned_at` column that exists before the
  upgrade rolls back migration 19. Each upgrade adds an empty prompt list, and a blocked
  settings update rolls back migration 20. No upgrade marks an event quiet. A `quiet`
  column that exists before the upgrade rolls back migration 21. Four concurrent opens
  upgrade a format 19 or format 20 archive once.
- Fixtures compare original blobs, archive flags, metadata, and event allocation state.
  They test rollback of the entire upgrade after SQL, schema, or foreign-key failures.
  They also cover repeated opens, concurrent upgrades, and unsupported formats.
- Server subprocess fixtures test migration before queries, interruption recovery, and
  restart without duplicate notices. These checks use temporary synthetic databases.

A compiled release binary also passed startup, SQL queries, restart, and shutdown with
temporary format 3–6 fixtures, running outside the repository. Checks confirmed format
6, preserved original event bytes and archive flags, and one interruption notice after
restart. All temporary servers were stopped. No user database or real agent CLI was used
for these upgrade checks.

Storage and composer tests cover read-only queries, cancellation and limits, format
rejection, persistence, and original bytes. They also cover the latest-save rule,
rejected saves after a send, draft watch pushes, pending submissions, attachment limits,
and cache reconstruction after database reopen.
