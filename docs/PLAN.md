# bbflow plans

This file lists planned work at a high level. [SPEC.md](SPEC.md) describes implemented
behavior, [GOAL.md](GOAL.md) describes the intent of the project, and
[AGENTS.md](../AGENTS.md#invariants-to-preserve) lists the invariants that every plan
must preserve.

Follow these rules when you change this file:

- Give the purpose, the scope, and the open decisions of each plan. Leave out
  implementation steps, detailed designs, and check lists, because the detailed
  research happens when the implementation starts.
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
sessions, including General. Today bbflow neither inserts context nor delivers it
automatically.

- Saved context lives in SQLite.
- The user sees the selected context and its scope before bbflow applies it.
- Context is delivered only through interfaces that the agent supports.
- The feature includes guidance for searches across sessions with `bbflow query`.

The scope and the interface are still open.

## Session forks

Status: future possibility. Let the user select a point in the middle of a session and
continue from that point in a new session, while the original session stays available
and can continue independently. For example, a user could fork after an early design
discussion to try another approach, without carrying the later implementation
discussion into the fork.

- The fork inherits history only up to the selected point. Later messages of the source
  session, and of other forks, never enter it.
- A fork changes no files. It neither restores old workspace files nor creates a
  worktree.
- A fork starts a new agent or uses a verified native agent capability. It never
  replays recorded input.

How the user selects the point is still open. Terminal events are chunks, so they do
not reliably identify message or turn boundaries.

## Cloud backup

Status: planned. Replicate the SQLite database of an instance to cloud storage, and let
the user recover that database on a new installation. A local export or backup-file
workflow is outside this plan.

- The backup holds the SQLite database, which contains all durable bbflow data.
  Workspace files, provider-managed credentials, running processes, logs, and caches
  are outside the backup.
- Cloud replication stays off until the user turns it on.
- Recording continues when cloud access fails.
- Recovery starts no agents and replays no recorded input.
- Development and production replicas stay separate.

The candidate is [Litestream](https://litestream.io/), or a similar SQLite replication
tool, running as a separate process. No tool has been selected or tested yet.

Still open: the replication tool, the cloud backend, credentials, retention, and which
process owns replication.
