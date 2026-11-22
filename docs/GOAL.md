# bbflow — Project Goal

This file describes the intended product at a high level. Other documents own the
related facts:

- [SPEC.md](SPEC.md) describes the implemented behavior and its limits.
- [PLAN.md](PLAN.md) lists the planned work.
- [AGENTS.md](../AGENTS.md) gives the rules and invariants for contributors.

## Why this project exists

Daily work can require several agent command-line interface (CLI) tools. Some tools
support sessions and integrations. Others provide only a terminal interface with limited
history. Users must manually manage conversations, find earlier decisions, attach files,
create worktrees, and move work between tools.

Some tools cannot preserve or search earlier sessions. Others make these operations
difficult. Reliable session capture, review, and search are the main reasons to use
bbflow.

bbflow should provide session management and message composition for the CLI agents that
users already use. Codex Desktop, Claude Desktop, and Cursor Desktop provide examples of
this experience.

## Goal

Build a desktop workspace where conversations, history, and working context remain
available across different agent CLI tools.

A user should be able to start work with one agent and continue with another. The new
agent should have access to the earlier conversation. Users should also be able to
import conversations from other applications into bbflow.

## Audience

Build first for individual daily use on macOS. Shared history and multi-user
collaboration are outside the initial release. Support for other operating systems can
be considered later.

## What the user should be able to do

1. **Manage conversations.** View, select, and organize sessions under saved projects.
   Preserve history even when a CLI does not store it. Start sessions from a project
   without another folder selection. Keep a built-in General project for work and
   history searches across projects.
2. **Compose comfortably.** Edit multiline prompts, copy and paste, attach files, paste
   images, and retain drafts while switching conversations.
3. **Switch agents manually.** The user chooses when to switch and which CLI to use
   next, including after a quota limit. bbflow prepares access to the history needed for
   continuation. It does not automatically choose or switch agents.
4. **Fork conversations.** Explore a different direction from an earlier point while
   retaining access to the history inherited by that fork.
5. **Use worktrees.** Create separate working directories for independent coding tasks,
   regardless of whether the CLI supports worktrees itself.
6. **Find and reuse earlier work.** Search conversations, retrieve original messages,
   and retain useful decisions and memory across sessions and agents.
7. **Import existing history.** Import conversations from Cursor Desktop, Codex Desktop,
   and Claude Desktop into the same searchable library. Continue or fork them with a
   supported CLI.
8. **Back up and restore data easily.** Preserve bbflow's SQLite data in cloud storage.
   Recover it on a replacement installation without the original CLI's history service.

SPEC.md states which of these capabilities work now.

## Example workflow

The everyday workflow starts with a new or reopened session. The user works with an
agent. Later, the user finds the conversation or an earlier decision through bbflow.
This must work even when the CLI has limited session history.

This example also uses import, continuation, and a fork:

1. Import a conversation from Cursor or Codex Desktop.
2. Open it in bbflow and select a workspace.
3. Continue with the local Codex CLI.
4. Retrieve an earlier decision from the bbflow history when more detail is necessary.
5. Select another agent CLI after a quota limit, or when a different tool is more
   useful.
6. Fork the conversation into a new worktree to try another approach.

The conversation and its ancestry remain accessible throughout this workflow.

## Principles

AGENTS.md has the detailed [invariants](../AGENTS.md#invariants-to-preserve) behind
these principles.

- **bbflow owns the recorded history.** The identity and availability of a conversation
  do not depend on a CLI or its native session format. The original terminal input and
  output are the evidence. Readable text and summaries are derived from it.
- **The server owns the work.** A background server owns each terminal process and its
  history. A view can close and open again while the work and the recording continue.
  Only an explicit stop ends a session.
- **Use ordinary terminal access.** Run each agent through its normal interactive CLI.
  Preserve its arguments, authentication, and approval prompts. Do not depend on an
  SDK, structured output, or a native session API. Richer integrations can come later.
- **Continue with a history reference.** A new agent gets a reference to the recorded
  history and instructions to read it. Continuation must not need a summary from the
  earlier agent, whose quota can be exhausted. Evaluate this approach before you add
  summaries.
- **State what continues.** Attachment to a live process, native CLI resume, and a new
  agent with history access are three different operations. A recording cannot restore
  hidden model state. Never replay recorded input to resume work.
- **Preserve history boundaries.** A fork inherits history up to its selected point.
  Later parent messages and sibling branches appear only through explicitly broader
  searches.
- **Keep file state explicit.** Conversation forks and workspace snapshots are separate
  concepts. Old transcripts alone cannot reconstruct historical files.
- **Show context coverage.** Preserve all captured or imported data. Identify missing
  attachments, unsupported data, and summaries.
- **Preserve imported originals.** Import by copying and retain provenance. Repeated
  imports must not create duplicates or silently change history that a fork inherits.
- **Keep data local and scope explicit.** Keep all durable bbflow data in one local
  SQLite database. Cloud replication needs a selection by the user. Each history read
  has an explicit scope.
- **Keep durable data safe.** Upgrades preserve existing history, settings, and drafts.
  Backup and recovery preserve stable identities and history boundaries.
- **Keep bbflow small.** Keep the CLI small and the web client thin. Keep the release
  binary self-contained.

## Later interface goals

- **Chat interface.** Show the prompts sent through bbflow alongside the terminal
  output. Keep a terminal view available for interactive prompts. Do not present
  inferred message boundaries as exact.
- **Desktop shell and global shortcut.** After the web workflow is useful, provide one
  global shortcut that opens the bbflow UI or moves it to the foreground.

## What success looks like

- The user can use bbflow for daily agent work and find decisions from earlier
  sessions.
- Each tested agent CLI leaves available, searchable sessions after a run ends. This
  does not depend on the history management of the CLI.
- The user can change tools without manual context reconstruction. A new CLI agent can
  retrieve an earlier decision from the bbflow history.
- Imported conversations are immediately available for search, agent references, and
  continuation in a new session.

## Open decisions

- Native CLI session mapping and resume after a process ends.
- Import source formats and refresh behavior. Codex is the first import target.
- Memory across sessions and agents.
- Summaries for continuation. Decide after you evaluate continuation with history
  references.
- The desktop framework and the key binding of the global shortcut.
- Cloud backup. See [PLAN.md](PLAN.md#cloud-backup).
