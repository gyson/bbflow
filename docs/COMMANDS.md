# bbflow command reference

This guide covers bbflow CLI commands, when to use them, and what they change. The CLI
connects to a separate local server. Commands may change during early development.
Supported database formats upgrade automatically while preserving stored data.

The CLI command and executable use the name `bbflow`. From a local checkout, use the
path to your executable, such as `./bin/bbflow` or `./bin/release/bbflow`. Replace
uppercase placeholders such as `SESSION_ID` with your own values. Brackets in usage
lines identify an optional argument. Do not type the brackets.

## Command summary

| Command | Use it to | Impact |
| --- | --- | --- |
| `bbflow`, `bbflow help`, `bbflow --help`, `bbflow -h` | Show available commands. | Displays help only. |
| `bbflow --version` | Show the executable version. | Prints a release version or `dev`. Does not contact a server. |
| `bbflow update` | Install the latest release. | Replaces the invoked executable. Active sessions continue. |
| `bbflow server start [--no-menubar]` | Start the local server in the background. | Creates the data directory and log. Adds the macOS menu unless disabled. The server continues after the terminal closes. |
| `bbflow server stop` | Stop the local server. | Stops its active agents and saves their partial history. |
| `bbflow server restart [--no-menubar]` | Replace the server with the invoked executable. | Stops active agents, finishes shutdown, then starts a new server and its optional macOS menu. |
| `bbflow ui` | Open the web UI home page in the default browser. | Verifies the selected running server, then launches its home URL. Starts no server or agent. |
| `bbflow query SQL` | Read sessions, events, and run details with SQL. | Reads the archive. SQL selects the scope. Returns JSON. |
| `bbflow tool list\|add\|remove` | Show, add, update, or remove tools from a script. | Changes saved settings. Starts no session. |
| `bbflow settings get\|set` | Show or change appearance and session defaults. | Changes saved settings. Starts no session. |
| `bbflow skill` | Teach an agent how to read bbflow sessions and history. | Prints a Markdown guide. Does not contact a server. |

Create, browse, reopen, and stop sessions in the web UI. The CLI has no session
operations or interactive terminal client. `query` handles custom history reads. `ui`
accepts no workspace or session arguments. `tool` and `settings` change the same saved
settings as the Settings page.

## Instance directory

| Build | Default instance directory |
| --- | --- |
| Development binary | `~/.bbflow-dev` |
| Production binary | `~/.bbflow` |

The build sets this default. Moving the binary or changing the current working directory
does not change its default. All commands select one instance in this order:

1. Global `--dir DIR`, if supplied before the command.
2. `BBFLOW_DIR`, if set to a nonempty value.
3. The build's default directory.

Each server chooses an available port on `127.0.0.1`. Clients read the port from
`server.json` in the selected directory. Before a command, they verify the server's
directory and instance ID on the same WebSocket connection. You do not configure a port.
There are no `--port` or `--data-dir` options.

Query, UI, tool, and settings commands require a running server and do not start one
automatically. The web UI uses the same server at its printed HTTP URL. There is no
authentication token.

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

Explicit overrides can point either build at any directory. Development and production
instances are separate by default. Previous locations are not searched or moved.

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
bbflow tool --help
bbflow settings --help
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

## Update bbflow

```sh
bbflow update
```

The command verifies the checksum and version of the latest macOS release. Then it
replaces the executable that received the command. It takes no options or positional
arguments. If that executable is already current or newer, it downloads no binaries and
changes nothing. Development builds cannot update.

The executable must have the name `bbflow`. The command supports a symlink to it. You
need write access to its installation directory.

`--dir` and `BBFLOW_DIR` select instance data, not the executable to update, and have no
effect on this command. `BBFLOW_INSTALL_DIR` also does not redirect an update.

**Impact:** contacts GitHub and replaces the executable through an atomic rename. It
does not open an instance, change history, or restart a server. Existing sessions
continue on the running version. When ready to use the new version, run
`bbflow server restart`. Restart ends active sessions. The new server applies pending
embedded database migrations at startup, before accepting requests.

## Start the server

```text
bbflow [--dir DIR] server start [--no-menubar]
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

The command starts no shell or agent. Create sessions in the UI. The operating system
allocates a free port. A second server cannot own the same directory. If startup fails,
inspect the printed log path.

On macOS, a new server also launches a menu bar companion from this same executable.
**Open UI** opens the verified server's home page. **Quit bbflow** stops that server and
its active sessions, then closes the menu. Its label includes the running version.
For an instance directory that is not the default of the build, the label shows a short
instance tag in place of the version, such as **Quit bbflow (demo-1a2b3)**.
Quit retains and verifies the original server connection, so missing or replaced
`server.json` files do not prevent it. The menu has no separate Stop, Settings, or Logs
action. There is no persistent Running label.

Pass `--no-menubar` to start without the menu, for example on a headless Mac or in
automated checks. The flag also applies to restart. Linux never launches the menu. A
repeated start leaves the existing server's menu choice unchanged and does not create
another icon.

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
through the shared WebSocket greeting. It opens `http://127.0.0.1:PORT/` in the default
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
bbflow [--dir DIR] server restart [--no-menubar]
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
the same archive in a new server process. The new server has a new instance ID and an
automatically selected port.

The new server applies pending database migrations before accepting requests. Clients
discover the new endpoint on their next command. It does not resume agents or replay
input. Restart can fail to start the new process after the previous server stops. Check
the reported error and log path.

Restart closes the previous menu companion and launches a new one on macOS unless
`--no-menubar` is supplied. The flag applies to this start. bbflow does not save it as a
setting.

## Query SQLite

```text
bbflow [--dir DIR] query SQL
```

Pass one quoted SQL query. SQL chooses which sessions and records to read. There is no
implicit session filter, even inside a wrapped agent. Queries go through the server to
the selected archive. Queries need no direct database access or SQLite CLI installation.

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

The tables are:

| Table | Columns |
| --- | --- |
| `projects` | `id`, `name`, `workspace`, `created` |
| `sessions` | `id`, `title`, `workspace`, `created`, `project_id` (NULL for standalone), `archived` (0 or 1) |
| `runs` | `id`, `session_id`, `status`, `started`, `ended`, `pid`, `detail` |
| `settings` | `id`, `revision`, `data` (JSON appearance, defaults, and tool presets) |
| `preparations` | `session_id`, `revision`, `state`, `data` (JSON launch choices) |
| `worktrees` | `session_id`, `path`, `repository`, `base`, `commit_id`, `branch`, `state` |
| `events` | `seq`, `session_id`, `run_id`, `kind`, `data`, `text`, `created` |

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

Results use column names and row arrays, so duplicate column names do not discard data:

```json
{"columns":["seq","text"],"rows":[[42,"example output"]],"truncated":false}
```

SQLite NULL becomes JSON `null`, BLOBs become base64 strings, and integers, real
numbers, and text retain their JSON types. Use column aliases to make joins easier to
read.

The server accepts only read queries: `SELECT`, `WITH ... SELECT`, and `VALUES`. It
accepts an optional final semicolon and SQL comments. It rejects writes, schema changes,
PRAGMAs, transactions, external database attachment, and multiple statements. Use
`sqlite_schema` to inspect the schema.

Each query has a five-second timeout. Results are limited to 1,000 rows and 8 MiB of
JSON. `truncated: true` means the result reached a limit. This is not an SQL error. For
later event pages, use the last returned `seq` in `WHERE seq>LAST_SEQ ORDER BY seq`.

Use an explicit order and limit for repeatable pages. A query may contain up to 64 KiB
of SQL and return at most 128 columns. SQLite values/rows are limited to 1 MiB and its
query heap to 64 MiB. Queries that exceed these limits or the timeout return an error.

**Impact:** opens a separate read-only connection. It does not change history, replay
input, start or stop agents, or block capture by sharing its write connection. A missing
server is an error.

## Manage tools

```text
bbflow [--dir DIR] tool list
bbflow [--dir DIR] tool add [--continue COMMAND] [--default] NAME COMMAND
bbflow [--dir DIR] tool remove NAME
```

Use these commands to prepare tools from a setup script, for example to share a tool set
with a team. The script must start the server first:

```sh
bbflow server start
bbflow tool add --default Codex 'codex --no-alt-screen'
bbflow tool add --continue 'claude {prompt}' Claude 'claude'
```

`tool list` prints the saved tools as a JSON array with `id`, `name`, `command`, and an
optional `continueCommand`.

`tool add` creates a tool at the end of the list. If a tool has the same name, the
command updates that tool and keeps its position and ID. It replaces the startup command
and the continue command. Without `--continue`, the tool has no continue command. Thus a
script gives the same result each time it runs. `--default` makes the tool the default
tool for new drafts.

`tool remove` removes the tool with this name. If it was the default tool, Shell becomes
the default tool. Drafts and sessions keep their own copy of the command.

Names match exactly after bbflow removes leading and trailing spaces. If two tools have
the same name, `add` and `remove` fail. Rename one of them in Settings. Put options
before `NAME`. Quote a command that contains spaces. The
[Settings rules](SPEC.md#session-preparation-settings-and-worktrees) for names and
commands apply.

**Impact:** saves the change in SQLite with a new settings revision. Open Settings pages
show the change when they open again. The command starts no session and does not change
drafts or sessions. If another client saves settings at the same time, the command
applies its change again to the latest settings. Do not put secrets in a shared script.

## Manage settings

```text
bbflow [--dir DIR] settings get
bbflow [--dir DIR] settings set KEY VALUE
```

```sh
bbflow settings set appearance dark
bbflow settings set default-tool Codex
bbflow settings set worktree true
bbflow settings set base main
```

`settings get` prints the saved settings as JSON, including the revision and the tools.

`settings set` changes one value:

| Key | Value |
| --- | --- |
| `appearance` | `system`, `light`, or `dark` |
| `default-tool` | The name of a tool. An empty value, `""`, selects the built-in Shell. |
| `worktree` | `true` or `false`. `true` selects **Use worktree** for new drafts in Git folders. A new installation starts with `true`. An upgrade keeps the saved value. |
| `base` | The default starting branch or commit. An empty value selects `HEAD`. |

**Impact:** the same as `tool add`. A rejected value changes nothing.

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

Help and successful server, UI, query, tool, settings, and skill commands exit with
code `0`. bbflow errors print a message to standard error and exit with code `1`.

See [README.md](../README.md) for installation, [DEVELOPMENT.md](DEVELOPMENT.md) for
local builds, and [SPEC.md](SPEC.md) for implementation details and current limitations.
