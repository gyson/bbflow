# Client/server protocol

The CLI selects an instance directory with global `--dir`, `BBFLOW_DIR`, or its build
default. It reads the assigned port from `<instance>/server.json` and connects to
`ws://127.0.0.1:PORT/ws`. The operating system assigns an IPv4 loopback port to the
server. HTTP also serves the embedded web UI and its connection information.

The transport uses [Gorilla WebSocket](https://github.com/gorilla/websocket). Each
WebSocket text message contains one JSON object. There is no bbflow length prefix or
binary envelope. The limit is 16 MiB per message, including all fragments.

The server rejects binary messages, malformed JSON, and multiple JSON values in one
message. Terminal bytes use base64 in `data`. This preserves arbitrary bytes and control
codes.

This is an early development protocol. The server greeting and first request verify
version `bbflow/27`. The protocol needs no WebSocket subprotocol header. Session
operations and health checks reject unsupported versions. Shutdown uses the verified
server's advertised version, so `server restart` can replace a server after a session
protocol change. This requires the same greeting and shutdown envelope.

There is no fallback for previous transports. The server upgrades supported older
database formats before it accepts requests. These formats do not imply support for
their previous WebSocket protocols. See [database upgrades](SPEC.md#database-upgrades).

## Connections and requests

Open one connection per operation. The server immediately sends a greeting:

```json
{
  "type": "server",
  "server": {
    "protocol": "bbflow/27",
    "instance": "random-instance-id",
    "pid": 12345,
    "dataDir": "/Users/example/.bbflow",
    "port": 49152,
    "executable": "/usr/local/bin/bbflow"
  }
}
```

CLI clients verify the greeting before each operation. Its directory must equal the
canonical selected directory. Its protocol, instance ID, PID, and port must match
`server.json`. Queries and health checks also require the client's current protocol
version. Verify the greeting on the connection that will carry the command.

A separate health check cannot prevent a race with server replacement. An invalid or
stale descriptor must never direct a command to a different server. To check health,
read and verify the greeting. Then close the connection.

The menu companion retains its parent's verified connection information at startup. Quit
reconnects to that endpoint and checks the greeting against the retained identity. It
does not depend on a later copy of `server.json`. It cannot stop a replacement instance.

For shutdown, send `stop` with the protocol and instance ID from that verified greeting.
Require a `result` with `{"stopping":true}`. Wait for release of the archive lock before
you start a replacement. Do not retry with another protocol or kill a stored PID.

HTTP headers and the WebSocket upgrade have five-second timeouts. Server writes time
out after five seconds. After the greeting, send a `request` message within five
seconds:

```json
{
  "type": "request",
  "request": {
    "protocol": "bbflow/27",
    "operation": "session-list",
    "groups": [""],
    "limit": 10
  }
}
```

Requests contain no archive path. The connection reaches one server and its archive. The
browser is the session client. The management CLI uses health, shutdown, and query
operations.

| Operation | Additional request fields | Reply |
| --- | --- | --- |
| `project-list` | None | `result`, containing projects with `id`, `name`, `workspace`, and `created` |
| `project-add` | `workspace`, optional `name` | `result`, containing the new project |
| `project-rename` | `project` ID, `name` | `result`, containing `renamed` |
| `project-remove` | `project` ID | `result`, containing `removed`. Sessions become standalone. |
| `session-rename` | `session` ID, `name` | `result`, containing `renamed`. An empty `name` removes the user title. |
| `session-list` | `groups` (group keys, required), `limit` for each group (default 10; `limit` times the number of groups is at most 100), optional `offset` (default 0, needs exactly one group), optional `session` ID to include (not with `offset`), `archived` (default false), `query` (optional, at most 800 bytes) | `result`, containing `sessions` (session summaries) and `more` (group keys). Each summary has a derived [`status`](#session-status). |
| `query` | `sql` | `result`, containing `columns`, `rows`, and `truncated` |
| `history-search` | `search` object, described below | `result`, containing `matches`, `more`, `incomplete`, `through`, and an optional `cursor` |
| `history-context` | `context` object, described below | `result`, containing `before`, `match`, `after`, continuation flags, and `lastSeq` |
| `workspace-changes` | `session` ID, `diff` object with optional `baseline` | `result`, containing `repository`, `base`, `baseline`, `files`, and `truncated` |
| `workspace-files` | `session` ID | `result`, containing `repository`, `paths`, and `truncated` |
| `workspace-folders` | `session` ID, `diff` object with `folders` | `result`, containing `folders` and an optional `ignoreError` |
| `workspace-file` | `session` ID, `diff` object with `path`, optional `oldPath` and `baseline` | `result`, containing `path`, `baseline`, and the `old` and `new` sides |
| `session-archive` | `session` ID, `archived` boolean (true to archive, false to restore) | `result`, containing `archived`. Rejects active runs and unfinished launch claims. |
| `session-stop` | `session` ID | `result`, containing `stopped`. `stopped` is false when the session has no live terminal, for example during worktree creation. |
| `status-watch` | None | A stream of `statuses` messages: the [status](#session-status) of each live terminal first, then all of them again after each change |
| `composer-draft` | `session` ID, optional `draft` | `result`, containing the saved `draft` and attachment metadata. Omit `draft` to read. A rejected save returns the latest draft with `rejected: true`. |
| `composer-watch` | `session` ID | A stream of `draft` messages: the latest draft first, then each newer saved draft |
| `composer-sent` | `session` ID, optional `revision` (list sends older than this revision) | `result`, containing `messages` (at most 20, newest first) and `more` |
| `composer-attach` | `session` ID, `upload` with `name`, `mediaType`, base64 `data` | `result`, containing attachment metadata and its local file path |
| `stop` | `instance`, from the verified greeting | `result`, containing `stopping`. The server then shuts down. |
| `settings-get` | none | `result`, saved settings and revision |
| `settings-save` | `settings`, including current revision | `result`, updated settings and revision |
| `title-tools` | None | `result`, containing the title tools with `id`, `name`, and `command` |
| `title-test` | `settings` with `titleTool`, and `text` | `result`, containing `title`. It runs the title tool once with `text` and saves nothing. |
| `workspace-inspect` | `workspace` | `result`, Git availability, root, HEAD, branch, or reason |
| `project-draft` | `project` ID | `result`, a new independent draft with saved defaults and `status`. Starts no process. |
| `session-config` | `session`, optional `preparation` plus `name` | `result`, session with its derived [`status`](#session-status). Configuration saves require the current revision. |
| `session-start` | `session`, preparation `revision`, terminal `size` | `session`, then terminal stream. Claims launch once. |
| `worktree-remove` | `session` | `result`, containing `removed`. Preserves branch and history. |
| `session-resume` | `session` ID, `size`, and optional `run` (an earlier run of the session) | `session`, then a terminal stream or recorded history. With `run`, the recorded history of that run. |
| `session-terminals` | `session` ID | `result`, containing the terminals of the session in start order. Each has `number`, `run`, `tool`, `status`, `started`, and `ended`. |
| `session-handoff` | `session` ID | `result`, containing the handoff `folder`, `prompt`, and `available` (true when the folder has its README). Writes no files and starts no process. |
| `session-continue` | `session`, `latestRun` (the latest run ID that the view saw), `tool` (a tool ID, or empty for Shell), terminal `size` | `session`, then a terminal stream. Writes the handoff folder and starts one new terminal. |
| `side-terminal-open` | `session` ID, terminal `size` | `session` with the `shell` ID, then a [side terminal](#side-terminals) stream. Starts a shell when the session has no live side terminal. |
| `side-terminal-resume` | `session` ID, terminal `size`, optional `shell` ID | `session` with the `shell` ID, then the side terminal stream. Without a live side terminal, or when the live shell has another ID, `session` without `active`, then `history-end`. Starts no process. |
| `side-terminal-stop` | `session` ID, optional `shell` ID | `result`, containing `stopped`. `stopped` is false when the session has no live side terminal, or when the live shell has another ID. |

Ordinary operations send one reply, then close the connection. Replies use
`{"type":"result","result":...}` or `{"type":"error","error":"..."}`. RPC requests have
no IDs, connection multiplexing, or automatic retries. Each project-draft request
creates a new draft.

After a lost reply, inspect session-list before creating another. Reopen existing drafts
by ID through session-config. After an uncertain result, inspect session-config and
reattach. Never repeat session-start.

New sessions start with project-draft, session-config, then session-start. The project
supplies a fixed workspace. An unknown project fails before draft creation. A missing
folder fails creation or launch. The server resolves its `$SHELL` from PATH or an
absolute path.

If `$SHELL` is unset, it uses `/bin/sh`. It rejects relative shell paths. It starts the
shell with `-i`, using its startup environment and `TERM=xterm-256color`. Clients do not
supply shell settings or environment.

Settings include `appearance` with a value of `system`, `light`, or `dark`. A save
with an empty or omitted value uses `system`.

A startup command is one shell line of at most 1,000 bytes, without control characters.
The server submits it once after the PTY opens. It records the command as input,
separate from the composer draft.

`workspace` accepts an absolute path, `~`, or `~/path`. The server expands `~` using its
own `HOME`. Other relative paths, `~user`, and environment-variable expansion are
unsupported. Workspaces must resolve to existing directories. History records their
canonical paths.

Multiple sessions may share the same or overlapping workspace. Session records and
summaries have `title`, the title that the user set, and `autoTitle`, the derived title.
Show `title`, or `autoTitle` when `title` is empty. A launch without a user title sets
`autoTitle` to the tool and workspace names. See
[session titles](SPEC.md#session-titles). Terminal size is `{"rows":24,"cols":80}`, with 2–512
columns and 1–256 rows.

Protocol 15 supports multiple drafts per project, archive/restore, and paginated
collection search. Project records no longer contain a draftId. Session records and
summaries include an archived boolean. SQLite format 6 stores this independent flag.
Server startup applies the embedded migrations for supported formats.

Protocol 16 removes the controller role and the `control` and `take-control` messages.
Every view can send input. It adds `composer-watch` and the latest-save rule for
drafts. The SQLite format does not change.

Protocol 17 adds the read-only `composer-sent` operation. It lists the messages that the
message editor sent. The SQLite format does not change.

Protocol 18 adds `session-handoff` and `session-continue`. A session can have several
runs, one after another. Each run has its own terminal.

Protocol 19 adds `session-terminals` and the optional `run` field of `session-resume`.
A view can show an earlier terminal of a session. The SQLite format does not change.

Protocol 24 adds `side-terminal-open`, `side-terminal-resume`, and `side-terminal-stop`
for [side terminals](#side-terminals). The SQLite format does not change.

Protocol 25 removes `continueCommand` from tools. SQLite format 9 removes this field
from saved tools.

Protocol 27 adds automatic session titles. Session records and summaries add
`autoTitle`, and `title` holds only the user title. Settings add `titleTool`. The
operations `title-tools` and `title-test` are new. A `statuses` message adds
`revision`. SQLite format 10 adds the `auto_title` column and `titleTool: "none"`.

Database compatibility is separate from the WebSocket protocol version. Rebuild the
executable. Start the new server. Reload the browser.

Projects have stable IDs and unique canonical workspace paths. The server removes
whitespace from the start and end of names. Names must contain 1–200 characters without
control characters. General has ID `general`.

The server creates it at startup under `<instance>/workspaces/general`. Rename and
remove requests for General fail. Removing a custom project preserves sessions and
running processes, clearing only their project membership. Session summaries include
`projectId`, an empty string after their project is removed.

Session-list includes unstarted drafts. After project removal, its drafts remain under
Standalone. Their `workspace` remains the saved canonical path.

`session-list` selects only the requested archive collection, then applies query,
ordering, and group limits. A group holds the sessions of one saved project. Its key is
the project ID. Sessions without a saved project form the Standalone group, with the key
`""`. Each listed group gives its `limit` most recent sessions. With `offset`, the reply
gives one window of one group: the `limit` sessions after the first `offset` sessions. A
reply thus holds at most 100 sessions, or 101 with an included session. A client reads
more groups or more sessions in more requests. `more` lists the keys of the listed
groups that have more matching sessions after the listed ones. `sessions` keeps the
order of all listed groups together. If the `session` ID matches the collection, the
query, and a listed group, a reply without `offset` includes it outside its group limit. Separate replies can see
different activity, so a client that joins windows must drop repeated sessions. If a
result exceeds the 16 MiB message limit, the reply is an `error`. Search matches session titles, IDs, workspace paths, and
project names/paths using SQLite's ASCII case-insensitive matching. The query is a
literal substring. It does not accept SQL or wildcard expressions and does not search
event text.

`session-archive` changes visibility without deleting records or files and without
changing run/preparation state. It shares the launch lock with session-start and rejects
live sessions and unfinished launch claims. Archived drafts remain editable, but
session-start rejects them until restored. Restoration starts no process. Direct reads,
composer operations, and read-only SQL can still access archived data.

`session-list` orders by the latest `start`, `run`, `input`, `output`, or interruption
`notice` event, newest first, falling back to session creation time. `updated` carries
that timestamp. Timestamps compare in whole milliseconds. Event sequence determines the
order when timestamps are equal. Creation order, newest first, breaks remaining ties.
View changes, drafts, attachments, terminal replies, and saved screens do not affect
order.
Reattaching at the same dimensions does not resize the PTY or request an application
redraw.

## Recorded-output search

Protocol 20 adds these read-only operations. A `history-search` request contains:

```json
{
  "search": {
    "query": "migration",
    "scope": "session",
    "session": "session-id",
    "matchCase": false,
    "limit": 20
  }
}
```

`scope` is `session` (the default), `project`, or `all`. Session and project scopes
require their corresponding ID. All scopes include archived sessions. The query is
literal text of 1–256 Unicode characters. Simple Unicode folding supplies
case-insensitive matching. SQL patterns and regular expressions have no special meaning.

The reply contains `matches`, `more`, `incomplete`, `through`, and an optional `cursor`.
Results follow the event sequence, from oldest to newest. A match uses the event that
completes its text. Each match contains `title`, `workspace`, `terminal`, `tool`,
`created`, `context`, and `anchor`.

The anchor contains `session`, `run`, `seq`, `offset`, `length`, and `through`. Its
sequence identifies the first output event of the match. Offset counts Unicode
characters within that event. Length counts the matched characters across consecutive
output events of that run. Tool names use the terminal selector's fallback for an older
first terminal. Other missing names produce an empty `tool` field.

The default limit is 20, with a range of 1–50. When `more` is true, send the returned
`cursor` and `through` in the next search. Keep the query, scope, and case setting
unchanged. The cursor contains `seq` and `offset`, which identify the next Unicode
character to scan. Its offset is zero when scanning starts at the next event sequence.
The server restores per-terminal lookbehind, including split and overlapping matches.
This cutoff excludes later output from pagination and context. A new search without
`through` selects a new cutoff.

`incomplete` means a scan resource limit stopped this page before completion. Display
its results and provide **Continue search** when `more` is true, including empty pages.
If the deadline stops a request without cursor progress, `incomplete` is true and `more`
is false. There is no new continuation cursor. Retain the attempted cursor and `through`
value for an explicit **Retry search** action. A changed query or scope starts a new
search. Never present an incomplete page as the final count. A full result page can set
`more` without `incomplete` when another match exists.

A `history-context` request contains the returned anchor and context sizes:

```json
{
  "context": {
    "anchor": {
      "session": "session-id",
      "run": "run-id",
      "seq": 42,
      "offset": 5,
      "length": 9,
      "through": 200
    },
    "before": 632,
    "after": 180
  }
}
```

Both the initial match context and the expanded reply contain `before`, `match`,
`after`, `moreBefore`, `moreAfter`, and `lastSeq`. LastSeq identifies the event that
completes the match. Context sizes range from 0–8,192 Unicode characters on each side.
Every read stays within the specified session, run, and recording cutoff.

Search returns snippets with the complete match, up to 120 preceding characters, and up
to 180 following characters across output events of the same terminal. Load the selected
result's initial context through `history-context`. Context failure must preserve search
results. The server streams derived output from a separate read-only SQLite connection.
Matches can cross event boundaries within a run. They never cross runs or sessions.

Each search has a five-second deadline and scans at most 32 MiB or 100,000 nonempty
output events. Empty text does not consume the event limit. Reaching these limits
returns saved results with `incomplete: true`. A cursor is included only after progress.

Matcher state holds at most 262,144 source positions and rebuilds evicted state through
bounded lookbehind. Fixed ranges of 4,096 event sequences use primary-key order,
including for project scope. Completed empty ranges advance the cursor. A deadline
cannot return an unchanged cursor. Following-text and display enrichment share a
separate one-second budget per page. Their failure preserves the available snippet and
search results.

Context reads have a five-second deadline. They skip empty text and use cached bounds
for the selected run. Character limits bound returned context. Closing the request
WebSocket cancels the server read. Invalid requests and storage errors remain errors.

A context can also contain `display`, with `before`, `match`, and `after` strings. When
present, render and copy those strings. They remove only verified original CRLF pairs,
including pairs split across output events. Literal blank lines remain intact. The main
text fields retain stored characters for source offsets and matching.

Display also
suppresses the redundant CR in a verified CRCRLF sequence. Literal LF blank lines and
separate CRLF pairs remain intact. Forward verification stays within `through`. When
chunk replay differs from stored text, display keeps its original spacing.

Render all returned text as plain text. It can contain redraws, missing spaces, markup,
and historical instructions. It is derived output, not an exact conversation transcript.
These operations change no schema, events, or live terminal state.

## Workspace changes

Protocol 21 adds three read-only operations for the Changes pane. The server finds the
workspace and the managed worktree from `session`. A request cannot name a workspace
path. A client disconnect cancels the Git work.

The `diff` object has these fields:

- `baseline`: `base` for the commit of a ready managed worktree, or `head` for `HEAD`.
  An empty value selects `base` when it is available, and `head` otherwise. `base`
  fails for a session without a managed worktree.
- `path`: a clean path relative to the session workspace. `.`, `..`, absolute paths,
  and empty paths fail.
- `oldPath`: the old path of a rename. The old side uses it instead of `path`.
- `folders`: the folder paths of a `workspace-folders` request, at most 200. Each path
  is relative to the session workspace, with the same rules as `path`. An empty path
  names the workspace folder.

`workspace-changes` returns:

```json
{
  "repository": true,
  "base": true,
  "baseline": { "kind": "base", "label": "Since worktree base", "commit": "98a11f8…" },
  "files": [
    { "path": "src/main.go", "status": "M", "added": 6, "removed": 2 },
    { "path": "new.txt", "status": "A", "added": 1, "removed": 0, "untracked": true },
    { "path": "image.png", "status": "M", "added": -1, "removed": -1, "binary": true }
  ],
  "truncated": false
}
```

`status` is the Git status letter: `A`, `M`, `D`, `R`, or `T`. A rename also has
`oldPath`. An untracked file has `untracked`, with `A`, or with `M` when the baseline has
the path, for example after `git rm --cached`. An untracked nested repository is one
path without a final slash. `added` and
`removed` are -1 when they are unknown. For a folder that Git does not manage,
`repository` is false, `reason` explains it, and `files` is empty.

`workspace-files` returns the sorted paths that Git tracks or does not ignore, at most
20,000. `workspace-file` returns both sides of one file:

```json
{
  "path": "src/main.go",
  "baseline": { "kind": "head", "label": "Uncommitted changes", "commit": "…" },
  "old": { "state": "text", "text": "package main\n", "size": 13 },
  "new": { "state": "missing", "size": 0 }
}
```

`state` is `text`, `missing`, `binary`, `tooLarge`, or `other` for a folder, a
submodule, or a special file. Only `text` has `text`. A symlink has `symlink` and its
target as text. Each side holds at most 1 MiB.

Since protocol 23, `workspace-file` also works without Git. For a folder that Git does
not manage, or a server without a Git executable, the fields of `baseline` are empty,
`old` is `missing`, and `new` is the current file.

Protocol 23 adds `workspace-folders` for the Files tree. It needs no Git repository. It
returns one list for each requested folder, in request order:

```json
{
  "folders": [
    {
      "path": "",
      "entries": [
        { "name": "build", "kind": "folder", "ignored": true },
        { "name": "src", "kind": "folder" },
        { "name": "link", "kind": "symlink" },
        { "name": "README.md", "kind": "file" }
      ]
    },
    { "path": "src/removed", "missing": true, "entries": [] }
  ]
}
```

`kind` is `folder`, `file`, `symlink`, or `other` for a special file. The entries have
folders first, then names in order without case. The list omits `.git`. `ignored` marks
an entry that Git ignores. Git finds the repository from each listed folder. When Git
cannot check a folder, `ignoreError` has the first error, and the entries have no
`ignored` marks. Without a repository or a Git executable, there are no marks and no
error.

`missing` marks a path that the server cannot list as a folder now. This includes a
file, a symlink, and a path that goes through a symlink. One reply holds at most 20,000
entries in all folders. `truncated` marks a folder with more entries. Its entries are
then an arbitrary part of the folder.

The folders of one reply share this limit, in request order. Thus a folder can be
`truncated` in a reply for more than one folder and complete in a reply of its own.
Request such a folder alone before you replace its shown entries.

## Settings and prepared launches

Settings contain revision, defaultTool (empty means Shell), worktree, base (default
HEAD), and an ordered tools array. Each tool has a stable client-generated id, name, and
command.
Saving requires the current revision. Removing a default tool requires selecting
another default in the same save. These operations do not install or authenticate
tools.

A prepared session includes preparation with revision, state, toolId, toolName, command,
worktree, base, and branch. Configuration saves send the current preparation revision
with toolId, worktree, base, and branch, plus name for the session title. Project,
workspace, toolName, command, and state are not writable configuration fields. A change
to toolId copies the selected command from Settings.

An empty ID selects Shell and clears the command. Keeping the same tool preserves the
existing snapshot, including a removed preset. Start uses that snapshot without
resolving the preset again. Message drafts and attachments use the same session ID
before and after launch.

Preparation states are draft, creating, launched, and interrupted. Only draft accepts
configuration changes or Start. Stale starts fail before effects. A failed preflight
returns to draft only when no checkout could have been created. An uncertain launch
remains interrupted after restart and must not be automatically retried.

After a lost start response, query session-config or session-list. Use session-resume to
join its process or read history. Never repeat startup input.

## New terminals in ended sessions

`session-continue` starts a new run in an ended session. The session keeps its ID,
workspace, worktree, message draft, and history. Send the ID of the latest run from
session-config as `latestRun`. The server holds the launch lock and rejects the request
when a terminal is live, when `latestRun` is not the latest run, or when that run has
not ended. It also rejects archived sessions, sessions without a run, a managed worktree
that is not `ready`, a missing workspace, and an unknown tool.

A rejected request writes no files and starts no process. A repeated request with the
same `latestRun` fails after the first request started a terminal. After a lost
response, read session-config. If its latest run changed, use session-resume to join
the new terminal. Do not send session-continue again only because a response was lost.

Before the process starts, the server rebuilds `<instance>/handoff/<session-id>/` from
SQLite. It contains `README.md`, `messages.md`, and `terminals/<number>-<run-id>.txt`
for each earlier terminal with output. `session-handoff` returns this folder and the
prompt that points to it, without side effects. Its `available` field is true when the
folder has its `README.md`. Clients use it to show the prompt again after the new
terminal started.

`session-terminals` lists every run of a session as one terminal. `number` counts from 1
in start order. `tool` comes from the start event of the run. Start events from bbflow
0.0.4 and earlier have no tool, so the first run uses the tool of the preparation. A new
terminal has no run record until its process starts. Until then, the list ends with a
`starting` terminal that has an empty `run`. The operation starts no process and writes
no files.

The server records and submits the selected tool's `command` once. Shell submits
nothing. The client shows the handoff prompt for the user to send. The start event of
the new run records `tool`, `continues` (the previous run ID), and `handoff` (the folder).

Managed worktree metadata includes path, repository, requested base, resolved commit,
creation branch, and state (creating, ready, failed, or removed). Creation uses the
server's Git and never fetches or copies uncommitted files. Removal rejects active
bbflow workspaces and modified, untracked, or ignored files. It keeps the branch. See
[SPEC.md](SPEC.md#session-preparation-settings-and-worktrees) for supported
repositories.

## Side terminals

A side terminal is an interactive shell for ad hoc commands in the workspace of a
session. The server starts it with the same `$SHELL -i`, environment, `BBFLOW_SESSION`,
and `BBFLOW_DIR` as a session terminal. It submits no startup command. Each session has
at most one live side terminal. It is separate from the terminal of the session.

- The server writes no SQLite events, run, or saved screen for a side terminal. It keeps
  the screen only in its memory emulator.
- A side terminal has no session `status`, `status` messages, view count, handoff, or
  history search. It does not change the session order.
- The stream uses the same `frame`, `frame-ack`, `input`, `input-ack`, `resize`,
  `signal`, and `ping` messages as a session terminal. The size owner rules are also
  the same. The PTY size of the side terminal is independent of the session terminal.
- `exit` has the exit `code` and an optional `error`. It has no `status` or `run`.
- The `session` message of a live side terminal has a `shell` ID. Each new shell gets a
  new ID.

`side-terminal-open` needs a session that started a terminal. It rejects drafts,
archived sessions, and a missing workspace. The server holds the launch lock, so two
views that open at the same time join one shell. A lost view rejoins with
`side-terminal-resume` and the `shell` ID that it showed. Do not send
`side-terminal-open` again only because a connection was lost. It can start a new shell
when the earlier shell ended. Send the `shell` ID with `side-terminal-stop` too. Then a
view of an ended shell cannot join or stop a shell that another view started later.

Closing a view leaves the shell running. Stop session leaves it running too. The shell
ends when it exits, on `side-terminal-stop`, when the session is archived, and when the
server stops. `side-terminal-stop` sends SIGHUP to the shell and its foreground job, as
session stop does. `worktree-remove` rejects a managed worktree while a side terminal
uses it.

## Session status

Protocol 22 gives each session one derived `status`. Session summaries, `project-draft`
replies, and `session-config` replies contain it. The SQLite format does not change.
The stored status of a run and the state of a preparation keep their values.

| `status` | Meaning |
| --- | --- |
| `draft` | The session did not start. |
| `running` | A live terminal had application output in the last 3 seconds. Worktree creation and process start also show as `running`. |
| `idle` | A live terminal had no application output in the last 3 seconds. |
| `ended` | No terminal is live. The latest run `exited`, `stopped`, `failed`, or was `interrupted`, or the launch made no process. |

The server derives `running` and `idle` from output times only. It keeps the times in
memory and tracks them without views. Output in the 300 milliseconds after an `input`,
a `resize` that changes the PTY size, or a `signal` is not application output. This
excludes the echo of typed input and the redraw after a size change. A `resize` to the
current PTY size has no such effect, because the application does not redraw.

`idle` means only that there was no recent output. The application can be complete,
can wait for an answer, or can work without output. `idle` does not show that the
application is ready for input. Do not send input automatically because of this status.

A live view also gets the status in `status` messages on its
[terminal stream](#terminal-streams). The `status` of `session-terminals` entries, of
an ended `session` message, and of an `exit` message is the stored run status, not this
session status.

`status-watch` keeps one stream open for all sessions. The server first sends a
`statuses` message. Its `statuses` object maps the ID of each session that has a live
terminal to `running` or `idle`. The server omits the object when no terminal is live.
The server reads the statuses from memory five times each second. It sends the complete
object again after each change. Its `revision` counts the session title changes since
the server started. The server also sends the message after each title change. Then a
client reads `session-list` again. A session is absent before its terminal starts and
after its terminal ends. Read `session-list` for those sessions. The client sends `ping`
at least every 30 seconds and gets `pong`. Closing the stream only removes the watch.

## Terminal streams

After a session request, the server sends `session` with its ID and `active: true` for a
live process. Ended replies instead include the `status` of the shown run. Multiple
views share one process and emulator. Every view can send `input` and `signal`. There is
no controller role.

After `session`, a live view gets a `status` message with the
[session status](#session-status), `running` or `idle`. The server sends the message
again after each change. An ended session sends `exit` and no `status` message.

The PTY uses the viewport size of one view, the size owner. A view becomes the size owner
when it joins and no view owns the size. A view also becomes the size owner when it sends
`input`, or when it sends `resize` and no view owns the size. Before the server writes
input from a new size owner, it resizes the PTY to the size of that view. `signal` does
not change the size owner.

An input receipt always goes to the view that sent the input. Closing the socket removes
that view. The PTY keeps its size until another view becomes the size owner. No process
is stopped. Any view may use the separate `session-stop` operation to end work for
everyone.

| Direction | Type | Contents and effect |
| --- | --- | --- |
| Client → server | `input` | Base64 `data`, recorded before PTY delivery. An optional `id` requests a receipt. |
| Client → server | `resize` | This view's `size`. Only the size owner also resizes the PTY. |
| Client → server | `signal` | Numeric `signal`. The server accepts only SIGINT. |
| Client → server | `frame-ack` | `revision` of the frame that finished rendering |
| Client → server | `ping` | Keep the attachment alive |
| Server → client | `pong` | Reply to `ping` |
| Server → client | `frame` | Base64 rendered ANSI in `data`, `size`, `revision`, and optional `full` |
| Server → client | `status` | The session `status` of a live process: `running` or `idle` |
| Server → client | `input-ack` | Matching `id`. An optional `error` indicates uncertain delivery. |
| Server → client | `exit` | Exit `code`, the recorded run `status` (`exited`, `stopped`, or `failed`), the `run` ID, and optional `error`. `status` and `run` are absent when the terminal failed before its run started. Each view gets the same message. Follows the final frame acknowledgment. |
| Server → client | `history-end` | End of a read-only ended-session view |
| Server → client | `error` | Error description in `error` |

The server owns a headless xterm-go emulator per running session. The server commits
each original output and size event before it updates the emulator. It generates
terminal query replies and records them as `terminal-response` events before PTY
delivery. This continues without attached views. Historical reconstruction discards
replies.

Frame dimensions match that view's viewport. Smaller views crop columns and keep the
bottom screen rows visible, placing clipped top rows in scrollback. Larger views pad
unused space. This projection never changes the shared emulator's size or wrapping.

A view keeps the newest scrollback rows that fit in 8 MiB of rendered data. A frame
contains at most 11 MiB of rendered data, so it stays below the 16 MiB message limit
after base64 encoding. A full frame always contains the visible screen. It omits the
oldest scrollback rows that do not fit.

The first frame is always full. It contains up to 10,000 normal-buffer scrollback rows
and the current visible screen, including an active alternate screen. It has rendered
cell styles, cursor position and supported input modes. Clients reset their view and
apply the frame's dimensions before parsing a full frame. Later frames contain only
changed rows, scrollback additions and input-mode/cursor updates.

A resize, history clear, incompatible baseline, or update larger than the frame limit
produces another full frame. The display uses positioned rows. It does not reproduce
application scroll regions, source escape sequences, hyperlinks, clipboard requests, or
native process state.

Each view has its own baseline and at most one outstanding frame. After you render the
frame, acknowledge its revision. The server computes the next frame from the latest
state against that baseline. Intermediate redraws combine into one update. They do not
form an output queue or interrupt capture.

Frames are limited to 20 per second. Revisions increase within an attachment. A new
attachment starts with a full frame and a fresh baseline. The server rejects stale,
duplicate, or out-of-order acknowledgments. It accepts controls only after the first
frame acknowledgment.

Control receipts use a separate bounded queue. Clients must acknowledge frames within 30
seconds. Idle readers must send a message within 30 seconds. Clients send `ping` every
five seconds, detect missing server activity after about 20 seconds, and retry transport
failures with delays from 0.5 to 30 seconds. A stalled transport may be closed, but its
process and capture continue.

A protocol or identity mismatch requires explicit recovery. The browser reconnects to
its original verified instance. If the server port changes, reopen the UI. During
shutdown, the server allows connections up to five seconds to receive completion. Then
it closes them.

Ended sessions send one full frame of their latest run, wait for its acknowledgment,
then send `history-end`. A request with `run` gets the same reply for that run, also
while a later run is live. Its `session` message has the `status` of that run. The view
never joins the live process. Without `run`, or with the ID of the live run, the view
joins the live process. A `run` of another session or an unknown run fails before any
frame. Normal completion stores a derived final view in a versioned `terminal-screen`
SQLite event. Without that cache, the server emulates the original recording in bounded
pages. Opening history never starts a process or sends recorded input. The browser
retains the recorded dimensions and styles.

An input `id` is an opaque correlation value up to 80 bytes. A receipt without an error
means the input was recorded and written to the PTY. It does not mean the application
accepted or completed a message.

A failure, missing receipt, or closed connection leaves delivery uncertain. IDs do not
prevent duplicate input. Never resend input automatically. Reconnect uses
`session-resume` for a known ID and never repeats `session-start`.

## Drafts and file references

`composer-draft` returns `{"draft": {...}, "attachments": [...]}`. A draft contains
`revision` (event sequence, initially zero), `text`, `attachments` (attachment IDs), and
`pending` (possible input delivery). To save, send the whole draft with the revision
that the view last loaded or saved. A save returns its new revision. Omit the entire
`draft` field to load the latest saved state.

The latest save wins, also when its revision is older than the current revision.
Earlier revisions stay in the archive. One exception keeps sends safe. The server does
not store a save from an older revision when that revision or a later one is pending.
The reply then contains the latest draft and `rejected: true`. A negative revision or a
revision above the current revision fails with an error.

`composer-watch` keeps one stream open for one session. The server first sends a `draft`
message with `session` and the latest state in `composer`. It then sends a `draft`
message after each newer save. A slow view can skip intermediate revisions. It never
receives an older revision after a newer one. The client sends `ping` at least every 30
seconds and gets `pong`. Closing the stream only removes the watch.

Draft text is limited to 64 KiB of UTF-8 and at most 8 distinct attachments from that
session. Each attachment contains `id`, `name`, `mediaType`, `size`, and `path`. Uploads
have a 4 MiB limit. Names must be single basenames without control characters.

The path points to a private copy in the selected instance's attachment cache. SQLite
stores original file bytes and metadata. Draft reads regenerate cache files. Uploads do
not add themselves to a draft.

Add the returned ID with `composer-draft`. Neither operation sends terminal input.
Uploads are not automatically retried, and unused uploads remain in the archive.

The browser saves `pending: true` before sending input and clears the draft only after a
successful receipt. A retained pending draft requires explicit user review before reuse.
Plain draft text and uploaded files are never replayed as input by the server. Clients
compose local file references and paste delimiters. The server preserves the submitted
input bytes. It does not implement a provider message or image protocol.

`composer-sent` lists these sends. Each pending draft revision is one sent message. A
message contains `revision`, `created`, `text`, `attachments` (attachment metadata), and
`confirmed`. To read older messages, send the `revision` of the oldest message that you
have. The list includes only sends from the message editor, not direct terminal input.

`confirmed` is derived data. It is true when the next draft revision is empty and not
pending. The browser saves that revision only after an input receipt. Any other next
revision, or no next revision, gives `false`. A receipt confirms the PTY write only. It
does not confirm that the application accepted the message. The operation never sends
input.

## Browser access

The HTTP Host must be `127.0.0.1:PORT` or `localhost:PORT`. An Origin header, if
present, must have the same host and port. CLI clients omit Origin. Browser clients send
it automatically. The server rejects other sites, different ports, and opaque origins
such as `file:` pages.

The embedded UI is served from the same local origin at `/`. Separate UI development
servers would need an explicit origin policy change or a same-origin proxy. There is no
authentication token or TLS. Host and origin checks do not authenticate local programs.

A browser client on the matching local origin can use the standard API:

```js
const socket = new WebSocket(`ws://${location.host}/ws`);
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.type === "server") {
    if (message.server.protocol !== "bbflow/27") {
      socket.close();
      throw new Error("Unsupported bbflow protocol");
    }
    socket.send(JSON.stringify({
      type: "request",
      request: { protocol: "bbflow/27", operation: "session-list", groups: [""], limit: 10 }
    }));
  } else {
    console.log(message);
  }
};
```

A UI served by that instance uses its own local origin. A client connecting to an
endpoint discovered elsewhere must also verify the expected instance identity.

The embedded UI reads `GET /client-config` for the current `ServerInfo`, then checks
protocol, directory, instance ID, and port against each WebSocket greeting before
sending a request. It requires reload when the server identity changes. This endpoint
only supplies browser connection information. Every session and history operation still
uses the shared WebSocket protocol. Static assets are under `/assets/`.

All HTTP routes enforce the loopback Host check. Responses disable caching, MIME
sniffing, embedding in frames, and external script loading. The UI uses text nodes for
metadata and notices.

Decode frame data from base64 before passing it to the display. The server answers
source terminal queries. A client must not create replies from old recordings. The
browser's terminal and optional composer share the same input stream.

The Go message definitions are in `internal/protocol/protocol.go`. Their browser types
and transport are in `web/src/protocol.ts`. Server routing is in
`internal/server/server.go`. See [COMMANDS.md](COMMANDS.md) for user commands and
[SPEC.md](SPEC.md) for storage and runtime behavior.
