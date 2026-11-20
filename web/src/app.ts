import { call, encodeBytes, errorMessage, sessionTitle, VERSION } from './protocol.js';
import type { Handoff, PreparedSession, Project, Preparation, Run, TerminalInfo, Worktree, ServerInfo, SessionInfo, StreamRequest } from './protocol.js';
import { HandoffPrompt } from './handoff-prompt.js';
import { HistorySearch } from './history-search.js';
import { DiffPane } from './diff-pane.js';
import { SideTerminal } from './side-terminal.js';
import { WorkspacePane } from './workspace-pane.js';
import { continueAction, continueDialogProblem, defaultContinueTool } from './continue.js';
import { endReasonText, exitReason, hasTerminal, listStatus, listStatusText, live, statusText, terminalsChanged } from './session-status.js';
import type { EndReason } from './session-status.js';
import { Watch } from './watch.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { element } from './dom.js';
import { Composer } from './composer.js';
import { SessionMenu } from './session-menu.js';
import { SessionSplit } from './session-split.js';
import { Sidebar } from './sidebar.js';
import { FileListWidth } from './file-list-width.js';
import { mergeSessions, sessionGroups, sessionWindow } from './projects.js';
import { SessionConnection } from './session-connection.js';
import { PreparationEditor } from './preparation.js';
import { SettingsView } from './settings.js';
import { UpdateNotice } from './update.js';
import { TerminalPicker, earlierHint } from './terminal-picker.js';
import { homePath, parseRoute, sessionURL, settingsPath } from './route.js';
import { DialogEdits, lastReload, onServerReplaced, recordReload, reloadPlan, restartedMessage } from './restart.js';

const elements = {
  'history-open': element('history-open', HTMLButtonElement),
  'home-link': element('home-link', HTMLAnchorElement),
  'sessions-open': element('sessions-open', HTMLButtonElement),
  'archives-open': element('archives-open', HTMLButtonElement),
  'archived-heading': element('archived-heading', HTMLElement),
  'archive-session': element('archive-session', HTMLButtonElement),
  'launch-summary': element('launch-summary', HTMLElement),
  'settings-open': element('settings-open', HTMLButtonElement),
  'settings-close': element('settings-close', HTMLButtonElement),
  'remove-worktree': element('remove-worktree', HTMLButtonElement),
  'terminal-pane': element('terminal-pane', HTMLElement),
  'add-project': element('add-project', HTMLButtonElement),
  'project-dialog': element('project-dialog', HTMLDialogElement),
  'project-form': element('project-form', HTMLFormElement),
  'project-title': element('project-title', HTMLElement),
  'project-name-hint': element('project-name-hint', HTMLElement),
  'project-name': element('project-name', HTMLInputElement),
  'project-workspace': element('project-workspace', HTMLInputElement),
  'project-folder': element('project-folder', HTMLElement),
  'project-error': element('project-error', HTMLElement),
  'project-submit': element('project-submit', HTMLButtonElement),
  'project-remove': element('project-remove', HTMLButtonElement),
  'project-remove-help': element('project-remove-help', HTMLElement),
  'cancel-project': element('cancel-project', HTMLButtonElement),
  'rename-session': element('rename-session', HTMLButtonElement),
  'copy-session-id': element('copy-session-id', HTMLButtonElement),
  'rename-dialog': element('rename-dialog', HTMLDialogElement),
  'rename-form': element('rename-form', HTMLFormElement),
  'rename-name': element('rename-name', HTMLInputElement),
  'rename-error': element('rename-error', HTMLElement),
  'rename-submit': element('rename-submit', HTMLButtonElement),
  'cancel-rename': element('cancel-rename', HTMLButtonElement),
  'notice': element('notice', HTMLElement),
  'stop': element('stop', HTMLButtonElement),
  'reconnect': element('reconnect', HTMLButtonElement),
  'reload-output': element('reload-output', HTMLButtonElement),
  'continue-action': element('continue-action', HTMLElement),
  'continue-session': element('continue-session', HTMLButtonElement),
  'continue-unavailable': element('continue-unavailable', HTMLElement),
  'continue-dialog': element('continue-dialog', HTMLDialogElement),
  'continue-form': element('continue-form', HTMLFormElement),
  'continue-workspace': element('continue-workspace', HTMLElement),
  'continue-tool': element('continue-tool', HTMLSelectElement),
  'continue-prompt': element('continue-prompt', HTMLTextAreaElement),
  'continue-warning': element('continue-warning', HTMLElement),
  'continue-error': element('continue-error', HTMLElement),
  'continue-copy': element('continue-copy', HTMLButtonElement),
  'continue-submit': element('continue-submit', HTMLButtonElement),
  'cancel-continue': element('cancel-continue', HTMLButtonElement),
  'handoff-open': element('handoff-open', HTMLButtonElement),
  'sessions': element('sessions', HTMLElement),
  'filter': element('filter', HTMLInputElement),
  'connection': element('connection', HTMLElement),
  'session-title': element('session-title', HTMLElement),
  'workspace': element('workspace', HTMLElement),
  'workspace-path': element('workspace-path', HTMLElement),
  'workspace-removed': element('workspace-removed', HTMLElement),
  'terminal': element('terminal', HTMLElement),
  'dimensions': element('dimensions', HTMLElement),
  'status': element('status', HTMLElement),
  'terminal-hint': element('terminal-hint', HTMLElement),
  'welcome': element('welcome', HTMLElement),
  'session-view': element('session-view', HTMLElement),
  'instance-dir': element('instance-dir', HTMLElement),
};

const $ = <K extends keyof typeof elements>(id: K): typeof elements[K] => elements[id];

interface SessionView {
  archived?: boolean;
  preparation?: Preparation;
  worktree?: Worktree;
  run?: Run;
  projectId?: string;
  id?: string;
  title: string;
  autoTitle?: string;
  workspace: string;
  status: string;
}

// start claims a prepared draft. continue starts a new terminal in an ended session.
type Launch = { kind: 'start' } | { kind: 'continue'; tool: string };

let server: ServerInfo | null = null;
let connection: SessionConnection | null = null;
let terminal: Terminal | null = null;
const systemDark = matchMedia('(prefers-color-scheme: dark)');
let fit: FitAddon | null = null;
let sessions: SessionInfo[] = [];
// The status of each session that has a live terminal, from the status watch.
let liveStatuses: Record<string, string> = {};
// The count of title changes from the status watch.
let titleRevision = 0;
let projects: Project[] = [];
let editingProject: Project | null = null;
const collapsedProjects = new Set<string>();
let renderedSidebar = '';
// The status elements and the archive button of each session in the list. A status change
// updates them in place, so the buttons and the keyboard focus stay.
const statusMarks: { session: SessionInfo; dot: HTMLElement; text: Text; archive: HTMLButtonElement }[] = [];
let selected: SessionView | null = null;
let continueRun: string | undefined;
// The handoff prompt of the selected session. It stays available after a new terminal
// starts, so the user can copy or send it later.
let handoff: { session: string; info: Handoff } | null = null;
// The reason that this view saw for the end of a run of the selected session: an exit
// code, or the recorded run status.
let endReason: EndReason | null = null;
let terminalsGeneration = 0;
let busy = false;
let archivedList = false, refreshGeneration = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
// The sidebar shows the most recent sessions of each project group. Show more adds a step.
// The group key is a project ID, or '' for Standalone. The list and Archived keep separate
// limits. moreGroups holds the groups that have more sessions.
const sessionStep = 10;
const groupLimits = { list: new Map<string, number>(), archived: new Map<string, number>() };
let moreGroups = new Set<string>();
const limits = () => archivedList ? groupLimits.archived : groupLimits.list;
const composer = new Composer({
  server: () => server,
  peer: () => connection?.peer ?? null,
  bracketed: () => !!terminal?.modes.bracketedPasteMode,
  action,
});
const sessionSplit = new SessionSplit();
const sessionMenu = new SessionMenu();
const handoffPrompt = new HandoffPrompt({ insert: text => composer.insert(text) });
// A view shows one terminal of the selected session. Earlier terminals show their saved
// final screen. The live process continues while a view shows an earlier terminal.
const terminalPicker = new TerminalPicker({
  select: run => action(async () => { if (selected?.id) await openSession(selected, undefined, run); }),
  refresh: () => { if (selected?.id) void loadTerminals(selected.id); },
});
const historySearch = new HistorySearch(() => server);
const diffPane = new DiffPane(() => server);
const sideTerminal = new SideTerminal(() => server, terminalTheme);
const workspacePane = new WorkspacePane(diffPane, sideTerminal);
new Sidebar();
new FileListWidth();

let showingSettings = false;
const settingsView = new SettingsView(() => server, updateTerminalTheme);
const preparation = new PreparationEditor({
  server: () => server,
  changed(session) {
    if (selected?.id === session.id) {
      selected = { ...selected, ...session };
      heading(session.title || 'Untitled draft');
      showWorkspace(session.workspace, session.worktree);
    }
    void refreshSessions();
  },
  start: session => action(async () => {
    await composer.flush();
    await openSession({ ...session, status: 'draft' }, { kind: 'start' });
  }),
});

// The status watch sends the release offer of the server. An update restarts the server,
// so save the drafts of this view first. The reload after the restart shows the new UI.
const updateNotice = new UpdateNotice({
  title(id) {
    const session = sessions.find(item => item.id === id);
    return session ? sessionTitle(session) || 'Untitled session' : undefined;
  },
  async start(offer) {
    if (!server) throw new Error('The server is not connected.');
    await preparation.flush();
    await composer.flush();
    await call(server, { operation: 'update-start', version: offer.available, revision: offer.revision });
    notice(`bbflow updates to ${offer.available}. This page reloads when the new server starts.`);
  },
});

let noticeSource: 'action' | 'list' | 'stream' = 'action';
function notice(text = '', source: typeof noticeSource = 'action') {
  noticeSource = source;
  $('notice').textContent = text;
  $('notice').hidden = !text;
}

function clearNotice(source: typeof noticeSource) {
  if (noticeSource === source) notice();
}

// These dialogs keep their text only until submission. A reload would discard it.
const dialogEdits = new DialogEdits([
  { dialog: $('project-dialog'), fields: [$('project-name'), $('project-workspace')] },
  { dialog: $('rename-dialog'), fields: [$('rename-name')] },
  { dialog: $('continue-dialog'), fields: [$('continue-tool')] },
]);
const dialogErrors = new Map([
  [$('project-dialog'), $('project-error')],
  [$('rename-dialog'), $('rename-error')],
  [$('continue-dialog'), $('continue-error')],
]);

function showDialog(dialog: HTMLDialogElement): void {
  dialog.showModal();
  dialogEdits.opened(dialog);
}

// A restart or an update replaced the server of this instance. Reload once to get the
// new UI. The reload keeps the path, so the tab shows the same view again.
let replaced = false;
onServerReplaced(() => {
  if (replaced) return;
  replaced = true;
  const now = Date.now();
  const dialog = dialogEdits.changed();
  if (reloadPlan(!!dialog || composer.unsaved || preparation.unsaved || settingsView.unsaved, lastReload(), now) === 'reload') {
    recordReload(now);
    location.reload();
    return;
  }
  notice(restartedMessage);
  // A modal dialog covers the page notice. Show the message in the dialog too.
  const error = dialog && dialogErrors.get(dialog);
  if (error) {
    error.textContent = restartedMessage;
    error.hidden = false;
  }
});

// A live view gets status changes on its stream. Keep that status over a slower read.
function withDetail(session: SessionView, detail: PreparedSession): SessionView {
  return { ...session, ...detail, status: connection?.peer?.active ? session.status : detail.status };
}

// Show the status of the selected session. An ended session adds the reason that this
// view saw for the latest run, or the stored status of that run.
function showStatus() {
  if (selected && selected.status !== 'draft') $('status').textContent = statusText(selected.status, endReasonText(endReason, selected.run));
}

// Show the view name in the page heading and in the browser tab.
function heading(title: string, tab = title) {
  $('session-title').textContent = title;
  document.title = tab;
}

function showWorkspace(path: string, worktree?: Worktree) {
  const branch = worktree ? `⑂ ${worktree.branch}` : '';
  const label = branch ? `${branch} · ${path}` : path;
  const removed = worktree?.state === 'removed';
  $('workspace-path').textContent = removed ? path : label;
  $('workspace-removed').hidden = !removed;
  $('workspace').title = removed ? `${path} · ${branch}` : label;
}

function controls() {
  $('history-open').disabled = busy || !server;
  const launch = selected?.preparation;
  $('launch-summary').hidden = showingSettings || !launch || selected?.status === 'draft';
  $('launch-summary').textContent = launch ? `${launch.toolName} · ${launch.command || 'Interactive shell'}` : '';
  $('launch-summary').title = $('launch-summary').textContent;
  preparation.controls(busy, !!selected?.archived);
  $('sessions-open').disabled = $('archives-open').disabled = busy || !server;
  $('archive-session').hidden = showingSettings || !selected?.id || live(selected.status);
  $('archive-session').disabled = busy;
  $('archive-session').textContent = selected?.archived ? 'Restore' : 'Archive';
  if (!showingSettings && selected?.status === 'draft') $('status').textContent = selected.archived ? 'Draft · Archived' : 'Draft';
  $('settings-open').disabled = busy || !server;
  updateNotice.controls(busy || !server);
  $('settings-close').disabled = busy;
  composer.controls(busy, !!connection?.ready && !!connection.peer?.active);
  $('add-project').disabled = busy || !server;
  // Worktree creation shows as running, but only a terminal can stop or reconnect.
  const terminalLive = !!connection?.peer?.active || hasTerminal(selected);
  const shownRun = terminalPicker.shownRun;
  $('stop').hidden = showingSettings || !terminalLive || !!shownRun;
  $('stop').disabled = busy;
  // A view of an earlier terminal uses Back to live terminal instead. A live terminal
  // gets Reconnect in the toolbar. An ended terminal gets Reload output in the More menu.
  const connected = showingSettings || !selected || selected.status === 'draft' || !!connection?.peer?.active || !!shownRun;
  $('reconnect').hidden = connected || !terminalLive;
  $('reload-output').hidden = connected || terminalLive;
  $('reconnect').disabled = $('reload-output').disabled = busy;
  const continuation = continueAction(selected, !!connection?.peer?.active, shownRun);
  const continueControl = $('continue-action');
  continueControl.hidden = showingSettings || !continuation.visible;
  $('continue-session').disabled = $('continue-submit').disabled = busy || !!continuation.problem;
  $('continue-unavailable').textContent = continuation.problem;
  if (continuation.problem) {
    continueControl.dataset.tip = continuation.problem;
    continueControl.tabIndex = 0;
  } else {
    delete continueControl.dataset.tip;
    continueControl.removeAttribute('tabindex');
  }
  if ($('continue-dialog').open) {
    const problem = continueDialogProblem(continuation, selected?.run?.id, continueRun);
    if (problem) {
      $('continue-dialog').close();
      notice(problem);
    }
  }
  $('handoff-open').hidden = showingSettings || !selected?.id || handoff?.session !== selected.id || !handoff.info.available;
  $('handoff-open').disabled = busy;
  terminalPicker.controls(busy);
  $('project-submit').disabled = $('project-remove').disabled = $('rename-submit').disabled = busy;
  $('rename-session').hidden = $('copy-session-id').hidden = showingSettings || !selected?.id || selected.status === 'draft';
  // The More menu lists only the actions that apply. A live session keeps its worktree.
  $('remove-worktree').hidden = showingSettings || !selected?.worktree || selected.worktree.state === 'removed' || live(selected.status);
  $('remove-worktree').disabled = $('rename-session').disabled = $('copy-session-id').disabled = busy;
  sessionMenu.controls();
  $('project-name').disabled = $('project-workspace').disabled = $('rename-name').disabled = busy;
  for (const button of $('sessions').querySelectorAll('button')) button.disabled = busy;
}

async function action(work: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  controls();
  try { await work(); } catch (error) { notice(errorMessage(error)); }
  finally { busy = false; controls(); }
}

// Icons of the archive button in a session row. They are constant markup.
const archiveIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.75" y="3.75" width="14.5" height="4" rx="1"/><path d="M4.25 7.75v7.5a1 1 0 0 0 1 1h9.5a1 1 0 0 0 1-1v-7.5M8.25 11h3.5"/></svg>';
const restoreIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.75" y="3.75" width="14.5" height="4" rx="1"/><path d="M4.25 7.75v7.5a1 1 0 0 0 1 1h9.5a1 1 0 0 0 1-1v-7.5M10 14.25v-4M8.25 11.75 10 10l1.75 1.75"/></svg>';

// Return a list row with the session button and its archive button. A button cannot
// contain another button, so the row holds both.
function sessionRow(session: SessionInfo, showWorkspace: boolean): HTMLElement {
  const button = document.createElement('button');
  button.className = 'session-item' + (selected?.id === session.id ? ' selected' : '');
  button.setAttribute('aria-current', selected?.id === session.id ? 'true' : 'false');
  button.title = `${sessionTitle(session)}\n${session.workspace}\n${session.id}\n${session.updated}`;
  const title = document.createElement('strong');
  title.textContent = sessionTitle(session) || (session.status === 'draft' ? 'Untitled draft' : 'Untitled session');
  const status = document.createElement('span');
  status.className = 'run-state';
  const dot = document.createElement('span'), text = document.createTextNode('');
  status.append(dot, text);
  button.dataset.focus = `session:${session.id}`;
  button.append(title);
  if (showWorkspace) {
    const workspace = document.createElement('small');
    workspace.textContent = session.workspace;
    button.append(workspace);
  }
  button.append(status);
  button.onclick = () => action(() => openSession(session));
  const archive = document.createElement('button');
  archive.className = 'session-archive';
  archive.title = `${session.archived ? 'Restore' : 'Archive'} ${title.textContent}`;
  archive.setAttribute('aria-label', archive.title);
  archive.innerHTML = session.archived ? restoreIcon : archiveIcon;
  archive.onclick = async () => {
    // The row leaves the list. A keyboard user then gets the next session, or the previous one.
    const keyboard = document.activeElement === archive;
    const items = [...$('sessions').querySelectorAll<HTMLElement>('.session-item')];
    const index = items.indexOf(button);
    const next = (items[index + 1] ?? items[index - 1])?.dataset.focus;
    await action(() => setArchived(session.id, !session.archived));
    if (keyboard && next && (document.activeElement === document.body || !document.activeElement)) focusSidebar(next);
  };
  statusMarks.push({ session, dot, text, archive });
  const row = document.createElement('div');
  row.className = 'session-row';
  row.append(button, archive);
  return row;
}

// Show the current status of each session in the list, without new buttons.
function showListStatuses() {
  for (const { session, dot, text, archive } of statusMarks) {
    // A live view and the status watch get status changes at once. The list is older.
    const shown = connection?.peer?.active && selected?.id === session.id ? selected.status : listStatus(session, liveStatuses);
    const className = `dot ${shown}`, line = listStatusText(shown, session);
    if (dot.className !== className) dot.className = className;
    if (text.data !== line) text.data = line;
    // The server archives only drafts and ended sessions.
    archive.hidden = live(shown);
  }
}

function renderSessions() {
  const query = $('filter').value.toLowerCase();
  // A status is not part of the fingerprint. A status change must not replace the buttons.
  const fingerprint = JSON.stringify([projects, sessions, query, archivedList, [...moreGroups], selected?.id, showingSettings, [...collapsedProjects]]);
  if (fingerprint === renderedSidebar) { showListStatuses(); controls(); return; }
  renderedSidebar = fingerprint;
  // New buttons replace the list. Give the keyboard focus to the new button of the same item.
  const focused = document.activeElement instanceof HTMLElement && $('sessions').contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
  statusMarks.length = 0;
  $('sessions').replaceChildren();
  $('archives-open').setAttribute('aria-pressed', String(archivedList));
  $('archived-heading').hidden = !archivedList;
  $('sessions').setAttribute('aria-label', archivedList ? 'Archived sessions' : 'Projects and sessions');
  $('filter').placeholder = archivedList ? 'Search archived sessions…' : 'Search names and folders…';
  const groups = sessionGroups(projects, sessions, query).filter(group => !archivedList || group.sessions.length);
  for (const group of groups) {
    const project = group.project;
    const id = project?.id ?? '';
    const name = project?.name ?? 'Standalone';
    const section = document.createElement('section');
    section.className = 'project-group';
    const heading = document.createElement('div');
    heading.className = 'project-heading';
    const toggle = document.createElement('button');
    toggle.className = 'project-toggle';
    const label = document.createElement('span');
    label.className = 'project-name';
    label.textContent = name;
    label.title = project?.workspace ?? 'Sessions without a saved project';
    const list = document.createElement('div');
    list.id = `project-sessions-${id || 'standalone'}`;
    list.className = 'project-sessions';
    const update = () => {
      list.hidden = !query && collapsedProjects.has(id);
      toggle.textContent = list.hidden ? '▸' : '▾';
      toggle.setAttribute('aria-label', `${list.hidden ? 'Expand' : 'Collapse'} ${name}`);
      toggle.setAttribute('aria-expanded', String(!list.hidden));
    };
    toggle.dataset.focus = `toggle:${id}`;
    toggle.setAttribute('aria-controls', list.id);
    toggle.onclick = () => {
      if (collapsedProjects.has(id)) collapsedProjects.delete(id); else collapsedProjects.add(id);
      update();
    };
    update();
    heading.append(toggle, label);
    if (project && !archivedList) {
      const add = document.createElement('button');
      add.className = 'project-action';
      add.textContent = '＋';
      add.title = `New draft in ${name}`;
      add.setAttribute('aria-label', add.title);
      add.dataset.focus = `add:${id}`;
      add.onclick = () => action(() => showLaunch(project.id));
      heading.append(add);
      if (id !== 'general') {
        const edit = document.createElement('button');
        edit.className = 'project-action';
        edit.textContent = '⋯';
        edit.title = `Edit ${name}`;
        edit.setAttribute('aria-label', edit.title);
        edit.dataset.focus = `edit:${id}`;
        edit.onclick = () => showProject(project);
        heading.append(edit);
      }
    }
    for (const session of group.sessions) list.append(sessionRow(session, !project));
    if (moreGroups.has(id)) {
      const more = document.createElement('button');
      more.className = 'project-more';
      more.textContent = 'Show more';
      more.title = `Show ${sessionStep} more sessions of ${name}`;
      more.dataset.focus = `more:${id}`;
      more.onclick = async () => {
        // A busy action disables the sidebar buttons, and a disabled button loses the focus.
        // Thus give the focus back after the action.
        const keyboard = document.activeElement === more;
        await action(async () => {
          limits().set(id, (limits().get(id) ?? sessionStep) + sessionStep);
          await refreshSessions();
        });
        if (keyboard && (document.activeElement === document.body || !document.activeElement)) focusSidebar(more.dataset.focus!);
      };
      list.append(more);
    }
    if (!group.sessions.length) {
      const empty = document.createElement('p');
      empty.className = 'project-empty';
      empty.textContent = query ? 'No matching sessions.' : 'Create a draft with ＋.';
      list.append(empty);
    }
    section.append(heading, list);
    $('sessions').append(section);
  }
  if (!groups.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = archivedList ? 'No archived sessions found.' : 'No matching projects or sessions.';
    $('sessions').append(empty);
  }
  showListStatuses();
  if (focused) focusSidebar(focused);
  controls();
}

// Give the keyboard focus to the sidebar button with this focus key. Show more is not there
// after a group shows all of its sessions. Then its key selects the last session of the group.
function focusSidebar(key: string): void {
  const target = [...$('sessions').querySelectorAll<HTMLElement>('[data-focus]')].find(button => button.dataset.focus === key)
    ?? (key.startsWith('more:') ? [...document.getElementById(`project-sessions-${key.slice(5) || 'standalone'}`)?.querySelectorAll<HTMLElement>('.session-item') ?? []].at(-1) : undefined);
  target?.focus({ preventScroll: true });
}

// Show brief activity of each session in the list. The list refresh is too slow for it.
function watchStatuses(info: ServerInfo) {
  new Watch(info, { operation: 'status-watch' }, {
    message(message) {
      if (message.type !== 'statuses') return;
      const next = message.statuses ?? {};
      const changed = terminalsChanged(liveStatuses, next);
      liveStatuses = next;
      // The update dialog counts the live sessions of the same message as the offer.
      updateNotice.show(message.update, Object.keys(next));
      renderSessions();
      // A terminal started or ended, or a session title changed. Read the stored session
      // data again.
      const titles = message.revision ?? 0;
      if ((changed || titles !== titleRevision) && !busy) void refreshSessions();
      titleRevision = titles;
    },
    // Without the watch, the list refresh supplies each status.
    failed() {
      liveStatuses = {};
      updateNotice.lost();
      renderSessions();
    },
  });
}

// Show the connection line only while the server is unavailable.
function showConnection(available: boolean) {
  $('connection').textContent = available ? '' : '○ Server unavailable';
  $('connection').hidden = available;
}

async function refreshSessions() {
  if (!server) return;
  const generation = ++refreshGeneration;
  const selectedId = selected?.id;
  try {
    const filter = { archived: archivedList, query: $('filter').value };
    const [nextProjects, detail] = await Promise.all([
      call(server, { operation: 'project-list' }),
      selectedId ? call(server, { operation: 'session-config', session: selectedId }) : Promise.resolve(null),
    ]);
    if (generation !== refreshGeneration) return;
    // One reply lists at most sessionWindow sessions. Thus the most recent sessions come in
    // batches of groups, and a group that shows more than one step reads its older sessions
    // in windows. The selected session stays in its group, also when it is older.
    const groups = ['', ...nextProjects.map(project => project.id)];
    const batch = sessionWindow / sessionStep;
    const recentReads = [];
    for (let i = 0; i < groups.length; i += batch) {
      recentReads.push(call(server, { operation: 'session-list', limit: sessionStep, groups: groups.slice(i, i + batch), ...filter, ...(selectedId ? { session: selectedId } : {}) }));
    }
    const windowReads = [...limits()].flatMap(([group, limit]) => {
      const reads = [];
      for (let offset = sessionStep; offset < limit; offset += sessionWindow) {
        reads.push(call(server!, { operation: 'session-list', groups: [group], offset, limit: Math.min(sessionWindow, limit - offset), ...filter })
          .then(page => ({ group, offset, page })));
      }
      return reads;
    });
    const [recentPages, nextWindows] = await Promise.all([Promise.all(recentReads), Promise.all(windowReads)]);
    if (generation !== refreshGeneration) return;
    const recent = { sessions: recentPages.flatMap(page => page.sessions), more: recentPages.flatMap(page => page.more) };
    projects = nextProjects;
    const merged = mergeSessions(projects, recent, nextWindows, sessionStep);
    sessions = merged.sessions;
    moreGroups = new Set(merged.more);
    updateNotice.sessionsChanged();
    if (detail && selected && selected.id === selectedId) selected.archived = detail.archived;
    showConnection(true);
    clearNotice('list');
    if (selected && !showingSettings && !preparation.visible) {
      if (detail && selected.id === detail.id) {
        selected = withDetail(selected, detail);
        if (connection?.ready) showStatus();
      }
      heading(sessionTitle(selected) || 'Untitled session');
      showWorkspace(selected.workspace, selected.worktree);
    }
    renderSessions();
  } catch (error) {
    if (generation !== refreshGeneration) return;
    showConnection(false);
    notice(errorMessage(error), 'list');
  } finally {
    if (generation === refreshGeneration) controls();
  }
}

function boundedSize(value: { rows: number; cols: number }) {
  return { rows: Math.max(1, Math.min(256, value.rows)), cols: Math.max(2, Math.min(512, value.cols)) };
}
function size(view: Terminal) { return boundedSize(view); }

function requestFit() {
  if (!terminal || !connection?.ready || !connection?.peer?.active || connection?.resizing) return;
  const proposed = fit?.proposeDimensions();
  const dimensions = proposed ? boundedSize(proposed) : undefined;
  if (dimensions && (dimensions.cols !== terminal.cols || dimensions.rows !== terminal.rows)) {
    // Apply the server's size event in stream order, after output at the old size.
    connection.peer.send({ type: 'resize', size: dimensions });
  }
}

function terminalTheme() {
  const background = getComputedStyle($('terminal')).backgroundColor;
  const scheme = getComputedStyle(document.documentElement).colorScheme;
  const dark = scheme === 'dark' || (scheme === 'light dark' && systemDark.matches);
  return dark
    ? { background, foreground: '#efeff1', cursor: '#d6d6dc', selectionBackground: '#46536b' }
    : { background, foreground: '#d7e4dc', cursor: '#b8dcc3', selectionBackground: '#486e59' };
}

function updateTerminalTheme(): void {
  sideTerminal.updateTheme();
  if (!terminal) return;
  const theme = terminalTheme();
  if (terminal.options.theme?.background !== theme.background) {
    terminal.options.theme = theme;
  }
}

function makeTerminal(): Terminal {
  terminal?.dispose();
  $('terminal').replaceChildren();
  const view = terminal = new Terminal({
    cursorBlink: true, fontSize: 13, lineHeight: 1.25, scrollback: 10000,
    fontFamily: 'Menlo, Monaco, Consolas, monospace', disableStdin: true, screenReaderMode: true,
    theme: terminalTheme(),
    // Terminal output must not open links, read the browser clipboard, or write to it.
    linkHandler: { activate() {} },
  });
  fit = new FitAddon();
  terminal.loadAddon(fit);
  const host = document.createElement('div');
  host.className = 'terminal-host';
  $('terminal').append(host);
  terminal.open(host);
  fit.fit();
  $('dimensions').textContent = `${terminal.cols} × ${terminal.rows}`;
  terminal.onData(data => {
    if (!connection?.ready || !connection.peer?.active) return;
    const bytes = new TextEncoder().encode(data);
    for (let start = 0; start < bytes.length; start += 16384) {
      if (!connection?.peer?.send({ type: 'input', data: encodeBytes(bytes.subarray(start, start + 16384)) })) break;
    }
  });
  terminal.onBinary(data => {
    if (connection?.ready && connection.peer?.active) connection.peer.send({ type: 'input', data: btoa(data) });
  });
  terminal.onResize(({ rows, cols }) => {
    $('dimensions').textContent = `${cols} × ${rows}`;
  });
  return view;
}

async function leaveView() {
  await preparation.flush();
  await composer.flush();
  connection?.close();
  connection = null;
  if (terminal) terminal.options.disableStdin = true;
}

// run shows an earlier terminal of the session. Without run, the view shows the latest
// terminal.
async function openSession(session: SessionView, launch?: Launch, run = ''): Promise<void> {
  if (!server) throw new Error('The server is unavailable. Reload this page.');
  const start = !!launch;
  if (!start && !run && !showingSettings && selected?.id === session.id && connection?.peer?.active) {
    terminal?.focus();
    return;
  }
  await leaveView();
  settingsView.close(); showingSettings = false;
  if (!start && session.id) {
    const detail = await call(server, { operation: 'session-config', session: session.id });
    session = { ...session, ...detail };
  }
  endReason = null;
  await composer.select('');
  notice();
  if (selected?.id !== session.id) terminalPicker.update([]);
  selected = session;
  terminalPicker.show(start ? '' : run);
  if (archivedList !== !!session.archived) {
    archivedList = !!session.archived; $('filter').value = '';
    await refreshSessions();
  }
  $('welcome').hidden = true;
  $('session-view').hidden = false;
  const preparing = session.status === 'draft' && !start;
  workspacePane.select(preparing ? '' : session.id ?? '');
  heading(sessionTitle(session) || (preparing ? 'Untitled draft' : 'Untitled session'));
  showWorkspace(session.workspace, session.worktree);
  $('status').hidden = false;
  $('status').textContent = 'Connecting';
  history.replaceState(null, '', sessionURL(session.id ?? ''));
  $('terminal-pane').hidden = preparing;
  sessionSplit.setEnabled(false);
  if (preparing && session.id) {
    $('status').textContent = session.archived ? 'Draft · Archived' : 'Draft';
    await preparation.open({ ...session, archived: !!session.archived, id: session.id, projectId: session.projectId ?? '' });
    await composer.select(session.id);
    renderSessions(); return;
  }
  await preparation.close();
  sessionSplit.setEnabled(true);
  const view = makeTerminal();
  let request: StreamRequest;
  if (launch?.kind === 'start' && session.id && session.preparation) {
    request = { operation: 'session-start', session: session.id, revision: session.preparation.revision, size: size(view) };
  } else if (launch?.kind === 'continue' && session.id && session.run) {
    request = { operation: 'session-continue', session: session.id, latestRun: session.run.id, tool: launch.tool, size: size(view) };
  } else if (session.id) {
    request = { operation: 'session-resume', session: session.id, size: size(view), ...(run ? { run } : {}) };
  } else {
    throw new Error('No session was selected.');
  }
  renderSessions();
  connection = new SessionConnection(server, view, request, {
    size: () => size(view),
    ready() {
      clearNotice('stream');
      view.options.disableStdin = !connection?.peer?.active;
      showStatus();
      requestFit();
      controls();
    },
    message(message) {
      if (!selected) return;
      switch (message.type) {
        case 'session':
          selected.id = message.session;
          workspacePane.select(message.session);
          // A status message follows for a live terminal. A saved screen of the latest
          // terminal means that the session ended. A saved screen of an earlier terminal
          // does not change the status of the session.
          if (message.active) { if (!live(selected.status)) selected.status = 'running'; }
          else if (!terminalPicker.shownRun) selected.status = 'ended';
          $('status').textContent = 'Restoring';
          $('terminal-hint').textContent = message.active ? 'Click the terminal to type. Ctrl+C reaches the application.' :
            terminalPicker.shownRun ? earlierHint(terminalPicker.shown()) : 'Recorded output of the latest terminal. No process was started.';
          void loadTerminals(message.session);
          view.options.disableStdin = true;
          history.replaceState(null, '', sessionURL(message.session));
          if (message.notice) notice(message.notice);
          refreshSessions();
          view.focus();
          break;
        case 'status':
          selected.status = message.status;
          if (connection?.ready) showStatus();
          renderSessions();
          break;
        case 'exit':
          selected.status = 'ended';
          // The exit message names its run. This view can have an earlier run, or no run,
          // because the run of a new terminal starts after the view reads the session.
          if (message.run) selected.run = { id: message.run, status: message.status ?? '' };
          endReason = { run: message.run ?? '', text: exitReason(message.code, message.status) };
          view.options.disableStdin = true;
          showStatus();
          $('terminal-hint').textContent = 'Process ended. Showing saved terminal output.';
          if (message.error) notice(message.error);
          refreshSessions();
          void loadTerminals(selected.id ?? '');
          break;
        case 'history-end': view.options.disableStdin = true; break;
      }
      controls();
    },
    disconnected(error, retrying) {
      view.options.disableStdin = true;
      $('status').textContent = retrying ? 'Reconnecting' : 'Disconnected';
      $('terminal-hint').textContent = 'Connection lost. Showing the last screen; input is disabled until reconnection.';
      notice(errorMessage(error), 'stream');
      controls();
      refreshSessions();
    },
  });
  try { await connection.connect(); }
  catch (error) {
    if (start && session.id) { await openSession(session); notice(errorMessage(error)); return; }
    throw error;
  } finally {
    if (selected?.id) {
      await composer.select(selected.id);
      await loadHandoff(selected.id);
    }
  }
}

// A missing handoff only hides the button. It does not block the session view.
async function loadHandoff(id: string): Promise<void> {
  if (!server) return;
  try {
    const info = await call(server, { operation: 'session-handoff', session: id });
    if (selected?.id === id) handoff = { session: id, info };
  } catch { if (handoff?.session === id) handoff = null; }
  controls();
}

// A missing list only hides the terminal selector. Only the newest request updates it.
async function loadTerminals(id: string): Promise<void> {
  if (!server || !id) return;
  const generation = ++terminalsGeneration;
  let terminals: TerminalInfo[] = [];
  try { terminals = await call(server, { operation: 'session-terminals', session: id }); } catch { /* Hide the selector. */ }
  if (generation !== terminalsGeneration || selected?.id !== id) return;
  terminalPicker.update(terminals);
  if (terminalPicker.shownRun && connection?.ready) $('terminal-hint').textContent = earlierHint(terminalPicker.shown());
  controls();
}

async function showContinue(): Promise<void> {
  if (!server || !selected?.id) return;
  await composer.flush();
  const id = selected.id;
  const [detail, settings, handoff] = await Promise.all([
    call(server, { operation: 'session-config', session: id }),
    call(server, { operation: 'settings-get' }),
    call(server, { operation: 'session-handoff', session: id }),
  ]);
  if (selected?.id !== id) return;
  selected = withDetail(selected, detail);
  const continuation = continueAction(selected, !!connection?.peer?.active, terminalPicker.shownRun);
  const problem = continueDialogProblem(continuation, selected.run?.id);
  if (problem) {
    showWorkspace(selected.workspace, selected.worktree);
    notice(problem);
    return;
  }
  $('continue-tool').replaceChildren(new Option('Shell', ''), ...settings.tools.map(tool => new Option(tool.name || 'Unnamed tool', tool.id)));
  $('continue-tool').value = defaultContinueTool(settings.tools, selected.preparation?.toolId, settings.defaultTool);
  $('continue-prompt').value = handoff.prompt;
  $('continue-workspace').textContent = selected.worktree ? `⑂ ${selected.worktree.branch} · ${selected.workspace}` : selected.workspace;
  $('continue-warning').hidden = selected.run?.status !== 'interrupted';
  $('continue-error').hidden = true;
  $('continue-copy').textContent = 'Copy prompt';
  continueRun = selected.run?.id;
  showDialog($('continue-dialog'));
}

async function showLaunch(projectId: string): Promise<void> {
  if (!server) return;
  await leaveView();
  const session = await call(server, { operation: 'project-draft', project: projectId });
  archivedList = false; $('filter').value = '';
  collapsedProjects.delete(projectId);
  await openSession({ ...session, status: 'draft' });
  await refreshSessions();
}

async function showWelcome(): Promise<void> {
  await leaveView();
  settingsView.close(); showingSettings = false;
  await preparation.close();
  await composer.select('');
  selected = null;
  workspacePane.select('');
  terminalPicker.update([]); terminalPicker.show('');
  terminal?.dispose(); terminal = null; fit = null;
  sessionSplit.setEnabled(false);
  $('session-view').hidden = true;
  $('welcome').hidden = false;
  heading('Your workspace', 'bbflow');
  showWorkspace('A home for your terminal sessions.');
  $('status').hidden = true;
  history.replaceState(null, '', homePath);
  renderSessions();
}

async function showSettings(): Promise<void> {
  await leaveView();
  await settingsView.open();
  showingSettings = true;
  workspacePane.select('');
  $('session-view').hidden = $('welcome').hidden = true;
  heading('Settings');
  showWorkspace('Defaults and tools for this instance');
  $('status').hidden = true;
  history.replaceState(null, '', settingsPath);
}

function showProject(project: Project | null = null) {
  editingProject = project;
  $('project-title').textContent = project ? 'Edit project' : 'Add project';
  $('project-name').value = project?.name ?? '';
  $('project-name').required = !!project;
  $('project-name-hint').hidden = !!project;
  $('project-workspace').value = project?.workspace ?? '';
  $('project-workspace').required = !project;
  $('project-folder').hidden = !!project;
  $('project-remove').hidden = $('project-remove-help').hidden = !project;
  $('project-error').hidden = true;
  $('project-submit').textContent = project ? 'Save name' : 'Add project';
  showDialog($('project-dialog'));
}

// Archive or restore a session. The selected session first saves its launch choices and
// message editor. Its view then closes, or opens in the normal list after a restore.
async function setArchived(id: string, archived: boolean): Promise<void> {
  if (!server) return;
  const current = selected?.id === id ? selected : null;
  if (current) {
    await preparation.flush();
    await composer.flush();
  }
  await call(server, { operation: 'session-archive', session: id, archived });
  if (current) {
    current.archived = archived;
    if (archived) await showWelcome();
    else {
      archivedList = false; $('filter').value = '';
      collapsedProjects.delete(current.projectId ?? '');
      await openSession(current);
    }
  }
  await refreshSessions();
  notice(archived ? 'Session archived. Find it in Archived and restore it any time.' : 'Session restored.');
}

async function initialize() {
  systemDark.addEventListener('change', updateTerminalTheme);
  controls();
  $('archive-session').onclick = () => action(async () => {
    if (selected?.id) await setArchived(selected.id, !selected.archived);
  });
  $('archives-open').onclick = () => action(async () => {
    archivedList = !archivedList;
    await refreshSessions();
  });
  $('sessions-open').onclick = () => action(async () => {
    archivedList = false;
    await refreshSessions();
  });
  $('home-link').onclick = event => {
    // Keep a plain click in this page so drafts save. Let modified clicks open a new tab.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void action(showWelcome);
  };
  $('settings-open').onclick = () => action(showSettings);
  $('settings-close').onclick = () => action(async () => {
    settingsView.close(); showingSettings = false;
    if (selected) await openSession(selected);
    else await showWelcome();
  });
  $('remove-worktree').onclick = () => action(async () => {
    if (!server || !selected?.id) return;
    await call(server, { operation: 'worktree-remove', session: selected.id });
    await refreshSessions();
    notice('Worktree removed. Its branch and session history are preserved.');
  });
  $('add-project').onclick = () => showProject();
  $('cancel-project').onclick = () => $('project-dialog').close();
  $('project-form').onsubmit = event => {
    event.preventDefault();
    action(async () => {
      if (!server) return;
      const project = editingProject;
      try {
        if (project) await call(server, { operation: 'project-rename', project: project.id, name: $('project-name').value });
        else {
          await call(server, { operation: 'project-add', name: $('project-name').value, workspace: $('project-workspace').value.trim() });
          // The archived list shows only groups with archived sessions. Show the new project.
          archivedList = false;
        }
        $('project-dialog').close();
        await refreshSessions();
      } catch (error) {
        $('project-error').textContent = errorMessage(error);
        $('project-error').hidden = false;
      }
    });
  };
  $('project-remove').onclick = () => action(async () => {
    if (!server || !editingProject) return;
    try {
      await preparation.flush();
      await composer.flush();
      await call(server, { operation: 'project-remove', project: editingProject.id });
      $('project-dialog').close();
      await refreshSessions();
      if (selected?.projectId === editingProject.id) await openSession(selected);
      notice('Project removed. Its sessions are now under Standalone. Files and running sessions are unchanged.');
    } catch (error) {
      $('project-error').textContent = errorMessage(error);
      $('project-error').hidden = false;
    }
  });
  $('rename-session').onclick = () => {
    // An empty title removes the user title. The session then shows its derived title.
    $('rename-name').value = selected?.title ?? '';
    $('rename-name').placeholder = selected?.autoTitle || 'Untitled session';
    $('rename-error').hidden = true;
    showDialog($('rename-dialog'));
  };
  $('copy-session-id').onclick = () => action(async () => {
    if (!selected?.id) return;
    await navigator.clipboard.writeText(selected.id);
    notice('Session ID copied.');
  });
  $('cancel-rename').onclick = () => $('rename-dialog').close();
  $('rename-form').onsubmit = event => {
    event.preventDefault();
    action(async () => {
      if (!server || !selected?.id) return;
      try {
        await call(server, { operation: 'session-rename', session: selected.id, name: $('rename-name').value });
        selected.title = $('rename-name').value.trim();
        $('rename-dialog').close();
        await refreshSessions();
      } catch (error) {
        $('rename-error').textContent = errorMessage(error);
        $('rename-error').hidden = false;
      }
    });
  };
  $('history-open').onclick = () => historySearch.open({
    ...(selected?.id ? { session: selected.id, title: sessionTitle(selected) } : {}),
    ...(selected?.projectId ? { project: selected.projectId, projectName: projects.find(project => project.id === selected?.projectId)?.name || 'This project' } : {}),
  });
  window.addEventListener('keydown', event => {
    if ((!event.metaKey && !event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'f') return;
    if (document.querySelector('dialog[open]') || $('history-open').disabled) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) $('history-open').click();
  }, true);
  $('filter').oninput = () => {
    // Invalidate pending results before the debounce delay ends.
    refreshGeneration++;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { void refreshSessions(); }, 200);
  };
  $('reconnect').onclick = $('reload-output').onclick = () => action(async () => { if (selected) await openSession(selected); });
  $('continue-session').onclick = () => action(showContinue);
  $('handoff-open').onclick = () => action(async () => {
    if (!selected?.id) return;
    await loadHandoff(selected.id);
    if (handoff?.session === selected.id && handoff.info.available) handoffPrompt.open(handoff.info);
    else notice('The handoff folder of this session is not available. Continue in a new terminal to write it again.');
  });
  $('cancel-continue').onclick = () => $('continue-dialog').close();
  $('continue-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('continue-prompt').value);
      $('continue-copy').textContent = 'Copied';
    } catch (error) {
      $('continue-error').textContent = `Cannot copy the prompt: ${errorMessage(error)}`;
      $('continue-error').hidden = false;
    }
  };
  $('continue-form').onsubmit = event => {
    event.preventDefault();
    action(async () => {
      // action checks the dialog against the latest session state before submit.
      if (!$('continue-dialog').open || !selected?.id) return;
      const tool = $('continue-tool').value;
      $('continue-dialog').close();
      await openSession(selected, { kind: 'continue', tool });
    });
  };
  $('stop').onclick = () => action(async () => {
    if (!server || !selected?.id || terminalPicker.shownRun) return;
    const { stopped } = await call(server, { operation: 'session-stop', session: selected.id });
    if (stopped) {
      selected.status = 'ended';
      notice('Session stopped. Terminal output is saved.');
    } else {
      notice('The session has no live terminal. Nothing was stopped.');
    }
    // A view of an earlier terminal gets no exit message. The refresh reads the stored
    // status of the stopped run.
    await refreshSessions();
    if (stopped) showStatus();
    await loadTerminals(selected.id);
  });
  new ResizeObserver(requestFit).observe($('terminal'));
  window.addEventListener('pagehide', () => connection?.close());
  try {
    const response = await fetch('/client-config', { cache: 'no-store' });
    if (!response.ok) throw new Error('Cannot read the local server configuration.');
    const info = await response.json() as ServerInfo;
    if (info.protocol !== VERSION) throw new Error('Unsupported server protocol. Rebuild and restart bbflow.');
    server = info;
    $('instance-dir').textContent = server.dataDir;
    $('instance-dir').title = server.dataDir;
    await refreshSessions();
    watchStatuses(info);
    const route = parseRoute(location.pathname);
    if (route.page === 'settings') await action(showSettings);
    else if (route.page === 'session') await action(() => openSession(sessions.find(s => s.id === route.id) || { id: route.id, title: 'Session', workspace: '', status: 'unknown' }));
    setInterval(() => {
      if (document.hidden || busy) return;
      refreshSessions();
      // A new terminal has no run until its process starts. Read the list again until then.
      if (selected?.id && terminalPicker.starting()) void loadTerminals(selected.id);
    }, 5000);
  } catch (error) {
    server = null;
    showConnection(false);
    notice(errorMessage(error));
  }
  controls();
}

window.addEventListener('DOMContentLoaded', initialize);
