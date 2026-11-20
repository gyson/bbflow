# bbflow plans

This file lists planned work. In each implementation commit, remove completed items. For
partially completed items, describe only the remaining work. Document implemented
behavior in [SPEC.md](SPEC.md).

bbflow is in daily use. Future storage changes must include embedded migrations and
tests that preserve existing databases. Keep the full supported upgrade chain so users
can skip releases. See [SPEC.md](SPEC.md#database-upgrades) for current support.

## Richer web workspace

The terminal web client is implemented. See [SPEC.md](SPEC.md#web-client). The following
additions remain planned. Keep them on the shared WebSocket protocol and server
services. Do not add a separate browser session store or database writer.

- Add periodic emulator checkpoints for faster reconstruction after a server crash.
  Normal completion already saves a final display. Live reconnect uses state in memory.
  Keep original events authoritative and verify checkpoint/reconstruction boundaries.
- Extend terminal compatibility checks for graphics, extended keyboard protocols and
  soft-wrap copy semantics. Test the actual agent CLI versions before claiming support.
- Profile broader searches on daily-use archives. Evaluate full-text indexing if bounded
  scans do not meet search needs. Preserve original events and source references.
- Extend the read-only Changes pane. See [Diff and file views](#diff-and-file-views).
- Add verified agent-specific attachment delivery where plain file references are
  insufficient. Add imports and session forks when their core operations exist.
- Validate daily use with real agent CLIs in the browser. Synthetic terminal checks do
  not establish agent compatibility.
- Add a desktop shell and global shortcut after the web workflow is useful. The minimal
  macOS menu bar is implemented. See [SPEC.md](SPEC.md#macos-menu-bar).

See [GOAL.md](GOAL.md#future-workspace-interface) for the intended workspace experience.
Keep the deployed Go server self-contained. Browser launches start from a saved project
and use the server environment for the shell. Saved projects and General are
implemented. See [SPEC.md](SPEC.md#projects-and-launches).

### Acceptance checks for future additions

- Preserve history and draft durability as the workspace grows.
- Keep recorded text and file previews from executing as page content.
- Check diff and file views against the selected workspace, including symlinks.
- Preserve shared views, input from every view, and recording behavior. Reconnection
  must not replay input. It must not treat uncertain delivery as proof that a send
  failed.
- Verify development use does not modify production data.

## Diff and file views

The read-only Changes pane is implemented. See [SPEC.md](SPEC.md#changes-pane). The
following work remains.

- Insert a file path and a line range into the message editor from the diff.
- Show the list of commits since the worktree base.
- Show image previews as blobs in `<img>` elements. Never put SVG inline.
- Extend the Markdown preview. Open relative links in the Files view. Show workspace
  images after image previews exist.
- Record `HEAD` at the start of each run, to add a "Since this terminal started"
  baseline. This needs a migration.
- Show all changed files on one page, like a pull request, with lazy editors.
- Find files by name in a folder that is not a Git repository.
- Add arrow key navigation to the Files tree.
- Evaluate a smaller set of language modes if the bundle size becomes a problem.

## Continuation follow-ups

Continue in new terminal is implemented. See
[SPEC.md](SPEC.md#continue-in-a-new-terminal). The following work remains.

- Mark a terminal in the handoff README when it used the alternate screen, so a reader
  knows that its transcript is incomplete.
- Show the tool of the latest terminal in the session header. Now it shows the tool of
  the original launch.
- Check the default permission mode of Claude Code, where it may ask before it reads the
  handoff folder. Verify manual handoff with each agent CLI version before you recommend
  it.
- Evaluate continuation results. Then decide whether a session-scoped history command or
  a summary is necessary.

## Custom context

Status: deferred. Design a complete feature to add, edit, and apply custom context to
projects and sessions, including General. The scope and interface remain undecided.
bbflow does not insert context or deliver it automatically.

- Include guidance for searches across sessions with `bbflow query` in this feature.
- Keep saved context in SQLite. Make the selected context and its scope visible to the
  user before applying it.
- Verify delivery through each agent's supported interfaces. Do not type instructions
  into an ordinary shell or infer prompt readiness from terminal output.
- Preserve the user's current request and distinguish retrieved history from current
  instructions and authorization.

## Worktree follow-ups

Settings, tool command presets, session preparation, and managed worktrees are
implemented. See [SPEC.md](SPEC.md#session-preparation-settings-and-worktrees).

- Add optional copying of selected uncommitted changes only after defining exclusions,
  partial failure recovery, and a stable source snapshot.
- Evaluate setup commands and support for submodules and sparse checkouts with real
  repositories. Do not infer these capabilities from ordinary checkout fixtures.
- Consider moving an existing session to another workspace separately from creating a
  new session. An active shell cannot be moved by changing its recorded path.
- Add project-specific defaults if daily use needs them. Current defaults are per
  instance.

## Session family follow-ups

Session families are implemented. See [SPEC.md](SPEC.md#session-families). The following
work remains.

- Let an agent create a sub-session draft of its own session, for example a review-loop
  reviewer. This needs a decision about a narrow `bbflow` command or an MCP tool for
  drafts, because the CLI has no session commands now. Accept a tool name from Settings,
  never a raw command. Mark the draft as created by an agent. The user starts the draft
  and sends its message. `BBFLOW_SESSION` is only a claim of the caller.
- Then let the review-loop implementer create its reviewer draft.
- Do not start or send automatically. bbflow does not detect prompt readiness.
- Consider a family bar above the terminal to switch between the members of a family.
- Consider a way to put an existing session into a family, or to take a sub-session out,
  only if daily use needs it. A parent that can change needs checks for views that
  still show the earlier family: a stale draft form, and archive confirmations in both
  directions.
- Consider a restore of only the sub-sessions that a family archive archived. Now a
  restore of a parent restores all of its archived sub-sessions.

## Fork a session from an earlier point

Status: future possibility. This feature is not implemented. Add conversation branching
to the UI. Let the user select a point in the middle of an existing session. Continue
from that point in a new session.

For example, fork after an earlier design discussion to try another approach without
including the later implementation discussion. The original session remains available
and can continue independently.

### Expected behavior

- Give the fork its own bbflow session ID. Store its source session and fixed history
  cutoff in SQLite, with stable references to the original evidence. Keep this source
  separate from `sessions.parent_id`. A parent only organizes the sidebar, can change,
  and gives no history.
- Inherit history through the selected point. Later parent messages and sibling branches
  must not enter the fork's inherited view, even if the parent continues.
- Apply the cutoff consistently to future session-aware reads, search, attachments, and
  context preparation. General-purpose `bbflow query` still uses explicit SQL scope.
- Keep conversation branching separate from file state. Forking history does not restore
  old workspace files or create a worktree automatically.
- Continue through a verified native agent capability or a fresh agent with access to
  the inherited history. Never replay recorded keystrokes or claim to restore hidden
  agent state from a terminal recording.

Point selection remains undecided. Current terminal events are chunks. They do not
reliably identify message or turn boundaries. Before you implement the UI, define how to
select and explain the cutoff. Keep fork creation in the server.

Verify that inherited history stays fixed after parent activity and server restart.
Verify that it excludes later parent and sibling records. Verify that a fork changes no
files. Verify that it starts no agent without an explicit launch request.

## Cloud backup for SQLite

Status: planned. Local backup and restore commands have been removed. The next backup
feature should replicate bbflow's SQLite database to cloud storage. It should also
provide a way to recover that database from the cloud. A local export or backup-file
workflow is outside this plan.

### Storage boundary

All durable bbflow data belongs in SQLite. This includes sessions, runs, original
terminal input and output, and command and workspace metadata. It also includes resize
events, interruption notices, draft revisions, attachment bytes and metadata, and
derived searchable text. Keep future imports, fork boundaries, memory, and settings in
the database too.

Production defaults to `~/.bbflow/history.sqlite`. Development defaults to
`~/.bbflow-dev/history.sqlite`. SQLite's WAL can contain committed data that is not yet
in the main file. Replication must include this data.

Periodic copies of only the main file are insufficient. Server logs, `server.json`,
process locks, and rebuildable caches are not history and must not be restored as live
connection state. Workspace files (including General), provider-managed credentials, and
running processes are outside the backup scope.

### Candidate approach

Evaluate [Litestream](https://github.com/benbjohnson/litestream), or a similar tool.
Litestream documents a separate background process that continuously replicates SQLite
changes to cloud storage. This suggests an optional companion process while bbflow keeps
a non-CGO SQLite driver and builds with `CGO_ENABLED=0`. See the
[official overview](https://litestream.io/) and
[cloud storage guides](https://litestream.io/guides/).

This is a proposed integration, not a dependency decision. Pin and verify a version
before implementation. Check macOS distribution, licensing, resource use, SQLite/WAL
behavior, and compatibility with our driver. Decide whether bbflow or an external
service manager owns the replication process. Do not add a second database writer for
bbflow sessions or turn disaster recovery into multi-machine database synchronization.

### Implementation steps

1. **Verify replication with synthetic data.** Run a candidate beside bbflow while PTYs
   record output. Exercise checkpoints, database reopen, server restart, and replication
   restart. Verify any source schema changes made by the tool are compatible with
   bbflow's schema checks. Litestream currently documents an internal
   [`_litestream_lock` table](https://github.com/benbjohnson/litestream#source-database-changes).
2. **Choose one cloud destination.** Start with one supported object storage backend,
   such as S3 or an S3-compatible service. Use separate replica locations for each
   installation, database, and development/production environment. Local file replicas
   are not the product backup feature.
3. **Add explicit configuration and lifecycle.** Keep cloud replication disabled by
   default. Store durable bbflow settings in SQLite. Use environment variables or an OS
   credential store for cloud secrets. Define retention and encryption requirements.

Recording must continue when cloud access fails. Report replication errors, lag, and the
latest confirmed recovery point. A local commit does not prove that a cloud backup
exists.
4. **Add cloud recovery.** Recover into a new data directory while its server is
   stopped. Validate database integrity, references, and format before opening it.
   Preserve IDs, timestamps, original bytes, and history boundaries. Mark previously
   active runs as interrupted and report missing workspace paths.

Do not overwrite active data, launch agents, or replay recorded input. Apply supported
embedded migrations to the recovered database. Reject unknown or newer formats without
changing their contents.
5. **Document and expose the verified workflow.** Choose bbflow commands only after the
   lifecycle and recovery checks work. Update the command reference and SPEC.md with
   actual behavior, recovery limits, and operational requirements.

### Acceptance checks

- Recover from a cloud replica on a clean installation and compare session/run metadata,
  original event bytes, stable IDs, readable history, and search results.
- Prove that detached sessions continue recording during uploads and network outages.
  Test invalid credentials, cloud unavailability, interrupted uploads, and process
  crashes. Measure the possible loss of recent writes and the recovery time.
- Confirm development and production replicas cannot overwrite each other, and a
  recovered database cannot share a writable replica location with another active copy.
- Verify any implemented attachments, imports, and fork cutoffs survive recovery.
- Confirm recovery starts no agents and that the bbflow core still builds without CGO.

No Litestream installation, cloud account setup, uploads, or cloud recovery have been
performed yet. Backend selection, credentials, retention, and process supervision remain
open decisions.
