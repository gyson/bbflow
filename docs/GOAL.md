# bbflow — Project Goal

This file describes, at a high level, the product that bbflow is meant to become. Three
other documents own the related facts: [SPEC.md](SPEC.md) describes what is implemented
and where its limits are, [PLAN.md](PLAN.md) lists the planned work, and
[AGENTS.md](../AGENTS.md) gives the rules and invariants for contributors.

## Why this project exists

Daily work often needs several agent command-line interface (CLI) tools. Some of them
support sessions and integrations, while others offer only a terminal interface with
limited history. That leaves the user to manage conversations by hand: finding earlier
decisions, attaching files, creating worktrees, and moving work from one tool to
another.

Some tools cannot preserve or search earlier sessions at all, and others make it
difficult. Reliable capture, review, and search of sessions are therefore the main
reasons to use bbflow.

bbflow should give the CLI agents that people already use the kind of session
management and message composition that Codex Desktop, Claude Desktop, and Cursor
Desktop provide.

## Goal

Build a desktop workspace where conversations, history, and working context stay
available across different agent CLI tools.

A user should be able to start work with one agent and continue with another, and the
new agent should have access to the earlier conversation. Users should also be able to
import conversations from other applications into bbflow.

## Audience

Build first for one person's daily use on macOS. Shared history and multi-user
collaboration are outside the initial release, and support for other operating systems
can be considered later.

## What the user should be able to do

1. **Manage conversations.** View, select, and organize sessions under saved projects,
   and start a session from a project without selecting its folder again. History is
   preserved even when a CLI does not store it.
2. **Compose comfortably.** Edit multiline prompts, copy and paste, attach files, paste
   images, and keep drafts while switching between conversations.
3. **Switch agents manually.** The user decides when to switch and which CLI to use
   next, including after a quota limit. bbflow prepares access to the history that
   continuation needs, but it never chooses or switches agents by itself.
4. **Fork conversations.** Explore a different direction from an earlier point, while
   the fork keeps access to the history it inherited.
5. **Use worktrees.** Create separate working directories for independent coding tasks,
   whether or not the CLI supports worktrees itself.
6. **Find and reuse earlier work.** Search conversations, retrieve original messages,
   and keep useful decisions and memory across sessions and agents.
7. **Import existing history.** Bring conversations from Cursor Desktop, Codex Desktop,
   and Claude Desktop into the same searchable library, then continue or fork them with
   a supported CLI.
8. **Back up and restore data easily.** Keep bbflow's SQLite data in cloud storage, and
   recover it on a replacement installation without the original CLI's history service.

SPEC.md states which of these capabilities work today.

## Example workflow

The everyday workflow starts with a new or reopened session in which the user works
with an agent. Later, the user finds that conversation, or one decision from it,
through bbflow. This has to work even when the CLI itself keeps little session history.

A longer example also exercises import, continuation, and a fork:

1. Import a conversation from Cursor or Codex Desktop.
2. Open it in bbflow and select a workspace.
3. Continue with the local Codex CLI.
4. Retrieve an earlier decision from the bbflow history when more detail is needed.
5. Select another agent CLI after a quota limit, or when a different tool is more
   useful.
6. Fork the conversation into a new worktree to try another approach.

The conversation and its ancestry remain accessible throughout this workflow.

## Principles

AGENTS.md holds the detailed [invariants](../AGENTS.md#invariants-to-preserve) behind
these principles.

- **bbflow owns the recorded history.** The identity and availability of a conversation
  do not depend on any one CLI or its native session format. The original terminal
  input and output are the evidence, and readable text and summaries are only derived
  from it.
- **The server owns the work.** A background server owns each terminal process and its
  history, so a view can close and open again while the work and the recording
  continue. A session ends only when its shell exits, when the user stops it, or when
  the server stops.
- **Use ordinary terminal access.** Run each agent through its normal interactive CLI
  and preserve its arguments, authentication, and approval prompts. Do not depend on an
  SDK, structured output, or a native session API, although richer integrations can
  come later.
- **Continue with a history reference.** A new agent gets a reference to the recorded
  history and instructions to read it. Continuation must not need a summary from the
  earlier agent, because that agent's quota can be exhausted. Evaluate this approach
  before adding summaries.
- **State what continues.** Attaching to a live process, native CLI resume, and a new
  agent with history access are three different operations. A recording cannot restore
  hidden model state, and recorded input is never replayed to resume work.
- **Preserve history boundaries.** A fork inherits history up to its selected point.
  Later parent messages and sibling branches appear only through an explicitly broader
  search.
- **Keep file state explicit.** Conversation forks and workspace snapshots are separate
  concepts, because an old transcript alone cannot reconstruct historical files.
- **Show context coverage.** Preserve all captured or imported data, and identify
  missing attachments, unsupported data, and summaries rather than hiding them.
- **Preserve imported originals.** Import by copying, and retain provenance. A repeated
  import must not create duplicates or silently change history that a fork inherits.
- **Keep data local and scope explicit.** All durable bbflow data lives in one local
  SQLite database. Cloud replication happens only when the user selects it, and each
  history read has an explicit scope.
- **Keep durable data safe.** Upgrades preserve existing history, settings, and drafts,
  and backup and recovery preserve stable identities and history boundaries.
- **Keep bbflow small.** Keep the CLI small, the web client thin, and the release
  binary self-contained.

## Later interface goals

- **Chat interface.** Show the prompts sent through bbflow alongside the terminal
  output, while keeping a terminal view available for interactive prompts. Inferred
  message boundaries must not be presented as exact.
- **Desktop shell and global shortcut.** Once the web workflow is useful, provide one
  global shortcut that opens the bbflow UI or brings it to the foreground.

## What success looks like

- The user can rely on bbflow for daily agent work and can find decisions from earlier
  sessions.
- Each tested agent CLI leaves sessions that are available and searchable after a run
  ends, without depending on the CLI's own history management.
- The user can change tools without reconstructing context by hand, because a new CLI
  agent can retrieve an earlier decision from the bbflow history.
- Imported conversations are immediately available for search, agent references, and
  continuation in a new session.

## Open decisions

- Native CLI session mapping and resume after a process ends.
- Import source formats and refresh behavior. Codex is the first import target.
- Memory across sessions and agents.
- Summaries for continuation, to be decided after continuation with history references
  has been evaluated.
- The desktop framework and the key binding of the global shortcut.
- Cloud backup. See [PLAN.md](PLAN.md#cloud-backup).
