# bbflow command reference

This guide covers bbflow CLI commands, when to use them, and what they change. The CLI
connects to a separate local server. Commands may change during early development.
Supported database formats upgrade automatically while preserving stored data.

The CLI command and executable use the name `bbflow`. From a local checkout, use the
path to your executable, such as `./bin/bbflow` or `./bin/release/bbflow`. Replace
uppercase placeholders such as `SESSION_ID` with your own values. Brackets in usage
lines identify an optional argument. Do not type the brackets.

Each command section gives the usage, the behavior, and an **Impact** paragraph. The
Impact paragraph tells what the command changes.

See [README.md](../README.md) for installation, [DEVELOPMENT.md](DEVELOPMENT.md) for
local builds, and [SPEC.md](SPEC.md) for implementation details and current limitations.

## Command summary

| Command | Use it to | Impact |
| --- | --- | --- |
| [`bbflow`, `bbflow help`, `bbflow --help`, `bbflow -h`](#help) | Show available commands. | Displays help only. |
| [`bbflow --version`](#executable-version) | Show the executable version. | Prints a release version or `dev`. Does not contact a server. |
| [`bbflow server start`](#start-the-server) | Start the local server in the background. | Creates the data directory and log. Adds the macOS menu. The server continues after the terminal closes. |
| [`bbflow ui`](#open-the-web-ui) | Open the web UI home page in the default browser. | Verifies the selected running server, then launches its home URL. Starts no server or agent. |
| [`bbflow server stop`](#stop-the-server) | Stop the local server. | Stops its active agents and saves their partial history. |
| [`bbflow server restart`](#restart-the-server) | Replace the server with the invoked executable. | Stops active agents, finishes shutdown, then starts a new server and its macOS menu. |
| [`bbflow [--dir DIR] update [--yes]`](#update-bbflow) | Install the latest release and restart the server with it. | Asks first when a server runs. Replaces the invoked executable, then stops the server, which ends its sessions, and starts the new version. |
| [`bbflow query SQL`](#query-sqlite) | Read sessions, events, and run details with SQL. | Reads the archive. SQL selects the scope. Returns JSON. |
| [`bbflow storage [--redact]`](#storage-report) | See which projects, sessions, and event kinds use the most space. | Reads the archive. Prints a Markdown report. |
| [`bbflow tool list\|add\|remove`](#manage-tools) | Show, add, update, or remove tools from a script. | Changes saved settings. Starts no session. |
| [`bbflow settings get\|set`](#manage-settings) | Show or change appearance, session defaults, the update check, the server port, and remote access. | Changes saved settings. Starts no session. |
| [`bbflow title-tool list\|show\|set\|test`](#title-tool) | Show, select, or test the tool for automatic session titles. | `set` and `test` run the tool once with a sample message. `set` saves the tool only after the test passes. Starts no session. |
| [`bbflow skill`](#agent-guide) | Teach an agent how to read bbflow sessions and history. | Prints a Markdown guide. Does not contact a server. |

Each command accepts the global `--dir` option. See
[Instance directory](#instance-directory) and [Exit codes](#exit-codes).

Create, browse, reopen, and stop sessions in the web UI. The CLI has no session
operations or interactive terminal client. `query` handles custom history reads. `ui`
accepts no workspace or session arguments. `tool`, `settings`, and `title-tool` change
the same saved settings as the Settings page.

## Instance directory

Each instance has one directory. The directory holds the database, the log, and the
connection information of its server. A command selects the instance with `--dir`,
`BBFLOW_DIR`, or the default of the build.

### Default and selection

| Build | Default instance directory |
| --- | --- |
| Development binary | `~/.bbflow-dev` |
| Production binary | `~/.bbflow` |

The build sets this default. Moving the binary or changing the current working directory
does not change its default. All commands select one instance in this order:

1. Global `--dir DIR`, if supplied before the command.
2. `BBFLOW_DIR`, if set to a nonempty value.
3. The build's default directory.

Explicit overrides can point either build at any directory. Development and production
instances are separate by default. Previous locations are not searched or moved.

### Server port

Each server listens on a port at `127.0.0.1` and `::1`. To keep one address for
bookmarks, set `port` with [settings set](#manage-settings) or in Settings. The default,
`0`, selects the automatic port. The first server of a directory then gets a free port
from the operating system. The server saves the port that it uses in `history.sqlite`.

At each start, restart, and update, the server tries the port from Settings first. Then
it tries the saved port, so open browser tabs keep their address. When other programs
hold these ports, the server gets a free port, saves it, and writes a message to
`server.log`. Settings keeps its port, so the next start tries that port again.

Clients read the port from `server.json` in the selected directory. Before a command,
they verify the server's directory and instance ID on the same WebSocket connection.
There are no `--port` or `--data-dir` options.

### Running server

Query, UI, tool, and settings commands require a running server and do not start one
automatically. The web UI uses the same server at its printed HTTP URL. There is no
authentication token.

### Files

The instance directory contains:

| Path | Purpose |
| --- | --- |
| `history.sqlite` | All durable bbflow history. SQLite also manages `-wal` and `-shm` files. |
| `server.json` | Disposable connection information: port, instance ID, PID, directory, executable, protocol. |
| `server.log` | Diagnostic server output. |
| `server.lock`, `server-control.lock` | Process ownership and lifecycle coordination. |

The server replaces `server.json` atomically on startup and removes it on clean
shutdown. Lock files may remain after shutdown. Their presence does not mean a server is
active. Lifecycle commands create the instance directory and lock files as needed,
including when stopping an instance that is already stopped.

### Position of the options

Put global `--dir` before the command. Put command options after the subcommand and
before its positional arguments:

```sh
bbflow --dir ~/bbflow-experiment server start
bbflow --dir ~/bbflow-experiment ui
bbflow --dir ~/bbflow-experiment query "SELECT id,title FROM sessions"
```

`--dir` selects bbflow's instance directory. It does not change the agent's working
directory. Click ＋ beside a saved project in the UI to create a new draft. Relative
instance paths resolve from the client's current directory. Paths with symlinks resolve
to the same instance.

### Variables in a session

bbflow sets `BBFLOW_SESSION` and the canonical `BBFLOW_DIR` inside each wrapped agent.
Its bbflow commands automatically connect to the owning instance, even if the outer
shell had different settings. SQL does not use `BBFLOW_SESSION` automatically. To select
only the current session from its shell, include it explicitly:

```sh
bbflow query "SELECT seq,text FROM events WHERE session_id='$BBFLOW_SESSION' ORDER BY seq LIMIT 100"
```

## Help

```sh
bbflow --help
bbflow update --help
bbflow server --help
bbflow server start --help
bbflow server stop --help
bbflow server restart --help
bbflow ui --help
bbflow query --help
bbflow storage --help
bbflow tool --help
bbflow settings --help
bbflow title-tool --help
bbflow skill --help
```

Running `bbflow` without arguments, `bbflow help`, or `bbflow -h` also shows the
top-level help. Use the forms above for command-specific options.

**Impact:** the command prints help. It does not start an agent or open the history
database.

## Executable version

```sh
bbflow --version
```

The command prints `bbflow X.Y.Z` for a versioned release or `bbflow dev` for an
unversioned build. It takes no command or positional arguments. It reports the invoked
executable, not an already running server, and does not check GitHub for updates.

**Impact:** prints version information without contacting a server or opening an
instance directory. See the [installation guide](../README.md#install-on-macos) to
install or update bbflow.

## Start the server

```text
bbflow [--dir DIR] server start
```

```sh
bbflow server start
bbflow --dir ~/bbflow-experiment server start
```

The command starts a detached background process from the bbflow executable that
received it. It waits up to two minutes for the server to accept requests, including
automatic database upgrades. Then it prints the web UI URL, process ID (PID), history
directory, and log path. Closing the launching terminal leaves the server running.

A repeated start reports the existing matching server and its URL without replacing it.
Open that URL in a browser to use the web UI. The command does not launch a browser. See
the [web client specification](SPEC.md#web-client) for the UI controls.

**Impact:** creates or opens the selected history archive and appends server output to
`server.log`. It creates private data and lock files as needed, saves the built-in
General project, and creates its `<instance>/workspaces/general` folder. Before serving
requests, it upgrades supported older database formats using SQL embedded in the binary.
All pending migrations commit together. A failure rolls them back and stops startup.

The command starts no shell or agent. Create sessions in the UI. The server uses the
port from Settings or the saved port of the directory when it is free. Otherwise, it
uses a free port from the operating system. See
[Instance directory](#instance-directory). A second server cannot own the same
directory. If startup fails, inspect the printed log path.

### macOS menu

- On macOS, a new server also launches a menu bar companion from this same executable.
- **Open UI** opens the verified server's home page.
- **Quit bbflow** stops that server and its active sessions, then closes the menu. Its
  label includes the running version.
- For an instance directory that is not the default of the build, the label shows a
  short instance tag in place of the version, such as **Quit bbflow (demo-1a2b3)**.
- Quit retains and verifies the original server connection, so missing or replaced
  `server.json` files do not prevent it.
- The menu has no separate Stop, Settings, or Logs action. There is no persistent
  Running label.

Each server start on macOS launches the menu. There is no option to turn it off. Linux
never launches the menu. A repeated start leaves the existing server and its menu
unchanged and does not create another icon.

If the menu fails, the server continues and writes details to `server.log`. To restore
the menu, restart the server. This stops active sessions. The menu needs no `.app`
bundle or extra executable.

## Open the web UI

```text
bbflow [--dir DIR] ui
```

```sh
bbflow server start
bbflow ui
bbflow --dir ~/bbflow-experiment ui
```

The command reads the selected instance's connection information and verifies the server
through the shared WebSocket greeting. It opens `http://localhost:PORT/` in the default
browser, with no session selected. It accepts no positional arguments. It uses `open` on
macOS and `xdg-open` on Linux. A graphical browser launcher must be available. Launcher
failures report an error and include the URL for manual opening.

**Impact:** launches the browser. It does not start or restart a server, attach to a
session, launch an agent, or change history. A missing or unverified server causes an
error before the browser opens. Run `server start` first if the server is stopped.

## Stop the server

```text
bbflow [--dir DIR] server stop
```

```sh
bbflow server stop
bbflow --dir ~/bbflow-experiment server stop
```

The command stops the server selected by its instance directory. The command contacts
the server and waits for it to release its archive. If the server is already stopped,
the command clears any stale connection file and succeeds. If a process still owns the
directory but its connection file is missing, invalid, or points elsewhere, the command
fails without stopping another server.

Shutdown uses the version advertised by the verified server, so a session protocol
change does not prevent stopping it. The server must support the same greeting and
shutdown request. Other commands still require the current protocol.

**Impact:** stops all agents owned by that server, records their final output and
status, and closes the archive. Connected browser views show completion. After the
shutdown grace period, the server forcibly stops agents that have not exited. Saved
history and log files remain. The command never kills a process based only on a stored
PID. If shutdown cannot be confirmed, it returns an error.

On macOS, the server also closes its menu companion before completing shutdown.

## Restart the server

```text
bbflow [--dir DIR] server restart
```

```sh
bbflow server restart
bbflow --dir ~/bbflow-experiment server restart
```

The command completes a stop. Then it starts a server from the executable that received
the command. Use this after replacing your bbflow executable. If no server is running,
it starts one. It can replace a server with a different session protocol using the
verified shutdown request described above. If stopping fails, it does not launch a
replacement.

**Impact:** the command ends all active agent runs and preserves their history. It opens
the same archive in a new server process. The new server has a new instance ID. It uses
the same port when that port is free. When Settings names another port, the new server
tries that port first.

The new server applies pending database migrations before accepting requests. Clients
discover the new endpoint on their next command. It does not resume agents or replay
input. Restart can fail to start the new process after the previous server stops. Check
the reported error and log path.

Restart closes the previous menu companion and launches a new one on macOS.

## Update bbflow

```text
bbflow [--dir DIR] update [--yes]
```

The command reads the latest macOS release. If the executable that received the
command is already current or newer, it downloads no binaries and changes nothing.
Development builds cannot update.

### Confirmation

When a server runs in the selected instance directory, the command shows the two
versions. It also tells you that the server stops and its running sessions end. Then it
asks `Continue? [y/N]`. Any answer other than `y` or `yes` changes nothing. Without a
terminal on standard input, the command refuses unless you give `--yes`.

### Steps

After confirmation, the command does these steps in order:

1. Download the release while the current server continues.
2. Verify its checksum and its executable version.
3. Replace the executable through an atomic rename.
4. Start the new executable as an updater in its own session. The updater does not
   depend on the terminal, so it continues when the server stop closes that terminal.
5. Stop the confirmed server and wait until it releases its archive.
6. Start the new version in the same instance directory, with the macOS menu.

The update does not open the UI. The new server uses the same port, so open browser
tabs reconnect and reload. If the port changed, reopen the UI with `bbflow ui` or the
**Open UI** menu item.

### Output

- The command shows the updater output until the updater ends. Then it confirms that a
  new server answers.
- Then it prints a line that names both versions, for example
  `Updated bbflow 0.0.12 to 0.0.13. The server in ~/.bbflow runs the new version.` The
  last line gives the `bbflow ui` command for the instance.
- When no server runs, the command prints `Updated bbflow 0.0.12 to 0.0.13.`, then the
  hint to start the server.
- The updater also appends its output to `update.log` in the instance directory.
- Ctrl+C stops only that display. The update continues.

### Rules

- When no server runs, the command only replaces the executable. It does not create the
  instance directory.
- Hints and recovery commands name the selected instance with `--dir`, for example
  `bbflow --dir '/Users/you/my instance' server start`.
- Updates that share an executable run one at a time. A second update waits for the
  first and says so.
- If another command changed the executable while the question waited, the update stops
  and changes nothing.
- The new server and its sessions do not receive `GITHUB_TOKEN` from the update
  command. They receive all other variables of its environment.
- `--yes` continues without the confirmation prompt.
- The executable must have the name `bbflow`. The command supports a symlink to it. You
  need write access to its installation directory.
- `--dir` and `BBFLOW_DIR` select the instance to restart. They do not select the
  executable to update. `BBFLOW_INSTALL_DIR` also does not redirect an update.
- Do not run the command inside a bbflow session if you want to see its result there.
  The server stop ends that terminal. The update continues, and `update.log` has its
  output.

**Impact:** contacts GitHub and replaces the executable through an atomic rename. When
a server runs, it stops that server after confirmation, which ends its sessions and
saves their partial history. The new server applies pending embedded database
migrations at startup, before accepting requests. A failure before the rename leaves the
executable and the server unchanged. A failure after the rename leaves the new
executable in place. Then run `bbflow --dir DIR server start`. Other instances that use
the same executable continue on the previous version until you restart them.

### Update from the web UI

The web UI can start the same update without this command. When the server finds a
newer release, the sidebar shows it above **Settings**. The update starts only after
you confirm in its dialog. See [update from the web UI](SPEC.md#update-from-the-web-ui).

## Query SQLite

```text
bbflow [--dir DIR] query SQL
```

Pass one quoted SQL query. SQL chooses which sessions and records to read. There is no
implicit session filter, even inside a wrapped agent. Queries go through the server to
the selected archive. Queries need no direct database access or SQLite CLI installation.

### Examples

```sh
# Saved projects.
bbflow query "SELECT id,name,workspace FROM projects ORDER BY name"

# Recent sessions and their workspace paths.
bbflow query "SELECT id,title,workspace FROM sessions ORDER BY created DESC LIMIT 10"

# One page of derived output from a session.
bbflow query "SELECT seq,kind,text FROM events WHERE session_id='SESSION_ID' AND seq>0 ORDER BY seq LIMIT 100"

# Find text across sessions.
bbflow query "SELECT session_id,seq,text FROM events WHERE text LIKE '%earlier decision%' ORDER BY seq LIMIT 20"

# Inspect original evidence for one event. BLOBs are base64 in JSON.
bbflow query "SELECT * FROM events WHERE seq=42"

# Inspect table definitions.
bbflow query "SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name"
```

### Tables

The tables are:

| Table | Columns |
| --- | --- |
| `projects` | `id`, `name`, `workspace`, `created` |
| `sessions` | `id`, `title` (user title, or empty), `auto_title` (derived title), `workspace`, `created`, `project_id` (NULL for standalone), `archived` (0 or 1) |
| `runs` | `id`, `session_id`, `status`, `started`, `ended`, `pid`, `detail` |
| `settings` | `id`, `revision`, `data` (JSON appearance, defaults, tool presets, port, and remote access) |
| `preparations` | `session_id`, `revision`, `state`, `data` (JSON launch choices) |
| `worktrees` | `session_id`, `path`, `repository`, `base`, `commit_id`, `branch`, `state` |
| `events` | `seq`, `session_id`, `run_id`, `kind`, `data`, `text`, `created` |

### Data rules

Server startup upgrades supported older database formats automatically. It rejects
unsupported formats without changing their contents. Downgrades are not supported. See
[database upgrades](SPEC.md#database-upgrades) for the format numbers.

No separate migration command or SQLite CLI is needed. Manage projects in the UI. There
are no project CLI commands. Removing a custom project clears session membership but
preserves its recorded workspace and history.

Archiving hides a draft or finished session in the UI. SQL still includes it unless you
filter `sessions.archived`. Restoration never starts a process.

IDs are text. Timestamps are UTC text. Event sequence numbers are integers shared across
the archive. `data` holds original bytes. `text` holds derived output. Events are
terminal chunks or lifecycle records, not complete messages.

A `LIKE` predicate checks each chunk separately, so a phrase split across chunks can be
missed. Normal SQLite matching rules apply. Reads do not imply that an agent has seen
the records.

### Result format

Results use column names and row arrays, so duplicate column names do not discard data:

```json
{"columns":["seq","text"],"rows":[[42,"example output"]],"truncated":false}
```

SQLite NULL becomes JSON `null`, BLOBs become base64 strings, and integers, real
numbers, and text retain their JSON types. Use column aliases to make joins easier to
read.

### Accepted SQL

The server accepts only read queries: `SELECT`, `WITH ... SELECT`, and `VALUES`. It
accepts an optional final semicolon and SQL comments. It rejects writes, schema changes,
PRAGMAs, transactions, external database attachment, and multiple statements. Use
`sqlite_schema` to inspect the schema.

### Limits

| Item | Limit | Above the limit |
| --- | --- | --- |
| Time of one query | 5 seconds | The query returns an error. |
| Rows in a result | 1,000 | The result has `truncated: true`. |
| JSON size of a result | 8 MiB | The result has `truncated: true`. |
| SQL text | 64 KiB | The query returns an error. |
| Columns in a result | 128 | The query returns an error. |
| One SQLite value or row | 1 MiB | The query returns an error. |
| SQLite query heap | 64 MiB | The query returns an error. |

`truncated: true` means the result reached a limit. This is not an SQL error. For later
event pages, use the last returned `seq` in `WHERE seq>LAST_SEQ ORDER BY seq`. Use an
explicit order and limit for repeatable pages.

**Impact:** opens a separate read-only connection. It does not change history, replay
input, start or stop agents, or block capture by sharing its write connection. A missing
server is an error.

## Storage report

```text
bbflow [--dir DIR] storage [--redact]
```

Print a Markdown report about the storage use of the archive. Use it to find the
projects, sessions, and event kinds that use the most space.

```sh
bbflow storage > storage-report.md
bbflow storage --redact > storage-report.md
```

### Report sections

The report has these sections:

- **Totals:** the database, used, free, and write-ahead log (WAL) sizes, the event
  count, and the average bytes and overhead for each event.
- **Used space by events column:** the exact bytes of each events column, and the
  overhead that remains.
- **Event kinds**, **Projects**, and **Top 10 sessions**, largest first.
- **Top 5 sessions in each of the top 3 projects.**
- **Event kinds in the top 5 sessions.**
- **Growth by day (UTC).**
- **Method:** how the report makes its estimates.

Event counts and column bytes are exact. Sizes for each event kind, project, session,
and day are estimates. See [storage report](SPEC.md#storage-report) for the method.

### Names in the report

The report shows project names, session titles, tool names, and the first 8 characters
of session IDs. It never shows terminal content or workspace paths. Use `--redact` to
replace project names and session titles with short IDs. General and standalone
sessions keep their labels. The report escapes Markdown characters in names, so each
name shows as saved.

### Read time and limits

The server reads every event once. A large archive can take some seconds. The command
prints a progress note to standard error and the report to standard output. The read
stops after 10 minutes. With tens of thousands of projects that have sessions, the
reply can exceed the 16 MiB protocol limit. The command then prints `the result exceeds
16 MiB` and no report. See [storage report](SPEC.md#storage-report).

**Impact:** opens a separate read-only connection. It does not change history or block
capture. A missing server is an error.

## Manage tools

```text
bbflow [--dir DIR] tool list
bbflow [--dir DIR] tool add [--default] NAME COMMAND
bbflow [--dir DIR] tool remove NAME
```

Use these commands to prepare tools from a setup script, for example to share a tool set
with a team. The script must start the server first:

```sh
bbflow server start
bbflow tool add --default Codex 'codex --no-alt-screen'
bbflow tool add Claude claude
```

`tool list` prints one saved tool on each line, in the saved order: the name, a tab, and
the startup command. A name and a command contain no tab, so a script can divide each
line at the tab. The list does not align the commands in one column. Without a tool, it
prints `No tools are saved.` For the tool IDs, use `settings get`, which prints JSON.

`tool add` creates a tool at the end of the list. If a tool has the same name, the
command replaces its startup command and keeps its position and ID. `--default` makes
the tool the default for new drafts.

`tool remove` removes the tool with this name. If it was the default tool, Shell becomes
the default tool. Drafts and sessions keep their own copy of the command.

Names match exactly after bbflow removes leading and trailing spaces. If two tools have
the same name, `add` and `remove` fail. Rename one of them in Settings. Put `--default`
before `NAME`. After `NAME`, it is an error. For a name that starts with `-`, put `--`
before it, for example `bbflow tool add -- --default true`. Quote a command that
contains spaces. The
[Settings rules](SPEC.md#session-preparation-settings-and-worktrees) for names and
commands apply.

**Impact:** saves the change in SQLite with a new settings revision. Open Settings pages
show the change when they open again. The command starts no session and does not change
drafts or sessions. If another client saves settings at the same time, the command
applies its change again to the latest settings. Do not put secrets in a shared script.

## Manage settings

```text
bbflow [--dir DIR] settings get [KEY]
bbflow [--dir DIR] settings set KEY VALUE
```

```sh
bbflow settings get
bbflow settings get default-tool
bbflow settings set appearance dark
bbflow settings set default-tool Codex
bbflow settings set worktree true
bbflow settings set base main
bbflow settings set update-check false
bbflow settings set port 50000
bbflow settings set remote-host my-mac.example.ts.net
bbflow settings set remote-login user@example.com
```

`settings get` prints the saved settings as JSON, including the revision and the tools.
The JSON uses the field names of the protocol. Thus `default-tool` is `defaultTool`,
`update-check` is `updateCheck`, `remote-host` is `remoteHost`, and `remote-login` is
`remoteLogin`.

`settings get KEY` prints one value as text, in the form that `settings set` accepts.
For `default-tool`, it prints the tool name, or an empty line for the built-in Shell.
If another tool has the name of the default tool, `set` cannot select it by that name.
`settings get default-tool` then fails and tells you to rename one tool in Settings.

`settings set` changes one value. It then prints the saved value, for example
`Saved appearance: dark.` The server can replace a value, such as an empty `base`, and
the command prints the result.

| Key | Value |
| --- | --- |
| `appearance` | `system`, `light`, or `dark` |
| `default-tool` | The name of a tool. An empty value, `""`, selects the built-in Shell. |
| `worktree` | `true` or `false`. No other spelling is a value. `true` selects **Use worktree** for new drafts in Git folders. A new installation starts with `true`. An upgrade keeps the saved value. |
| `base` | The default starting branch or commit. An empty value selects `HEAD`. |
| `update-check` | `true` or `false`. `true` lets the server read the latest release from GitHub when it starts and then once a day. A newer release then shows in the web UI. A new installation and an upgrade start with `true`. See [release check](SPEC.md#release-check). |
| `port` | A port from 1024 to 65535, or `0` for the automatic port. The server uses it from the next start. A new installation and an upgrade start with `0`. The save fails when another program holds a new port, or when browsers refuse the port, such as 6000 and 10080. See [Instance directory](#instance-directory). |
| `remote-host` | The host name of this computer in Tailscale Serve, such as `my-mac.example.ts.net`, with an optional port. An empty value, `""`, removes it. The server saves the name in lower case. See [remote access](SPEC.md#remote-access). |
| `remote-login` | The Tailscale login that can use remote access, such as `user@example.com`. An empty value, `""`, removes it. |

**Impact:** the same as `tool add`. A rejected value changes nothing. A `port` change
does not move the running server. After a changed port, the command tells you that the
port applies at the next server start. A restart stops all sessions.

Remote access is on only while `remote-host` and `remote-login` are both set. A new
installation and an upgrade start with neither. After a save of one of these keys, the
command prints `Remote access is on.` or tells that remote access needs both keys. An
empty saved value prints as `none`. A change applies at once and closes the open remote
connections. While remote access is on, each device where that Tailscale user is signed
in can run commands on this computer as you.

Use [`title-tool`](#title-tool) to select the title tool. `title-tool` is not a settings
key. `settings get title-tool` and `settings set title-tool` fail and name that command.

## Title tool

```text
bbflow [--dir DIR] title-tool list
bbflow [--dir DIR] title-tool show
bbflow [--dir DIR] title-tool set TOOL
bbflow [--dir DIR] title-tool set custom [COMMAND]
bbflow [--dir DIR] title-tool test
```

```sh
bbflow title-tool set apple
bbflow title-tool set custom 'my-llm --fast'
bbflow title-tool test
bbflow title-tool set none
```

The title tool makes automatic session titles. `TOOL` is `none`, `claude`, `codex`,
`code-puppy`, `apple`, or `custom`. `apple` uses the on-device model of macOS 27. `none`
turns automatic titles off. A new installation starts with `none`. The upgrade to SQLite
format 10, which added automatic titles, also set `none`. Later upgrades keep the saved
value.

### Subcommands

- `list` prints the ID and the exact command of each built-in tool, one tool on each
  line. The commands come from the running server. A later release can change them.
- `show` prints the saved tool and the command that the server runs for it. It also
  prints a saved custom command when another tool is selected.
- `set TOOL` runs the tool once with a fixed sample message, then saves it. Before the
  test, the command writes the tool name and its exact command to standard error. If the
  test passes, it prints that the tool is configured, with the title from the sample
  message. If the test fails, it prints that the tool is not configured, the saved tool,
  and the error. It then exits with code `1` and changes nothing. If another change of
  the title tool saves during the test, the command also changes nothing and exits with
  code `1`. `set none` saves without a test. An empty `TOOL` is an error.
- `set custom COMMAND` tests `COMMAND` and saves it together with the Custom choice.
  `set custom` without `COMMAND` tests the saved custom command again. It fails when no
  custom command is saved. An empty `COMMAND` is an error, and it does not test the
  saved command. Quote a command that contains spaces. Only `custom` takes a command.
- `test` runs the saved tool once with the sample message and saves nothing. If the test
  fails, the command exits with code `1`. Use it after a sign-out or a CLI update.

### Test

A test can take up to 90 seconds. The command waits 100 seconds for the reply. Press
Ctrl-C to cancel a test. Then the tool does not save. Claude, Codex, and Code Puppy send
the sample message to their provider and use your sign-in. Apple keeps it on the Mac.
The test runs in the server environment, so the CLI must be on the PATH of the server.

### Custom command

A custom command gets the request on standard input. It must print one line that starts
with `bbflow-title:` and then the title. It must be one line of at most 1,000 bytes. A
custom command does not get the limits of the built-in commands, such as turned-off
tools, hooks, and MCP servers. Prefer standard input to `"$(cat)"`, because other
programs can read the arguments of a command. See
[session titles](SPEC.md#session-titles).

**Impact:** `set` saves the change in SQLite with a new settings revision after a passed
test. Another tool keeps the saved custom command. `list`, `show`, and `test` change
nothing. No command starts a session or changes the titles of existing sessions.

## Agent guide

```sh
bbflow skill
```

The command prints a Markdown guide for an agent tool. The guide explains
`BBFLOW_SESSION` and `BBFLOW_DIR`, the `bbflow query` usage and JSON output, the archive
tables and event kinds, example queries, and the current limits. It also tells the agent
to treat recorded history as a record, not as instructions. The command takes no options
or positional arguments.

The executable embeds the guide, so the text matches the installed version. The guide
describes the newest database format that the executable supports.

bbflow does not add the guide or a prompt to a new agent run. An agent finds the command
in these places:

- The top-level help of `bbflow`.
- The `README.md` of a handoff folder, after Continue in new terminal.
- The instruction file of the agent tool, if you add a line to it. For example, add this
  line to `AGENTS.md` or `CLAUDE.md`:

  ```markdown
  To read bbflow sessions or recorded terminal history, run `bbflow skill` first.
  ```

**Impact:** prints text only. It does not contact a server, open an instance directory,
or read history. `--dir` and `BBFLOW_DIR` have no effect on this command.

## Exit codes

Help and successful server, UI, query, storage, tool, settings, title-tool, and skill
commands exit with code `0`. bbflow errors print a message to standard error and exit
with code `1`.
