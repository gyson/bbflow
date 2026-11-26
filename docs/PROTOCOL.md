# Client/server protocol

The bbflow server and its clients exchange JSON messages over WebSocket. The browser UI
and the CLI use the same protocol. This document is the reference for the connection,
each operation, and each stream. See [COMMANDS.md](COMMANDS.md) for user commands and
[SPEC.md](SPEC.md) for storage and runtime behavior.

## Contents

| Section | Contents |
| --- | --- |
| [Transport](#transport) | The endpoint, the message format, and the protocol version. |
| [Connections and requests](#connections-and-requests) | The greeting, its verification, shutdown, the request message, and replies. |
| [Operations](#operations) | Each operation, with its request fields and its reply. |
| [Sessions and projects](#sessions-and-projects) | New sessions, session fields, projects, the session list, and archive. |
| [Recorded-output search](#recorded-output-search) | `history-search` and `history-context`. |
| [Workspace changes](#workspace-changes) | The operations of the Changes and Files views. |
| [Settings and prepared launches](#settings-and-prepared-launches) | Settings, model lists, usage limits, the preparation of a session, and managed worktrees. |
| [New terminals in ended sessions](#new-terminals-in-ended-sessions) | `session-continue`, the handoff folder, and `session-terminals`. |
| [Side terminals](#side-terminals) | The shell of the workspace pane. |
| [Session status](#session-status) | The derived status, `status-watch`, and the release check state. |
| [Terminal streams](#terminal-streams) | The messages of a live terminal, frames, and receipts. |
| [Drafts and file references](#drafts-and-file-references) | The message editor operations. |
| [Browser access](#browser-access) | The Host and Origin rules, the remote host, and the HTTP routes. |
| [Protocol versions](#protocol-versions) | The changes of each protocol version from 15. |
| [Source files](#source-files) | The code that defines the protocol. |

## Transport

Each operation uses one WebSocket connection to a loopback port. Each message is one
JSON object in a text message. Session operations, queries, and health checks need the
same protocol version in the server and the client. Shutdown is the exception. It uses
the version that the verified server advertises, so a client can stop a server with
another protocol version.

### Endpoint

The CLI selects an instance directory with global `--dir`, `BBFLOW_DIR`, or its build
default. It reads the assigned port from `<instance>/server.json` and connects to
`ws://127.0.0.1:PORT/ws`.

The server uses the loopback port from Settings, or else the port that it saved at its
last start. When neither port is free, the operating system assigns a new one. The
server holds the port at `127.0.0.1` and `::1`, because browsers open the UI at
`localhost`. HTTP also serves the embedded web UI and its connection information.

### Messages

The transport uses [Gorilla WebSocket](https://github.com/gorilla/websocket). Each
WebSocket text message contains one JSON object. There is no bbflow length prefix or
binary envelope. The limit is 16 MiB per message, including all fragments.

The server rejects binary messages, malformed JSON, and multiple JSON values in one
message. Terminal bytes use base64 in `data`. This preserves arbitrary bytes and control
codes.

### Protocol version

This is an early development protocol. The server greeting and first request verify
version `bbflow/46`. The protocol needs no WebSocket subprotocol header. Session
operations and health checks reject unsupported versions. Shutdown uses the verified
server's advertised version, so `server restart` can replace a server after a session
protocol change. This requires the same greeting and shutdown envelope.

There is no fallback for previous transports. The server upgrades supported older
database formats before it accepts requests. These formats do not imply support for
their previous WebSocket protocols. See [database upgrades](SPEC.md#database-upgrades)
and [Protocol versions](#protocol-versions).

## Connections and requests

Open one connection per operation. The server sends a greeting first. The client
verifies the greeting, and then sends one request. A health check is the exception. It
verifies the greeting and closes the connection without a request. Most operations send
one reply and close the connection. Some operations keep a stream open.

### Greeting

The server immediately sends a greeting:

```json
{
  "type": "server",
  "server": {
    "protocol": "bbflow/46",
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

### Health check and shutdown

A separate health check cannot prevent a race with server replacement. An invalid or
stale descriptor must never direct a command to a different server. To check health,
read and verify the greeting. Then close the connection.

The menu companion retains its parent's verified connection information at startup. Quit
reconnects to that endpoint and checks the greeting against the retained identity. It
does not depend on a later copy of `server.json`. It cannot stop a replacement instance.

For shutdown, send `stop` with the protocol and instance ID from that verified greeting.
Require a `result` with `{"stopping":true}`. Wait for release of the archive lock before
you start a replacement. Do not retry with another protocol or kill a stored PID.

### Request

HTTP headers and the WebSocket upgrade have five-second timeouts. Server writes time
out after five seconds. After the greeting, send a `request` message within five
seconds:

```json
{
  "type": "request",
  "request": {
    "protocol": "bbflow/46",
    "operation": "session-list",
    "groups": [""],
    "limit": 10
  }
}
```

Requests contain no archive path. The connection reaches one server and its archive. The
browser is the session client. The management CLI uses health, shutdown, query, and
storage-report operations.

### Replies and retries

Ordinary operations send one reply, then close the connection. Replies use
`{"type":"result","result":...}` or `{"type":"error","error":"..."}`. RPC requests have
no IDs, connection multiplexing, or automatic retries. Each project-draft request
creates a new draft.

After a lost reply, inspect session-list before creating another. Reopen existing drafts
by ID through session-config. After an uncertain result, inspect session-config and
reattach. Never repeat session-start.

## Operations

Each table gives the operations of one area. Each request also has the `protocol` and
`operation` fields. The sections after this one give the details of the fields and the
replies.

### Server operations

| Operation | Additional request fields | Reply |
| --- | --- | --- |
| `stop` | `instance`, from the verified greeting | `result`, containing `stopping`. The server then shuts down. |
| `update-check` | None | `result`, containing `checking`. The server starts a [release check](SPEC.md#release-check) at once, also while the daily check setting is off. A running check answers the request. The status watch sends the result. A build that cannot update rejects it. |
| `update-start` | `version` and `revision`, the `available` version and the `revision` of the [release offer](#release-check-state) that the user confirmed | `result`, containing `updating`. The server installs the release in the background and then restarts, which ends all live sessions. It rejects another version, an earlier revision, and a second update. |
| `query` | `sql` | `result`, containing `columns`, `rows`, and `truncated` |
| `storage-report` | None | `result`, containing database facts, `total`, `columns`, session counts, and the `kinds`, `days`, `projects`, and `sessions` lists. `sessions` has only the largest sessions. The other lists have one entry for each project, day, or kind. Above 16 MiB, the reply is an `error`. See [storage report](SPEC.md#storage-report). Closing the connection cancels the read. |
| `status-watch` | None | A stream of `statuses` messages: the [status](#session-status) of each live terminal and the [release check state](#release-check-state) first, then all of them again after each change |

### Project operations

| Operation | Additional request fields | Reply |
| --- | --- | --- |
| `project-list` | None | `result`, containing projects with `id`, `name`, `workspace`, and `created` |
| `project-add` | `workspace`, optional `name` | `result`, containing the new project |
| `project-rename` | `project` ID, `name` | `result`, containing `renamed` |
| `project-remove` | `project` ID | `result`, containing `removed`. Sessions become standalone. |
| `workspace-inspect` | `workspace` | `result`, Git availability, root, HEAD, branch, or reason |

### Session operations

| Operation | Additional request fields | Reply |
| --- | --- | --- |
| `project-draft` | `project` ID, or `parent` session ID for a sub-session draft | `result`, a new independent draft with saved defaults and `status`. Starts no process. See [New sessions](#new-sessions). |
| `session-config` | `session`, optional `preparation` plus `name` | `result`, session with its derived [`status`](#session-status). Configuration saves require the current revision. |
| `session-start` | `session`, preparation `revision`, terminal `size` | `session`, then terminal stream. Claims launch once. Before `session`, a `status` of `running` comes every 5 seconds while the server fetches the base and creates the worktree. |
| `session-resume` | `session` ID, `size`, and optional `run` (an earlier run of the session) | `session`, then a terminal stream or recorded history. With `run`, the recorded history of that run. |
| `session-stop` | `session` ID | `result`, containing `stopped`. `stopped` is false when the session has no live terminal, for example during worktree creation. |
| `session-rename` | `session` ID, `name` | `result`, containing `renamed`. An empty `name` removes the user title. |
| `session-list` | See [Session list](#session-list). | `result`, containing `sessions` (session summaries) and `more` (group keys). Each summary has a derived [`status`](#session-status), `parentId`, `pinned`, an optional `context` flag, and an optional `runStatus`, the stored status of the latest run. |
| `session-archive` | `session` ID, `archived` boolean (true to archive, false to restore), optional `members` (the sub-session IDs that the user confirmed; missing confirms none) | `result`, containing `archived`. Applies to the family. See [Session archive](#session-archive). Rejects active runs and unfinished launch claims. |
| `session-pin` | `session` ID, `pinned` boolean (true to pin, false to unpin) | `result`, containing `pinned`. See [Session pins](#session-pins). |
| `worktree-remove` | `session` | `result`, containing `removed`. Preserves branch and history. |
| `session-terminals` | `session` ID | `result`, containing the terminals of the session in start order. Each has `number`, `run`, `tool`, an optional `toolId`, `status`, `started`, and `ended`. |
| `session-handoff` | `session` ID | `result`, containing the handoff `folder`, `prompt`, and `available` (true when the folder has its README). Writes no files and starts no process. |
| `session-continue` | `session`, `latestRun` (the latest run ID that the view saw), `tool` (a tool ID, or empty for Shell), optional `model` and `effort`, terminal `size` | `session`, then a terminal stream. Writes the handoff folder and starts one new terminal. |

### History operations

| Operation | Additional request fields | Reply |
| --- | --- | --- |
| `history-search` | `search` object. See [Recorded-output search](#recorded-output-search). | `result`, containing `matches`, `more`, `incomplete`, `through`, and an optional `cursor` |
| `history-context` | `context` object. See [Recorded-output search](#recorded-output-search). | `result`, containing `before`, `match`, `after`, continuation flags, and `lastSeq` |

### Workspace operations

See [Workspace changes](#workspace-changes) for the `diff` object and each reply.

| Operation | Additional request fields | Reply |
| --- | --- | --- |
| `workspace-changes` | `session` ID, `diff` object with optional `baseline` and `from` | `result`, containing `repository`, `base`, `baseline`, `commits`, an optional `moreCommits`, `files`, and `truncated` |
| `workspace-files` | `session` ID | `result`, containing `repository`, `paths`, and `truncated` |
| `workspace-folders` | `session` ID, `diff` object with `folders` | `result`, containing `folders` and an optional `ignoreError` |
| `workspace-file` | `session` ID, `diff` object with `path`, optional `oldPath`, `baseline`, and `from` | `result`, containing `path`, `baseline`, and the `old` and `new` sides |
| `workspace-open` | `session` ID, `diff` object with `path` | `result`, containing `opened` |
| `workspace-reveal` | `session` ID, `diff` object with `path` | `result`, containing `revealed` |

### Message editor operations

See [Drafts and file references](#drafts-and-file-references).

| Operation | Additional request fields | Reply |
| --- | --- | --- |
| `composer-draft` | `session` ID, optional `draft` | `result`, containing the saved `draft` and attachment metadata. Omit `draft` to read. A rejected save returns the latest draft with `rejected: true`. |
| `composer-watch` | `session` ID | A stream of `draft` messages: the latest draft first, then each newer saved draft |
| `composer-sent` | `session` ID, optional `revision` (list sends older than this revision) | `result`, containing `messages` (at most 20, newest first) and `more` |
| `composer-attach` | `session` ID, `upload` with `name`, `mediaType`, base64 `data` | `result`, containing attachment metadata and its local file path |

### Settings and title operations

See [Settings and prepared launches](#settings-and-prepared-launches).

| Operation | Additional request fields | Reply |
| --- | --- | --- |
| `settings-get` | none | `result`, saved settings and revision |
| `settings-save` | `settings`, including current revision | `result`, updated settings and revision. It keeps the saved `titleTool`, `titleCommand`, `titleModel`, and `titleEffort`. |
| `tool-check` | None | `result`, containing `installed`: the agent types whose [program](SPEC.md#tool-program) the server finds, such as `{"codex": true}`. It finds only the CLI. |
| `tool-models` | `toolType`: `codex`, `claude`, `agy`, or `code-puppy`. Optional `refresh` | `result`, the model list of the type. See [Model lists](#model-lists). |
| `tool-usage` | `toolType`: `codex`, `claude`, or `agy`. Optional `refresh` | `result`, the last usage check of the type. See [Usage limits](#usage-limits). |
| `title-tools` | None | `result`, containing `tools`, the built-in title tools with `id`, `name`, and the exact `command` with the default model and the [program](SPEC.md#tool-program) of the type, and for Claude, Codex, and Code Puppy also `type`, `prefix`, `suffix`, `model`, and `effort`. The command with another model is `prefix`, the model options of `type`, then `suffix`. and `sample`, the message of a title test. Custom is not in the list. |
| `title-test` | `settings` with `titleTool`, `titleModel` and `titleEffort`, and `titleCommand` for `custom` | `result`, containing the `title`. It runs the title tool once with the sample message and saves nothing. `custom` needs `titleCommand`. The client sends the custom command that it shows, so the test runs that command. |
| `title-tool-set` | `settings` with `titleTool`, `titleModel` and `titleEffort`, and `titleCommand` for `custom` | `result`, containing the saved `settings` with a new revision, and the `title` of the test. See [Title tool change](#title-tool-change). |

### Side terminal operations

| Operation | Additional request fields | Reply |
| --- | --- | --- |
| `side-terminal-open` | `session` ID, terminal `size` | `session` with the `shell` ID, then a [side terminal](#side-terminals) stream. Starts a shell when the session has no live side terminal. |
| `side-terminal-resume` | `session` ID, terminal `size`, optional `shell` ID | `session` with the `shell` ID, then the side terminal stream. Without a live side terminal, or when the live shell has another ID, `session` without `active`, then `history-end`. Starts no process. |
| `side-terminal-stop` | `session` ID, optional `shell` ID | `result`, containing `stopped`. `stopped` is false when the session has no live side terminal, or when the live shell has another ID. |

## Sessions and projects

A session belongs to a project, or it is standalone. A new session is first a draft.
The client configures the draft and then starts it. The session list groups sessions by
project and by family.

### New sessions

New sessions start with project-draft, session-config, then session-start.

- The project supplies a fixed workspace. An unknown project fails before draft
  creation. A missing folder fails creation or launch.
- With `parent`, `project-draft` makes a sub-session draft. The draft joins the family
  of that session. A top-level session becomes the parent. For a sub-session, its
  parent becomes the parent, so the draft is a sibling.
- The draft takes the project of the family. The request fails for a missing session, a
  family without a saved project, and an archived parent.
- A sub-session draft without a worktree starts in the current workspace of its parent.
  Its start fails until the first terminal of the parent started.
- The parent of a sub-session does not change.

The server resolves its `$SHELL` from PATH or an absolute path. If `$SHELL` is unset, it
uses `/bin/sh`. It rejects relative shell paths. It starts the shell with `-i`, using
its startup environment and `TERM=xterm-256color`. Clients do not supply shell settings
or environment.

### Session fields

- Session records and summaries have `title`, the title that the user set, and
  `autoTitle`, the derived title. Show `title`, or `autoTitle` when `title` is empty.
- A launch without a user title sets `autoTitle` to the tool and workspace names. See
  [session titles](SPEC.md#session-titles).
- Terminal size is `{"rows":24,"cols":80}`, with 2–512 columns and 1–256 rows.
- Multiple sessions may share the same or overlapping workspace.

### Workspace paths

`workspace` accepts an absolute path, `~`, or `~/path`. The server expands `~` using its
own `HOME`. Other relative paths, `~user`, and environment-variable expansion are
unsupported. Workspaces must resolve to existing directories. History records their
canonical paths.

### Projects

Projects have stable IDs and unique canonical workspace paths. The server removes
whitespace from the start and end of names. Names must contain 1–200 characters without
control characters.

Removing a project preserves sessions and running processes, clearing only their
project membership. Session summaries include `projectId`, an empty string after their
project is removed. Session-list includes unstarted drafts. After project removal, its
drafts remain under Standalone. Their `workspace` remains the saved canonical path.

### Session list

A `session-list` request has these fields:

| Field | Meaning |
| --- | --- |
| `groups` | Group keys. Required. |
| `limit` | The number of families for each group. The default is 10. `limit` times the number of groups is at most 100. |
| `offset` | Optional. The number of families to skip. The default is 0. It needs exactly one group. |
| `session` | Optional. The ID of a session whose family to include. Not with `offset`. |
| `archived` | The archive collection. The default is false. |
| `query` | Optional. The search text, at most 800 bytes. |

Groups, families, and windows have these rules:

- `session-list` selects only the requested archive collection, then applies query,
  ordering, and group limits.
- A group holds the sessions of one saved project. Its key is the project ID. Sessions
  without a saved project form the Standalone group, with the key `""`.
- Outside the archive collection, pinned families form the Pinned group, with the key
  `pinned`. A pinned family is not in the group of its project. The archive collection
  ignores pins. See [Session pins](#session-pins).
- A family is a top-level session and its sub-sessions. It counts as one entry of its
  group.
- Each listed group gives its `limit` most recent families.
- With `offset`, the reply gives one window of one group: the `limit` families after
  the first `offset` families.
- A reply thus holds at most 100 families, or 101 with an included family. A family
  lists all of its members that the reply selects, without a separate limit.
- A client reads more groups or more families in more requests.
- `more` lists the keys of the listed groups that have more matching families after the
  listed ones.
- `sessions` keeps the order of all listed families together. Each family lists its
  top-level session first, then its sub-sessions in creation order.
- If the `session` ID matches the collection, the query, and a listed group, a reply
  without `offset` includes its family outside its group limit.
- Separate replies can see different activity, so a client that joins windows must drop
  repeated families.
- If a result exceeds the 16 MiB message limit, the reply is an `error`.

The query has these rules:

- A family is listed when one of its members in the collection matches the query.
- A match of the top-level session lists all of its members in the collection.
  Otherwise the reply lists only the matching sub-sessions. The top-level session then
  has `context: true`.
- `context` also marks a top-level session from the other collection, for example a
  parent that is not archived of an archived sub-session.
- The latest member in the collection gives the position of the family.
- Search matches session titles, IDs, workspace paths, and project names/paths using
  SQLite's ASCII case-insensitive matching.
- The query is a literal substring. It does not accept SQL or wildcard expressions and
  does not search event text.

### Session order

`session-list` orders by the latest `start`, `run`, `input`, `output`, or interruption
`notice` event that is not quiet, newest first, falling back to session creation time.
The Pinned group orders by the time of the pin, newest first, and activity does not
change that order. `updated` carries that timestamp. Timestamps compare in whole
milliseconds. Event sequence determines the order when timestamps are equal. Creation
order, newest first, breaks remaining ties.

A quiet event has `quiet` 1 in the `events` table. It is a focus report or a mouse
report of a view, or output that is not application output: output that changes
nothing on the screen, and output in the 300 milliseconds after an `input`, a `resize`,
or a `signal`. Output counts only after the server sets its flag, also for a terminal
that starts during the list read. See [session list order](SPEC.md#session-list-order).

View changes, focus changes, the redraw after a size change, drafts, attachments,
terminal replies, and saved screens do not affect order. Reattaching at the same
dimensions does not resize the PTY or request an application redraw.

### Session archive

- `session-archive` changes visibility without deleting records or files and without
  changing run/preparation state.
- Archive of a top-level session also archives its sub-sessions. Every member must be
  stopped.
- Each archive fails with no change unless the sub-sessions of the session that are not
  archived are exactly `members`. A sub-session has none. A missing or empty list
  confirms no sub-sessions.
- Restore of a top-level session also restores its archived sub-sessions. Restore of a
  sub-session also restores its archived parent.
- It shares the launch lock with session-start and rejects live sessions and unfinished
  launch claims.
- Archived drafts remain editable, but session-start rejects them until restored.
  Restoration starts no process.
- Direct reads, composer operations, and read-only SQL can still access archived data.
- Archive removes the pin of each archived session. Restore does not pin it again.

### Session pins

- `session-pin` with `pinned: true` pins a top-level session that is not archived. It
  rejects a sub-session and an archived session.
- A pin puts the family first in the Pinned group. A pin of a pinned session keeps its
  time, and an unpin of a session without a pin changes nothing.
- At most 20 sessions have a pin. A further pin fails with no change. Thus a
  `session-list` request with the group `pinned` and `limit` 20 lists the whole group.
- `session-config` and each session summary have `pinned`. It is true for a pinned
  top-level session, also in a summary of the archive collection.
- The server does not notify other views. They see the change at their next
  `session-list`.

## Recorded-output search

`history-search` finds literal text in the recorded terminal output. `history-context`
reads the text around one match. Both operations are read-only. They change no schema,
events, or live terminal state.

### Search request

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

### Search reply

The reply contains `matches`, `more`, `incomplete`, `through`, and an optional `cursor`.
Results follow the event sequence, from oldest to newest. A match uses the event that
completes its text. Each match contains `title`, `workspace`, `terminal`, `tool`,
`created`, `context`, and `anchor`.

The anchor contains `session`, `run`, `seq`, `offset`, `length`, and `through`. Its
sequence identifies the first output event of the match. Offset counts Unicode
characters within that event. Length counts the matched characters across consecutive
output events of that run. Tool names use the terminal selector's fallback for an older
first terminal. Other missing names produce an empty `tool` field.

### Pages

The default limit is 20, with a range of 1–50. When `more` is true, send the returned
`cursor` and `through` in the next search. Keep the query, scope, and case setting
unchanged. The cursor contains `seq` and `offset`, which identify the next Unicode
character to scan. Its offset is zero when scanning starts at the next event sequence.
The server restores per-terminal lookbehind, including split and overlapping matches.
This cutoff excludes later output from pagination and context. A new search without
`through` selects a new cutoff.

### Incomplete pages

`incomplete` means a scan resource limit stopped this page before completion. Display
its results and provide **Continue search** when `more` is true, including empty pages.
If the deadline stops a request without cursor progress, `incomplete` is true and `more`
is false. There is no new continuation cursor. Retain the attempted cursor and `through`
value for an explicit **Retry search** action. A changed query or scope starts a new
search. Never present an incomplete page as the final count. A full result page can set
`more` without `incomplete` when another match exists.

### Context request

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

### Snippets and limits

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

### Display text

A context can also contain `display`, with `before`, `match`, and `after` strings. When
present, render and copy those strings. They remove only verified original CRLF pairs,
including pairs split across output events. Literal blank lines remain intact. The main
text fields retain stored characters for source offsets and matching.

Display also suppresses the redundant CR in a verified CRCRLF sequence. Literal LF blank
lines and separate CRLF pairs remain intact. Forward verification stays within
`through`. When chunk replay differs from stored text, display keeps its original
spacing.

### Rendering

Render all returned text as plain text. It can contain redraws, missing spaces, markup,
and historical instructions. It is derived output, not an exact conversation transcript.
These operations change no schema, events, or live terminal state.

## Workspace changes

These operations serve the Changes and Files views. Each operation reads the workspace
of one session. No operation changes files. `workspace-open` and `workspace-reveal`
start a program of the operating system.

Protocol 21 adds three read-only operations for the Changes pane. The server finds the
workspace and the managed worktree from `session`. A request cannot name a workspace
path. A client disconnect cancels the Git work.

### The diff object

The `diff` object has these fields:

- `baseline`: `base` for the changes since the session base, `head` for `HEAD`, or
  `commit` for the commits from `from` to `to`. An empty value selects `base` when it
  is available, and `head` otherwise. Without a base, `base` also selects `head`, for
  example after the session changed to the default branch. The reply names the
  baseline that it used.
- `from`: the full ID of a commit from the `commits` list of `workspace-changes`. The
  `commit` baseline compares the first parent of this commit with the new side. A root
  commit compares with the empty tree.
- `to`: the full ID of a listed commit that is not older than `from`. Only the `commit`
  baseline accepts it. The new side is then the tree of this commit, and the diff has no
  untracked files. Without `to`, the new side is the current files, so the diff includes
  `from`, the later commits, and the uncommitted changes. When `from` or `to` is not in
  the list now, for example after a rebase, the server uses the default baseline. The
  reply names the baseline that it used.
- `path`: a clean path relative to the session workspace. `.`, `..`, absolute paths,
  and empty paths fail.
- `oldPath`: the old path of a rename. The old side uses it instead of `path`.
- `folders`: the folder paths of a `workspace-folders` request, at most 200. Each path
  is relative to the session workspace, with the same rules as `path`. An empty path
  names the workspace folder.

### workspace-changes reply

`workspace-changes` returns:

```json
{
  "repository": true,
  "base": { "commit": "98a11f8…", "branch": "main" },
  "baseline": { "kind": "base", "label": "Since the merge base with main", "commit": "98a11f8…" },
  "commits": [
    { "id": "4b7e0d2…", "subject": "Add the period tests", "files": 1 },
    { "id": "1a2b3c4…", "subject": "Move the period code", "files": 2 }
  ],
  "files": [
    { "path": "src/main.go", "status": "M", "added": 6, "removed": 2 },
    { "path": "new.txt", "status": "A", "added": 1, "removed": 0, "untracked": true },
    { "path": "image.png", "status": "M", "added": -1, "removed": -1, "binary": true }
  ],
  "truncated": false
}
```

`status` is the Git status letter: `A`, `M`, `D`, `R`, or `T`. A rename also has
`oldPath`. An untracked file has `untracked`, with `A`, or with `M` when the baseline
has the path, for example after `git rm --cached`. An untracked nested repository is one
path without a final slash. `added` and `removed` are -1 when they are unknown. For a
folder that Git does not manage, `repository` is false, `reason` explains it, and
`files` is empty.

`base` is present when the session has a base. For a ready managed worktree, `commit`
is its recorded commit and `branch` is absent. For other sessions, `commit` is the
merge base of `HEAD` and the default branch, and `branch` names that branch. The
default branch is the target of `origin/HEAD`, for example `origin/main`, or else
`main`. There is no base without such a branch, without a merge base, or when `HEAD` is
the merge base, because no commit of `HEAD` is missing from the default branch. Local
commits on `main` that `origin/main` does not have get `origin/main` as their base.

The `commits` list has these rules:

- `commits` lists the commits since the base, newest first, at most 30. The list
  follows the first parent from `HEAD` and stops at the base. Without a base, it has
  the latest commits of `HEAD`.
- The list also omits the last commit of a shallow clone, because its parent is not
  available. A root commit stays in the list.
- `files` counts the files that the commit changes in the session workspace. It finds
  renames and compares a root commit with the empty tree, as the file list does.
- `moreCommits` is true when older commits are not in the list. A repository without
  commits has an empty list.
- For a `commit` baseline, `baseline` also has `from`, an optional `to`, and `commit`,
  the first parent of `from`.
- A `workspace-file` reply can name the default baseline when `from`, `to`, or the base
  left the list after the `workspace-changes` reply. Read the changes again before you
  show such a file.

### workspace-files and workspace-file

`workspace-files` returns the sorted paths that Git tracks or does not ignore, at most
20,000. `workspace-file` returns both sides of one file. With `to`, the new side comes
from the tree of that commit. Otherwise, it is the current file:

```json
{
  "path": "src/main.go",
  "baseline": { "kind": "head", "label": "Uncommitted changes", "commit": "…" },
  "old": { "state": "text", "text": "package main\n", "size": 13 },
  "new": { "state": "missing", "size": 0 }
}
```

`state` is `text`, `missing`, `binary`, `image`, `tooLarge`, or `other` for a folder,
a submodule, or a special file. Only `text` has `text`. A symlink has `symlink` and its
target as text. A text or binary side holds at most 1 MiB.

Since protocol 34, binary data in the PNG, JPEG, GIF, or WebP format is an `image`
side. The server reads the format from the first bytes, not from the file extension.
`mediaType` is `image/png`, `image/jpeg`, `image/gif`, or `image/webp`, and `data`
holds the bytes in base64. An image side holds at most 5 MiB. A symlink is never an
image. SVG is text, so the client shows it from `text`:

```json
{ "state": "image", "mediaType": "image/png", "data": "iVBORw0KGgo…", "size": 3419 }
```

Since protocol 23, `workspace-file` also works without Git. For a folder that Git does
not manage, or a server without a Git executable, the fields of `baseline` are empty,
`old` is `missing`, and `new` is the current file.

### workspace-folders

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

### workspace-open

Protocol 35 adds `workspace-open`. It opens a current HTML file of the session
workspace in the default browser of the server user. `diff.path` names the file,
with the same rules as `path`. The extension must be `.html` or `.htm`, in any case.
The path must name a regular file, and no part of it can be a symlink. On macOS, the
server then finds the default browser, the application that opens `https` URLs. It
runs `open -a` with that browser and the absolute path. It waits up to 10 seconds and
returns `{ "opened": true }`. On other systems, the operation gives an error.

A path that does not follow these rules, a missing file, or a failed opener gives an
error. The error of a failed opener gives only the cause, so that a client can name the
action. The operation does not change files. A browser loads the file as a `file:` page.
Such a page has an opaque origin, so the server rejects its WebSocket connections. See
[browser access](#browser-access).

### workspace-reveal

- Protocol 37 adds `workspace-reveal`. It shows a current entry of the session
  workspace in Finder.
- `diff.path` names the entry, with the same rules as `path`. The entry can be a file
  of any type or a folder. No part of the path can be a symlink.
- On macOS, the server runs `open -R` with the absolute path. Finder then selects the
  entry and does not open it. The server waits up to 10 seconds and returns
  `{ "revealed": true }`. On other systems, the operation gives an error.
- A path that does not follow these rules, a missing entry, or a failed opener gives an
  error. The error of a failed opener gives only the cause, as for `workspace-open`.
- The operation does not change files.

## Settings and prepared launches

Settings hold the defaults and the tools of an instance. A preparation is the saved
launch configuration of one session. Each of them has a revision, and a save needs the
current revision.

### Settings

- Settings contain revision, defaultTool (empty means Shell), worktree, base (default
  HEAD), and an ordered tools array. Each tool has a stable client-generated id, name,
  command, type, model, effort, builtin, enabled, and path.
- path is the optional [CLI path](SPEC.md#tool-program) of a built-in tool. A save with
  a path for another tool fails.
- A save holds at most 100 custom tools. The built-in tools do not count.
- builtin marks the [built-in tool](SPEC.md#built-in-tools) of an agent type. The server
  owns it. A save cannot remove a built-in tool or change its type. A save without one
  keeps it. The saved list has the built-in tools first, then the other tools. enabled
  turns a tool on or off. A tool with a new id starts on, whatever the save sends.
  defaultTool must name a tool that is on.
- checkTools is true until the server ran its one tool check. The server owns it.
- shellOff turns off the built-in Shell, the empty tool ID. defaultTool cannot be empty
  while shellOff is true. `session-config` and `session-continue` reject Shell that is
  off as a new choice.
- type is `codex`, `claude`, `agy`, or `code-puppy` for a built-in tool, and `custom`
  for each other tool. A save with an empty type for another tool saves `custom`. model
  and effort of a built-in tool are the defaults of new drafts. An empty value selects the default of the CLI. See
  [Tool types and models](SPEC.md#tool-types-and-models) for the options that each type
  adds and for the accepted names.
- A startup command is one shell line of at most 1,000 bytes, without control
  characters. The server submits it once after the PTY opens. It records the command as
  input, separate from the composer draft.
- Settings include `appearance` with a value of `system`, `light`, or `dark`. A save
  with an empty or omitted value uses `system`.
- updateCheck turns the daily [release check](SPEC.md#release-check) on or off.
- port is the loopback port of the next server start, from 1024 to 65535. Port 0
  selects the automatic port. A save of a new port fails when another program holds it
  at `127.0.0.1` or `::1`. A save also fails for a bad port of the Fetch Standard, such
  as 6000. A saved port does not move the running server.
- remoteOn is the switch of [remote access](SPEC.md#remote-access), and remoteHost and
  remoteLogin are its two values. Remote access is on only while remoteOn is true and
  both values are set. The server does not change remoteOn when a save changes a value.
- remoteHost is a DNS name with at least two labels and an optional port, and the
  server saves it in lower case. remoteLogin has at most 254 printable ASCII characters,
  without spaces. A save with another value fails. A save that changes remoteOn or
  either value closes the open connections of remote requests before its reply. Only
  the connection of the save stays open for its reply. See [Remote host](#remote-host).
- prompts is the list of [saved prompts](SPEC.md#saved-prompts), in the order of the ＋
  menu of the message editor. Each prompt has `id`, `name`, and `text`. The client
  gives a new prompt its ID. A save replaces the whole list, and a save without the
  field removes all prompts. The server removes the spaces around each name. It rejects
  a list that breaks the [limits](SPEC.md#limits-of-saved-prompts) and saves nothing.
- Saving requires the current revision. Removing a default tool requires selecting
  another default in the same save.
- These operations do not install or authenticate tools.

### Model lists

`tool-models` runs the list command with the [program](SPEC.md#tool-program) of the
type. It returns an object with these fields:

| Field | Value |
| --- | --- |
| `type` | The tool type of the request. |
| `source` | The command that printed the list, or empty for the built-in list of `claude`. |
| `models` | The choices. Each has `id`, `name`, `efforts`, and an optional `default` effort. |
| `efforts` | The efforts that the CLI accepts with any model. It is empty for `agy` and `code-puppy`. |
| `loaded` | The time of the list command in RFC 3339 format, or empty for a built-in list. |

The server runs the list command once and keeps the list until a request with `refresh`,
a change of the program, or a server restart. A failed command returns an error and keeps no list. A disconnect
stops a running command. `custom` and an empty type return an error. For `agy`, a
model ID is the ID without its effort, such as `gemini-4-neon`. The launch adds the
effort to the ID.

### Usage limits

`tool-usage` runs the [usage check](SPEC.md#checks-of-each-cli) of a type with the
[program](SPEC.md#tool-program) of its built-in tool. The built-in tool must be on. The
reply has these fields:

| Field | Value |
| --- | --- |
| `type` | The tool type of the request. |
| `plan` | The plan of the account, such as `plus`. It is absent when the CLI does not tell it. |
| `groups` | The model groups. Each has an optional `name` and `windows`. A group without a name has all models. The list is empty without a report. |
| `checked` | The time of the report in RFC 3339 format. It is absent without a report. |
| `error` | The error of the last check. With a report, the report is from an earlier check. |

Each window has these fields:

| Field | Value |
| --- | --- |
| `label` | The length of the limit, such as `5-hour` or `Weekly`. |
| `model` | The model of a limit for one model, such as `Fable`. It is absent for a limit of all models. |
| `used` | The used part in percent, from 0 to 100, with at most one decimal. |
| `resets` | The reset time in RFC 3339 format. It is absent when the CLI does not tell it. |

A request without `refresh` gets the last check when it is less than 1 minute old. A
failed check is a `result` with `error`, not an `error` message. An `error` message
rejects a type without a check, a built-in tool that is off, and a request that cannot
read the settings. A disconnect stops a running check. See [Cache of the
server](SPEC.md#cache-of-the-server).

### Title tool change

`title-tool-set` changes the title tool with these rules:

- For a tool other than `none`, it first runs the same test as `title-test`. A failed
  test saves nothing. Its error tells that the tool is not configured and names the
  tool that is saved after the test.
- A passed test saves only when the title tool and the custom command are the same as
  at the start of the test. Otherwise another change saved during the test, and the
  request fails without a change.
- `none` saves without a test, with an empty `title`. An empty `titleTool` is an error.
- Only `claude`, `codex`, and `code-puppy` take `titleModel` and `titleEffort`. An
  empty value adds no option. `code-puppy` takes no effort. The test runs with them, and
  they save with the choice. The save applies only while the saved tool, command, model,
  and effort are the same as at the start of the test.
- Only `custom` takes `titleCommand`. It needs one, and the command saves with the
  choice.
- A disconnect during the test stops it and saves nothing.

### Preparation

A prepared session includes preparation with revision, state, toolId, toolName,
toolType, command, model, effort, worktree, base, and branch. Configuration saves send
the current preparation revision with toolId, model, effort, worktree, base, and branch,
plus name for the session title. Project, workspace, toolName, toolType, command, and
state are not writable configuration fields. A change to toolId copies the name, type,
and command of the selected tool from Settings. The save takes model and effort from the
request, also for a new toolId, so the client sends the defaults of a newly selected
tool. An omitted model or effort is empty. The server rejects a model or an effort that
the type does not accept. Start adds their options to the command.

An empty ID selects Shell and clears the command. Keeping the same tool preserves the
existing snapshot, including a removed preset. Start uses that snapshot without
resolving the preset again. Message drafts and attachments use the same session ID
before and after launch.

### Preparation states

Preparation states are draft, creating, launched, and interrupted. Only draft accepts
configuration changes or Start. Stale starts fail before effects. A failed preflight
returns to draft only when no checkout could have been created. An uncertain launch
remains interrupted after restart and must not be automatically retried.

After a lost start response, query session-config or session-list. Use session-resume to
join its process or read history. Never repeat startup input.

### Managed worktrees

Managed worktree metadata includes path, repository, requested base, resolved commit,
creation branch, and state (creating, ready, failed, or removed). Creation uses the
server's Git and never copies uncommitted files. It fetches a remote-tracking base
before it resolves the commit. If the server uses the local tracking ref because the
fetch failed or no fetch refspec maps to it, the `session` message has a `notice`. The
notice gives the reason and the commit of the worktree record. Removal rejects active
bbflow workspaces and modified, untracked, or ignored files. It keeps the branch. See
[SPEC.md](SPEC.md#session-preparation-settings-and-worktrees) for supported
repositories.

## New terminals in ended sessions

`session-continue` starts a new terminal in an ended session. Before the process
starts, the server writes a handoff folder with the earlier terminals and messages.

### session-continue

`session-continue` starts a new run in an ended session. The session keeps its ID,
workspace, worktree, message draft, and history. Send the ID of the latest run from
session-config as `latestRun`. The server holds the launch lock and rejects the request
when a terminal is live, when `latestRun` is not the latest run, or when that run has
not ended. It also rejects archived sessions, sessions without a run, a managed worktree
that is not `ready`, a missing workspace, and an unknown tool.

`model` and `effort` are the choices of the new terminal. An empty value selects the
default of the CLI, as in the `preparation` of a draft. The server checks them with the
rules of a draft. It rejects a model or an effort for Shell and for a Custom tool. The
web UI sends the defaults of the selected tool, unless the user changes them.

A rejected request writes no files and starts no process. A repeated request with the
same `latestRun` fails after the first request started a terminal. After a lost
response, read session-config. If its latest run changed, use session-resume to join
the new terminal. Do not send session-continue again only because a response was lost.

The server records and submits the `command` of the selected tool once, with the
options of the model and the effort. Shell submits nothing. The client shows the handoff
prompt for the user to send. The start event of the new run records `tool`, `toolId`
(the empty ID for Shell), `continues` (the previous run ID), and `handoff` (the
folder).

### Handoff folder

Before the process starts, the server rebuilds `<instance>/handoff/<session-id>/` from
SQLite. It contains `README.md`, `messages.md`, and `terminals/<number>-<run-id>.txt`
for each earlier terminal with output. `session-handoff` returns this folder and the
prompt that points to it, without side effects. Its `available` field is true when the
folder has its `README.md`. Clients use it to show the prompt again after the new
terminal started.

### session-terminals

`session-terminals` lists every run of a session as one terminal. `number` counts from 1
in start order. `tool` comes from the start event of the run. Start events from bbflow
0.0.4 and earlier have no tool, so the first run uses the tool of the preparation. A new
terminal has no run record until its process starts. Until then, the list ends with a
`starting` terminal that has an empty `run`. The operation starts no process and writes
no files.

`toolId` is the tool ID from the start event, and the empty ID for Shell. Start events
from bbflow 0.0.23 and earlier have no tool ID. The first run then has the tool ID of
the preparation. A later run has no `toolId`, because its tool is unknown.

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

### Open, resume, and stop

`side-terminal-open` needs a session that started a terminal. It rejects drafts,
archived sessions, and a missing workspace. The server holds the launch lock, so two
views that open at the same time join one shell. A lost view rejoins with
`side-terminal-resume` and the `shell` ID that it showed. Do not send
`side-terminal-open` again only because a connection was lost. It can start a new shell
when the earlier shell ended. Send the `shell` ID with `side-terminal-stop` too. Then a
view of an ended shell cannot join or stop a shell that another view started later.

### End of the shell

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
| `running` | A live terminal had application output in the last 10 seconds. Worktree creation and process start also show as `running`. |
| `idle` | A live terminal had no application output in the last 10 seconds. |
| `ended` | No terminal is live. The latest run `exited`, `stopped`, `failed`, or was `interrupted`, or the launch made no process. |

### Derivation

The server derives `running` and `idle` from the times of application output only. It
keeps the times in memory and tracks them without views. Application output changes
what a view shows: a cell of the screen, or the rows in history. A cursor move, a
title, or a bell alone is not application output. See
[activity detection](SPEC.md#activity-detection). Output in the 300 milliseconds after
an `input`, a `resize` that changes the PTY size, or a `signal` is not application
output. This excludes the echo of typed input and the redraw after a size change. A
`resize` to the current PTY size has no such effect, because the application does not
redraw.

`idle` means only that there was no recent application output. The application can be
complete, can wait for an answer, or can work without a change on the screen. `idle` does not show that the
application is ready for input. Do not send input automatically because of this status.

A live view also gets the status in `status` messages on its
[terminal stream](#terminal-streams). The `status` of `session-terminals` entries, of
an ended `session` message, and of an `exit` message is the stored run status, not this
session status.

### status-watch

- `status-watch` keeps one stream open for all sessions. The server first sends a
  `statuses` message.
- Its `statuses` object maps the ID of each session that has a live terminal to
  `running` or `idle`. The server omits the object when no terminal is live.
- The server reads the statuses from memory five times each second. It sends the
  complete object again after each change.
- Its `revision` counts the session title changes since the server started. The server
  also sends the message after each title change. Then a client reads `session-list`
  again.
- A session is absent before its terminal starts and after its terminal ends. Read
  `session-list` for those sessions.
- The client sends `ping` at least every 30 seconds and gets `pong`. Closing the stream
  only removes the watch.

### Release check state

Each `statuses` message has a `release` object with the state of the
[release check](SPEC.md#release-check). The server sends the message again when the
state changes.

| Field | Meaning |
| --- | --- |
| `version` | The version of the running server. |
| `canUpdate` | True when the build can check and update. A development build, another platform, and a renamed executable omit it. They omit the other fields too. |
| `checking` | True while a check runs. `update-check` sets it before its reply. |
| `checks` | The number of checks that ended since the server started. Two checks can end in the same second with the same result. Compare `checks` to tell them apart. |
| `checked` | The end time of the last check, in RFC 3339 format. It is absent before the first check. A check that ends during an update applies only if the update fails. |
| `error` | The reason that the last check failed. A successful check removes it. |
| `offer` | The newer release that the last successful check found. It is absent when the server runs the newest release. A failed check keeps it. |
| `failed` | Why the last update failed: `available`, the release of that update, and `error`, the reason. A check that changes or removes the offer keeps it. The next `update-start` removes it. |

The `offer` object has these fields:

| Field | Meaning |
| --- | --- |
| `revision` | Identifies the offer. A check that finds another release or another action gives a new revision. Send it with `update-start`. |
| `version` | The version of the running server. |
| `available` | The newer release. Send it as `version` with `update-start`. |
| `installed` | True when the executable already has the release. The update then only restarts the server. |
| `state` | `available`, or `updating` while the server installs the release and restarts. |

The daily check setting does not hide the offer. After the restart, open views reload
with the UI of the new server.

The executable can change after the check, so that it no longer agrees with the
confirmed offer. Then `update-start` changes nothing, and `failed` gives the reason. The
server checks again at once and sends the new offer with a new revision. Ask the user
again before you send `update-start` for it. A confirmation of the earlier revision,
for example from another view, fails.

## Terminal streams

A terminal stream carries the display of one terminal to one view, and the input of
that view to the terminal. The server renders frames, and the client acknowledges each
frame. All views of a session are equal.

### Start of a stream

After a session request, the server sends `session` with its ID and `active: true` for a
live process. Ended replies instead include the `status` of the shown run. Multiple
views share one process and emulator. Every view can send `input` and `signal`. There is
no controller role.

After `session`, a live view gets a `status` message with the
[session status](#session-status), `running` or `idle`. The server sends the message
again after each change. An ended session sends `exit` and no `status` message.

### Size owner

The PTY uses the viewport size of one view, the size owner. A view becomes the size
owner when it joins and no view owns the size. A view also becomes the size owner when
it sends `input` that is not a report, or when it sends `resize` and no view owns the
size. Before the server writes input from a new size owner, it resizes the PTY to the
size of that view. `signal` does not change the size owner.

A report is `input` with `report: true` that holds only focus reports or mouse reports,
while a frame of the view has that mode on. A client sets `report` only for a report
that its terminal made, not for a paste or a message with the same bytes. The server
writes a report to the PTY, but the size owner does not change. The server can change
the position of a mouse report to the terminal cell that the view shows, and it does
not write each mouse report outside the terminal. The record of a report has the bytes
that the PTY gets. Input without `report`, and marked input that is not a report, is
written and recorded with no change. See
[reports of a view](SPEC.md#reports-of-a-view) for the rules.

An input receipt always goes to the view that sent the input. Closing the socket removes
that view. The PTY keeps its size until another view becomes the size owner. No process
is stopped. Any view may use the separate `session-stop` operation to end work for
everyone.

### Stream messages

| Direction | Type | Contents and effect |
| --- | --- | --- |
| Client → server | `input` | Base64 `data`, recorded before PTY delivery. An optional `id` requests a receipt. An optional `report: true` marks a focus report or a mouse report of the view. |
| Client → server | `resize` | This view's `size`. Only the size owner also resizes the PTY. |
| Client → server | `signal` | Numeric `signal`. The server accepts only SIGINT. |
| Client → server | `frame-ack` | `revision` of the frame that finished rendering |
| Client → server | `ping` | Keep the attachment alive |
| Server → client | `pong` | Reply to `ping` |
| Server → client | `frame` | Base64 rendered ANSI in `data`, `size`, `revision`, and optional `full` |
| Server → client | `status` | The session `status` of a live process: `running` or `idle` |
| Server → client | `input-ack` | Matching `id`. An optional `error` indicates uncertain delivery. A message editor send uses the `id` `draft-REVISION`, with its pending draft revision. A receipt without `error` for such an `id` can start the [automatic title](SPEC.md#session-titles), when the accepted bytes are exactly the editor input for that revision. |
| Server → client | `exit` | Exit `code`, the recorded run `status` (`exited`, `stopped`, or `failed`), the `run` ID, and optional `error`. `status` and `run` are absent when the terminal failed before its run started. Each view gets the same message. Follows the final frame acknowledgment. A session view whose last frame had another size than the terminal first gets the saved screen as one full `frame`. |
| Server → client | `history-end` | End of a read-only ended-session view |
| Server → client | `error` | Error description in `error` |

### Emulator and frames

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

The first frame is always full. It contains the normal-buffer scrollback rows that the
view keeps and the current visible screen, including an active alternate screen. The row
limit depends on the frame width. See [terminal
scrollback](SPEC.md#terminal-scrollback). A full frame has rendered cell styles, cursor
position and supported input modes. Before parsing a full frame, clients reset their
view, set the row limit of the frame width, and apply the frame's dimensions. Later
frames contain only changed rows, scrollback additions, the input modes that changed,
and the cursor position.

A resize, history clear, incompatible baseline, or update larger than the frame limit
produces another full frame. The display uses positioned rows. It does not reproduce
application scroll regions, source escape sequences, hyperlinks, clipboard requests, or
native process state.

### Acknowledgments and timeouts

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
failures with delays from 0.5 to 5 seconds. A stalled transport may be closed, but its
process and capture continue.

### Reconnection

- A protocol or identity mismatch requires explicit recovery. The browser reconnects to
  its original verified instance.
- A complete greeting with the same `dataDir` and `port` and a different `instance`
  shows a replacement server. Then the browser page reloads to load the new UI, unless
  it has unsaved edits.
- The `dataDir` is a claim of the server. It does not authenticate the program that
  owns the port.
- If the server port changes, reopen the UI.
- During shutdown, the server allows connections up to five seconds to receive
  completion. Then it closes them.

### Ended sessions

- Ended sessions send one full frame of their latest run, wait for its acknowledgment,
  then send `history-end`.
- A request with `run` gets the same reply for that run, even while a later run is live.
  Its `session` message has the `status` of that run. The view never joins the live
  process.
- Without `run`, or with the ID of the live run, the view joins the live process.
- A `run` of another session or an unknown run fails before any frame.
- Normal completion stores a derived final view in a versioned `terminal-screen` SQLite
  event. Without that cache, the server emulates the original recording in bounded
  pages.
- Opening history never starts a process or sends recorded input.
- The frame has the recorded dimensions and styles. For the display in the browser, see
  [Display of an ended session](SPEC.md#display-of-an-ended-session).

### Input receipts

An input `id` is an opaque correlation value up to 80 bytes. A receipt without an error
means the input was recorded and written to the PTY. It does not mean the application
accepted or completed a message. The server does not write each mouse
[report](#size-owner) to the PTY. For such a report, a receipt without an error means
that the server completed the input.

A failure, missing receipt, or closed connection leaves delivery uncertain. IDs do not
prevent duplicate input. Never resend input automatically. Reconnect uses
`session-resume` for a known ID and never repeats `session-start`.

## Drafts and file references

The message editor saves one draft for each session. `composer-draft` reads and saves
it. `composer-watch` pushes it to each view. `composer-attach` stores a file, and
`composer-sent` lists the sent messages. No operation in this section sends terminal
input.

### composer-draft

`composer-draft` returns `{"draft": {...}, "attachments": [...]}`. A draft contains
`revision` (event sequence, initially zero), `text`, `attachments` (attachment IDs), and
`pending` (possible input delivery). To save, send the whole draft with the revision
that the view last loaded or saved. A save returns its new revision. Omit the entire
`draft` field to load the latest saved state.

The latest save wins, even when its revision is older than the current revision. Earlier
revisions stay in the archive. One exception keeps sends safe. The server does not store
a save from an older revision when that revision or a later one is pending. The reply
then contains the latest draft and `rejected: true`. A negative revision or a revision
above the current revision fails with an error.

### composer-watch

`composer-watch` keeps one stream open for one session. The server first sends a `draft`
message with `session` and the latest state in `composer`. It then sends a `draft`
message after each newer save. A slow view can skip intermediate revisions. It never
receives an older revision after a newer one. The client sends `ping` at least every 30
seconds and gets `pong`. Closing the stream only removes the watch.

### Limits and attachments

Draft text is limited to 64 KiB of UTF-8 and at most 8 distinct attachments from that
session. Each attachment contains `id`, `name`, `mediaType`, `size`, and `path`. Uploads
have a 4 MiB limit. Names must be single basenames without control characters.

The path points to a private copy in the selected instance's attachment cache. SQLite
stores original file bytes and metadata. Draft reads regenerate cache files. Uploads do
not add themselves to a draft.

Add the returned ID with `composer-draft`. Neither operation sends terminal input.
Uploads are not automatically retried, and unused uploads remain in the archive.

### Pending drafts

The browser saves `pending: true` before sending input and clears the draft only after a
successful receipt. A retained pending draft requires explicit user review before reuse.
Plain draft text and uploaded files are never replayed as input by the server. Clients
compose local file references and paste delimiters. The server preserves the submitted
input bytes. It does not implement a provider message or image protocol.

### composer-sent

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

The server has two checks. Each HTTP request, including a WebSocket upgrade, must be a
local request, or it must pass the checks of the [remote host](#remote-host) while
remote access is on. A local WebSocket upgrade that has an Origin header must also have
the same host and port in that header. A local upgrade without an Origin header passes,
and the other HTTP routes have no origin check. These checks stop other web sites. They
do not authenticate local programs.

### Host and Origin

A request is local only when both of these conditions are true:

- Its HTTP Host is `127.0.0.1:PORT` or `localhost:PORT`.
- It has none of the headers of a reverse proxy: `Forwarded`, `X-Forwarded-For`,
  `X-Forwarded-Host`, `X-Forwarded-Proto`, `Tailscale-User-Login`, and
  `Tailscale-Funnel-Request`.

Each other request must pass the checks of the [remote host](#remote-host). This rule
applies to each HTTP route and to the WebSocket upgrade. A reverse proxy keeps the Host
that its client sent, and a client can send a loopback Host. Thus the Host alone does
not make a request local.

Only the WebSocket upgrade checks the Origin header. For a local upgrade, an Origin
header, if present, must have the same host and port as the Host. CLI clients omit
Origin. Browser clients send it automatically. Thus the server rejects WebSocket
connections from other sites, different ports, and opaque origins such as `file:` pages.

The embedded UI is served from the same local origin at `/`. Separate UI development
servers would need an explicit origin policy change or a same-origin proxy. There is no
authentication token or TLS. Host and origin checks do not authenticate local programs.

### Remote host

[Remote access](SPEC.md#remote-access) admits the requests that a reverse proxy on the
computer of the server forwards to the loopback port. The supported proxy is Tailscale
Serve. The server answers a request that is not [local](#host-and-origin) only when all
of these conditions are true:

- The Host is exactly `remoteHost`, with the same port or no port.
- `remoteOn` is true.
- The request has exactly one `Tailscale-User-Login` header. Its value is `remoteLogin`,
  compared without letter case. An empty `remoteLogin` admits no request.

Each other request gets status 403. The body is `invalid host`, `remote access is off`,
or `remote access needs the Tailscale login of Settings`. It names the first check of
the list that failed. A remote WebSocket upgrade also needs exactly one
Origin header with the value `https://` and the Host of the same request. An HTTP origin of the same
host, another port, and a missing Origin get status 403.

- The proxy must keep the Host of the browser request, as Tailscale Serve does.
- The proxy must set `X-Forwarded-Host` or another header of the local request rule on
  each request, after it removes these headers of the client. Tailscale Serve does. A
  proxy without this rule lets each client send a loopback Host and pass as local. A
  TCP forwarder, such as `tailscale serve --tcp`, is such a proxy. It must never forward
  to the port of the server.
- The proxy must remove each `Tailscale-User-Login` header of the client and set its
  own, as Tailscale Serve does. A proxy without this rule lets each client name a login.
- A browser client on an HTTPS page connects to `wss://HOST/ws`. On an HTTP page, it
  connects to `ws://HOST/ws`. A remote page must be an HTTPS page.
- The `connect-src` of the content security policy names only `wss://HOST` for a remote
  page. For a local page, it names the two loopback addresses.
- The greeting and `GET /client-config` are the same as for a local request. They name
  the loopback port of the server, not the remote host.
- A change of `remoteOn`, `remoteHost`, or `remoteLogin` is in effect before the reply
  of its `settings-save`. It closes each open connection of a remote request. The
  connection of the save itself closes after its reply.
- The server applies the saved values in the order of the settings revisions. A save
  with an earlier revision does not replace the values of a later one.

### Example client

A browser client on the matching local origin can use the standard API:

```js
const socket = new WebSocket(`ws://${location.host}/ws`);
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.type === "server") {
    if (message.server.protocol !== "bbflow/46") {
      socket.close();
      throw new Error("Unsupported bbflow protocol");
    }
    socket.send(JSON.stringify({
      type: "request",
      request: { protocol: "bbflow/46", operation: "session-list", groups: [""], limit: 10 }
    }));
  } else {
    console.log(message);
  }
};
```

A UI served by that instance uses its own local origin. A client connecting to an
endpoint discovered elsewhere must also verify the expected instance identity.

### Client configuration

The embedded UI reads `GET /client-config` for the current `ServerInfo`, then checks
protocol, directory, instance ID, and port against each WebSocket greeting before
sending a request. It requires reload when the server identity changes. This endpoint
only supplies browser connection information. Every session and history operation still
uses the shared WebSocket protocol. Static assets are under `/assets/`.

### HTTP responses

All HTTP routes enforce the Host check. Responses disable caching, MIME
sniffing, embedding in frames, and external script loading. The UI uses text nodes for
metadata and notices.

### Display rules for a client

Decode frame data from base64 before passing it to the display. The server answers
source terminal queries. A client must not create replies from old recordings. The
browser's terminal and optional composer share the same input stream.

## Protocol versions

Database compatibility is separate from the WebSocket protocol version. After a protocol
change, rebuild the executable, start the new server, and reload the browser.

The list starts at protocol 15. This file does not record the changes of the earlier
versions.

- Protocol 15 supports multiple drafts per project, archive/restore, and paginated
  collection search. Project records no longer contain a draftId. Session records and
  summaries include an archived boolean. SQLite format 6 stores this independent flag.
  Server startup applies the embedded migrations for supported formats.
- Protocol 16 removes the controller role and the `control` and `take-control` messages.
  Every view can send input. It adds `composer-watch` and the latest-save rule for
  drafts. The SQLite format does not change.
- Protocol 17 adds the read-only `composer-sent` operation. It lists the messages that
  the message editor sent. The SQLite format does not change.
- Protocol 18 adds `session-handoff` and `session-continue`. A session can have several
  runs, one after another. Each run has its own terminal.
- Protocol 19 adds `session-terminals` and the optional `run` field of `session-resume`.
  A view can show an earlier terminal of a session. The SQLite format does not change.
- Protocol 20 adds `history-search` and `history-context`. See
  [Recorded-output search](#recorded-output-search). SQLite format 7 adds three event
  indexes for these reads. The two operations are read-only.
- Protocol 21 adds `workspace-changes`, `workspace-files`, and `workspace-file`. See
  [Workspace changes](#workspace-changes). The SQLite format does not change.
- Protocol 22 adds the derived `status` of a session. See
  [Session status](#session-status). The SQLite format does not change.
- Protocol 23 adds `workspace-folders`, and `workspace-file` also works without Git. See
  [Workspace changes](#workspace-changes). The SQLite format does not change.
- Protocol 24 adds `side-terminal-open`, `side-terminal-resume`, and
  `side-terminal-stop` for [side terminals](#side-terminals). The SQLite format does not
  change.
- Protocol 25 removes `continueCommand` from tools. SQLite format 9 removes this field
  from saved tools.
- Protocol 26 changes `session-list`. A request names its `groups`, `limit` applies to
  each group, and `session` can include one more session. The reply has `sessions` and
  `more`. See [Session list](#session-list). The SQLite format does not change.
- Protocol 27 adds automatic session titles. Session records and summaries add
  `autoTitle`, and `title` holds only the user title. Settings add `titleTool`. The
  operations `title-tools` and `title-test` are new. A `statuses` message adds
  `revision`. SQLite format 10 adds the `auto_title` column and `titleTool: "none"`.
- Protocol 28 adds the `commit` baseline of the [workspace change
  operations](#workspace-changes). The SQLite format does not change.
- Protocol 29 adds `storage-report`. See [storage report](SPEC.md#storage-report). The
  SQLite format does not change.
- Protocol 30 adds `update-start`, the `version` request field, and the `update` field
  of `statuses` messages for [release offers](#release-check-state). Settings add
  `updateCheck`. SQLite format 12 adds `updateCheck: true`.
- Protocol 31 adds session families. `project-draft` accepts `parent`. Session summaries
  add `parentId`, `context`, and `runStatus`. `session-list` limits and offsets count
  families. `session-archive` archives and restores families. SQLite format 13 adds the
  `sessions.parent_id` column.
- Protocol 32 adds `port` to settings. `settings-save` rejects a new port that another
  program holds. SQLite format 14 adds `port: 0`.
- Protocol 33 changes the [workspace change operations](#workspace-changes). The `base`
  field of `workspace-changes` is an object instead of a boolean. Sessions without a
  managed worktree can have a base, the merge base with the default branch. Requests add
  `to`, so that a `commit` baseline can end at a commit. Commits add `files`. The commit
  list no longer omits the first commit after the base. The SQLite format does not
  change.
- Protocol 34 adds the `image` side state to `workspace-file`. An image side has
  `mediaType` and `data`, and it holds at most 5 MiB. The SQLite format does not change.
- Protocol 35 adds `workspace-open` to the [workspace operations](#workspace-changes).
  The SQLite format does not change.
- Protocol 36 adds `title-tool-set`. A title tool saves only after it passes a title
  test. The `custom` title tool runs the new `titleCommand` of the settings.
  `settings-save` keeps the saved `titleTool` and `titleCommand`. The server owns the
  sample message of a test. `title-tools` returns an object with `tools` and `sample`,
  not a list. `title-test` no longer reads `text`. SQLite format 15 adds
  `titleCommand: ""`.
- Protocol 37 adds `workspace-reveal` to the [workspace operations](#workspace-changes).
  The SQLite format does not change.
- Protocol 38 adds `remoteHost` and `remoteLogin` to settings, and the
  [remote host](#remote-host) checks of browser access. No operation is new. SQLite
  format 16 adds `remoteHost: ""` and `remoteLogin: ""`.
- Protocol 39 adds the optional `report` field of `input`. A view marks its focus
  reports and mouse reports with it. See [size owner](#size-owner). The SQLite format
  does not change.
- Protocol 40 adds `type`, `model`, `effort`, `builtin`, `enabled`, and `path` to each
  tool of the settings, `checkTools` and `shellOff` to the settings, and `toolType`,
  `model`, and `effort` to the preparation. `session-config` reads `model` and `effort`,
  and it rejects a new tool that is off. The operations `tool-models` and `tool-check` are new. Settings gain
  `titleModel` and `titleEffort`, which `title-test` and `title-tool-set` read.
  `title-tools` adds `type`, `prefix`, `suffix`, `model`, and `effort`. SQLite format 17
  gives each tool the type of its command, an empty model and effort, and the built-in
  tools.
- Protocol 41 adds `remoteOn`, the switch of remote access, to settings. A save of
  `remoteHost` and `remoteLogin` no longer turns remote access on. A rejected
  [remote host](#remote-host) request for the saved host can get the body
  `remote access is off`. No operation is new. SQLite format 18 adds `remoteOn`, which
  is true only where both values were saved.
- Protocol 42 adds [`session-pin`](#session-pins), the `pinned` field of a session and
  of a session summary, and the `pinned` group of `session-list`. SQLite format 19 adds
  `sessions.pinned_at`. No session has a pin after the upgrade.
- Protocol 43 adds `prompts`, the [saved prompts](SPEC.md#saved-prompts), to settings.
  No operation is new. SQLite format 20 adds an empty list.
- Protocol 44 adds [`tool-usage`](#usage-limits), the usage limits of Codex, Claude
  Code, and Antigravity. The SQLite format does not change.
- Protocol 45 adds the optional `model` and `effort` fields of
  [`session-continue`](#session-continue) and the optional `toolId` of each terminal of
  [`session-terminals`](#session-terminals). The start event of each new run records
  `toolId`. The SQLite format does not change.
- Protocol 46 adds `update-check`. The `release` object of `statuses` messages replaces
  the `update` field and holds the offer in `offer`. The `failed` state and the `error`
  field of the offer move to `failed` in the release object. See
  [Release check state](#release-check-state). `update-start` no longer rejects an
  offer while the daily check setting is off. The SQLite format does not change.

## Source files

The Go message definitions are in `internal/protocol/protocol.go`. Their browser types
and transport are in `web/src/protocol.ts`. Server routing is in
`internal/server/server.go`.
