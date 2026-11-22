# bbflow plans

This file lists planned work at a high level. [SPEC.md](SPEC.md) describes implemented
behavior. [GOAL.md](GOAL.md) describes the intent of the project.
[AGENTS.md](../AGENTS.md#invariants-to-preserve) lists the invariants that each plan
must preserve.

Obey these rules when you change this file:

- Give the purpose, the scope, and the open decisions of each plan. Do not add
  implementation steps, detailed designs, or check lists. Do the detailed research when
  the implementation starts.
- In each implementation commit, remove the completed items.
- For a partially completed item, describe only the remaining work.

## Overview

| Plan | Status |
| --- | --- |
| [Custom context](#custom-context) | Deferred |
| [Session forks](#session-forks) | Future possibility |
| [Cloud backup](#cloud-backup) | Planned |

## Custom context

Status: deferred. Let the user add, edit, and apply custom context to projects and
sessions, including General. Now bbflow does not insert context or deliver it
automatically.

- Keep saved context in SQLite.
- Show the selected context and its scope to the user before bbflow applies it.
- Deliver context only through interfaces that the agent supports.
- Include guidance for searches across sessions with `bbflow query`.

Open decisions: the scope and the interface.

## Session forks

Status: future possibility. Let the user select a point in the middle of a session and
continue from that point in a new session. The original session stays available and can
continue independently.

For example, fork after an earlier design discussion to try another approach. The fork
does not include the later implementation discussion.

- The fork inherits history only up to the selected point. Later messages of the source
  session and of other forks do not enter the fork.
- A fork changes no files. It does not restore old workspace files or create a worktree.
- A fork starts a new agent, or uses a verified native agent capability. It never
  replays recorded input.

Open decision: how the user selects the point. Terminal events are chunks. They do not
reliably identify message or turn boundaries.

## Cloud backup

Status: planned. Replicate the SQLite database of an instance to cloud storage. Let the
user recover that database on a new installation. A local export or backup-file
workflow is outside this plan.

- The backup holds the SQLite database, which has all durable bbflow data. Workspace
  files, provider-managed credentials, running processes, logs, and caches are outside
  the backup.
- Cloud replication stays off until the user turns it on.
- Recording continues when cloud access fails.
- Recovery starts no agents and replays no recorded input.
- Keep development and production replicas separate.

Candidate: [Litestream](https://litestream.io/), or a similar SQLite replication tool,
as a separate process. No tool is selected or tested yet.

Open decisions: the replication tool, the cloud backend, credentials, retention, and
the owner of the replication process.
