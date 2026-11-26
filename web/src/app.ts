import { call, errorMessage, sessionTitle, VERSION } from './protocol.js';
import type { Handoff, PreparedSession, Project, Preparation, Run, TerminalInfo, Tool, Worktree, ServerInfo, SessionInfo, Size, StreamRequest } from './protocol.js';
import { HandoffPrompt } from './handoff-prompt.js';
import { ComposerMenu } from './composer-menu.js';
import { HistorySearch } from './history-search.js';
import { DiffPane } from './diff-pane.js';
import { SideTerminal } from './side-terminal.js';
import { WorkspacePane } from './workspace-pane.js';
import { fillToolMenu, toolGroups } from './tool-menu.js';
import { UsageDialog } from './usage.js';
import { continueAction, continueDialogError, continueDialogProblem, defaultContinueTool } from './continue.js';
import { endReasonText, exitReason, hasTerminal, listStatus, listStatusLabel, listStatusText, live, statusIcon, statusText, stopMembers, stopShows, stopText, terminalsChanged } from './session-status.js';
import type { EndReason } from './session-status.js';
import { Watch } from './watch.js';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { element } from './dom.js';
import { Composer } from './composer.js';
import { ActionMenu } from './action-menu.js';
import { RowMenus } from './row-menu.js';
import type { RowAction } from './row-menu.js';
import { SessionSplit } from './session-split.js';
import { followKeyboard, keyboardShown } from './keyboard.js';
import { followCursor, showCursor } from './terminal-clip.js';
import { fitEndedRows } from './ended-fit.js';
import { touchScroll } from './terminal-touch.js';
import { hiddenSize, smallestSize, terminalSize } from './terminal-size.js';
import { fitSize } from './terminal-fit.js';
import { onTerminalInput } from './terminal-input.js';
import { Sidebar, mobileQuery, nearestRow } from './sidebar.js';
import { FileListWidth } from './file-list-width.js';
import { familyGroup, mergeSessions, pinLimit, pinnedGroup, placeText, sessionGroups, sessionWindow, shownChildren, welcomeText } from './projects.js';
import type { Family } from './projects.js';
import { SessionConnection } from './session-connection.js';
import { PreparationEditor } from './preparation.js';
import { launchCommand, ModelPicker, typed } from './model-choice.js';
import { SettingsView } from './settings.js';
import { UpdatePanel } from './update.js';
import { ErrorToasts } from './toasts.js';
import { pageBar } from './page-bar.js';
import { TerminalPicker, earlierHint } from './terminal-picker.js';
import { MessageNav } from './message-nav.js';
import { MessageJump } from './message-jump.js';
import { stepShortcut } from './message-marks.js';
import { SentHistory } from './sent-history.js';
import { homePath, parseRoute, sessionURL, settingsPath } from './route.js';
import { DialogEdits, lastReload, onServerReplaced, recordReload, reloadPlan, restartedMessage } from './restart.js';

const elements = {
  'history-open': element('history-open', HTMLButtonElement),
  'home-link': element('home-link', HTMLAnchorElement),
  'sessions-open': element('sessions-open', HTMLButtonElement),
  'archives-open': element('archives-open', HTMLButtonElement),
  'archived-heading': element('archived-heading', HTMLElement),
  'archive-session': element('archive-session', HTMLButtonElement),
  'pin-session': element('pin-session', HTMLButtonElement),
  'settings-open': element('settings-open', HTMLButtonElement),
  'usage-open': element('usage-open', HTMLButtonElement),
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
  'project-folder-view': element('project-folder-view', HTMLElement),
  'project-folder-path': element('project-folder-path', HTMLElement),
  'project-help': element('project-help', HTMLElement),
  'project-error': element('project-error', HTMLElement),
  'project-submit': element('project-submit', HTMLButtonElement),
  'cancel-project': element('cancel-project', HTMLButtonElement),
  'remove-project-dialog': element('remove-project-dialog', HTMLDialogElement),
  'remove-project-form': element('remove-project-form', HTMLFormElement),
  'remove-project-summary': element('remove-project-summary', HTMLElement),
  'remove-project-folder': element('remove-project-folder', HTMLElement),
  'remove-project-error': element('remove-project-error', HTMLElement),
  'remove-project-submit': element('remove-project-submit', HTMLButtonElement),
  'cancel-remove-project': element('cancel-remove-project', HTMLButtonElement),
  'row-menu-status': element('row-menu-status', HTMLElement),
  'rename-session': element('rename-session', HTMLButtonElement),
  'new-sub-session': element('new-sub-session', HTMLButtonElement),
  'archive-dialog': element('archive-dialog', HTMLDialogElement),
  'archive-form': element('archive-form', HTMLFormElement),
  'archive-summary': element('archive-summary', HTMLElement),
  'archive-members': element('archive-members', HTMLElement),
  'archive-error': element('archive-error', HTMLElement),
  'archive-submit': element('archive-submit', HTMLButtonElement),
  'stop-dialog': element('stop-dialog', HTMLDialogElement),
  'stop-form': element('stop-form', HTMLFormElement),
  'stop-title': element('stop-title', HTMLElement),
  'stop-summary': element('stop-summary', HTMLElement),
  'stop-members': element('stop-members', HTMLElement),
  'stop-note': element('stop-note', HTMLElement),
  'stop-error': element('stop-error', HTMLElement),
  'stop-submit': element('stop-submit', HTMLButtonElement),
  'cancel-stop': element('cancel-stop', HTMLButtonElement),
  'cancel-archive': element('cancel-archive', HTMLButtonElement),
  'copy-session-id': element('copy-session-id', HTMLButtonElement),
  'rename-dialog': element('rename-dialog', HTMLDialogElement),
  'rename-form': element('rename-form', HTMLFormElement),
  'rename-name': element('rename-name', HTMLInputElement),
  'rename-error': element('rename-error', HTMLElement),
  'rename-submit': element('rename-submit', HTMLButtonElement),
  'cancel-rename': element('cancel-rename', HTMLButtonElement),
  'page-bar': element('page-bar', HTMLElement),
  'page-bar-text': element('page-bar-text', HTMLElement),
  'page-bar-reload': element('page-bar-reload', HTMLButtonElement),
  'list-problem': element('list-problem', HTMLElement),
  'stop-session': element('stop-session', HTMLButtonElement),
  'menu-continue': element('menu-continue', HTMLButtonElement),
  'menu-continue-problem': element('menu-continue-problem', HTMLElement),
  'reconnect': element('reconnect', HTMLButtonElement),
  'continue-action': element('continue-action', HTMLElement),
  'continue-session': element('continue-session', HTMLButtonElement),
  'continue-unavailable': element('continue-unavailable', HTMLElement),
  'continue-dialog': element('continue-dialog', HTMLDialogElement),
  'continue-form': element('continue-form', HTMLFormElement),
  'continue-workspace': element('continue-workspace', HTMLElement),
  'continue-tool': element('continue-tool', HTMLSelectElement),
  'continue-model': element('continue-model', HTMLSelectElement),
  'continue-model-other': element('continue-model-other', HTMLInputElement),
  'continue-effort': element('continue-effort', HTMLSelectElement),
  'continue-command': element('continue-command', HTMLElement),
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
  'workspace-warning': element('workspace-warning', HTMLButtonElement),
  'terminal': element('terminal', HTMLElement),
  'status': element('status', HTMLElement),
  'terminal-hint': element('terminal-hint', HTMLElement),
  'terminal-announce': element('terminal-announce', HTMLElement),
  'welcome': element('welcome', HTMLElement),
  'welcome-text': element('welcome-text', HTMLElement),
  'session-view': element('session-view', HTMLElement),
  'instance-dir': element('instance-dir', HTMLElement),
};

const $ = <K extends keyof typeof elements>(id: K): typeof elements[K] => elements[id];

interface SessionView {
  archived?: boolean;
  pinned?: boolean;
  preparation?: Preparation;
  worktree?: Worktree;
  run?: Run;
  projectId?: string;
  // The top-level session of a sub-session, or empty.
  parentId?: string;
  id?: string;
  title: string;
  autoTitle?: string;
  workspace: string;
  status: string;
}

// start claims a prepared draft. continue starts a new terminal in an ended session.
type Launch = { kind: 'start' } | { kind: 'continue'; tool: string; model: string; effort: string };

let server: ServerInfo | null = null;
let connection: SessionConnection | null = null;
let terminal: Terminal | null = null;
const systemDark = matchMedia('(prefers-color-scheme: dark)');
let sessions: SessionInfo[] = [];
// The status of each session that has a live terminal, from the status watch.
let liveStatuses: Record<string, string> = {};
// The count of title changes from the status watch.
let titleRevision = 0;
let projects: Project[] = [];
let editingProject: Project | null = null;
// The project that the Remove project dialog asks about. keyboard is true when the user
// chose Remove project with the keyboard.
let removingProject: { project: Project; keyboard: boolean } | null = null;
const collapsedProjects = new Set<string>();
// The families that show all of their sub-sessions in this view until reload.
const shownFamilies = new Set<string>();
let renderedSidebar = '';
// The status elements of each session row in the list. A status change updates them in
// place, so the buttons and the keyboard focus stay. place tells where a sub-session
// works. The archive item and the ⋯ button of the row menu follow the status too. fixed
// is true when the menu has an item that applies in each status. Each stop item follows
// the statuses of the sessions that it stops. family is true for Stop family.
const statusMarks: { session: SessionInfo; button: HTMLElement; icon: HTMLElement; label: HTMLElement; place: string; archive: HTMLButtonElement; menu: HTMLButtonElement; fixed: boolean; stops: { item: HTMLButtonElement; members: SessionInfo[]; family: boolean }[] }[] = [];
let selected: SessionView | null = null;
let continueRun: string | undefined;
// The reason that the open Continue dialog shows for a session change, or empty.
let continueProblem = '';
// The tools that are on when the Continue dialog opened.
let continueTools: Tool[] = [];
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
const sessionStep = 5;
const groupLimits = { list: new Map<string, number>(), archived: new Map<string, number>() };
let moreGroups = new Set<string>();
const limits = () => archivedList ? groupLimits.archived : groupLimits.list;
// The ＋ menu of the message editor. Manage prompts opens the Prompts card of Settings.
// The menu comes before the editor, because the editor reports each change of its
// controls to it.
const composerMenu = new ComposerMenu({
  server: () => server,
  blocked: () => composer.insertBlocked(),
  insert: text => composer.insert(text),
  problem: text => composer.problem(text),
  manage: () => void action(async () => {
    await showSettings();
    settingsView.revealPrompts();
  }, 'Could not open Settings.'),
});
const composer = new Composer({
  server: () => server,
  peer: () => connection?.peer ?? null,
  bracketed: () => !!terminal?.modes.bracketedPasteMode,
  action,
  sent: () => messageNav.reload(),
  controls: () => composerMenu.update(),
});
const sessionSplit = new SessionSplit();
const sessionMenu = new ActionMenu('session-menu');
const rowMenus = new RowMenus(() => renderSessions(), $('row-menu-status'));
const usageDialog = new UsageDialog({ server: () => server });
const handoffPrompt = new HandoffPrompt({ blocked: () => composer.insertBlocked(), insert: text => composer.insert(text), problem: text => composer.problem(text) });
// A view shows one terminal of the selected session. Earlier terminals show their saved
// final screen. The live process continues while a view shows an earlier terminal.
const terminalPicker = new TerminalPicker({
  select: run => action(async () => { if (selected?.id) await openSession(selected, undefined, run); }, failed('show the terminal of', selected)),
  refresh: () => { if (selected?.id) void loadTerminals(selected.id); },
});
const historySearch = new HistorySearch(() => server);
const diffPane = new DiffPane(() => server);
// Copy path of the file menu joins this workspace and the relative path of the file.
diffPane.workspace = session => selected?.id === session ? selected.workspace : '';
const sideTerminal = new SideTerminal(() => server, terminalTheme);
// The bar above the session terminal and the Messages view show the same positions.
const messageNav: MessageNav = new MessageNav({
  server: () => server,
  color: markColor,
  // A narrow main area shows the workspace pane in place of the session.
  reveal: () => { if (!terminalShown()) workspacePane.close(); },
  list: () => workspacePane.show('messages'),
  // A move in the shown terminal stops a jump to another terminal that did not seek yet.
  moved: () => messageJump.cancel(),
  changed: () => sentHistory.mark(),
  sent: () => sentHistory.refresh(),
});
// A jump from the Messages view to a message in another terminal of the session.
const messageJump = new MessageJump({
  session: () => selected?.id ?? '',
  busy: () => busy,
  opens: () => opens,
  loadTerminals: id => loadTerminals(id),
  terminals: () => terminalPicker.all,
  shownRun: () => terminalPicker.shown()?.run ?? '',
  reveal: () => { if (!terminalShown()) workspacePane.close(); },
  async open(id, run) {
    let open = null as number | null;
    await action(async () => {
      if (selected?.id === id) open = await openSession(selected, undefined, run);
    }, failed('show the terminal of', selected));
    return open;
  },
  seek: revision => messageNav.seek(revision),
  readError: () => messageNav.readError,
  failed: (number, detail) => toasts.show(failed(number ? `show the message in terminal ${number} of` : 'show the message of', selected), detail),
});
const sentHistory: SentHistory = new SentHistory(() => server, {
  state: revision => messageNav.state(revision),
  go: revision => messageNav.go(revision),
  terminals: () => terminalPicker.all,
  shown: () => terminalPicker.shown(),
  open: (revision, target) => { void messageJump.show(revision, target); },
  unread: () => !!messageNav.readError,
  retry: revision => { void messageJump.retry(revision); },
});
const workspacePane = new WorkspacePane(diffPane, sideTerminal, sentHistory);
// The address tells the view before a session of the address is open.
const sidebar = new Sidebar(() => parseRoute(location.pathname).page === 'home');
const mobileLayout = matchMedia(mobileQuery);
new FileListWidth();

let showingSettings = false;
const settingsView = new SettingsView(() => server, updateTerminalTheme, (title, detail) => toasts.show(title, detail));
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
  }, failed('start', session)),
});

// The status watch sends the release check state of the server. The Updates card of
// Settings shows it. An update restarts the server, so save the drafts of this view
// first. The reload after the restart shows the new UI.
const updatePanel = new UpdatePanel({
  title(id) {
    const session = sessions.find(item => item.id === id);
    return session ? sessionTitle(session) || 'Untitled session' : undefined;
  },
  async start(offer) {
    if (!server) throw new Error('The server is not connected.');
    await preparation.flush();
    await composer.flush();
    await call(server, { operation: 'update-start', version: offer.available, revision: offer.revision });
  },
  async check() {
    if (!server) throw new Error('The server is not connected.');
    await call(server, { operation: 'update-check' });
  },
});

// Each message shows next to its subject. A failed action without such a place shows an
// error toast that names the action.
const toasts = new ErrorToasts();

// The page bar shows a restart of the server, or an update in progress from the status
// watch. Call this after either one changes.
let restarted = false;
function showPageBar() {
  const bar = pageBar(restarted, updatePanel.current);
  $('page-bar').hidden = !bar.text;
  $('page-bar').className = bar.kind;
  $('page-bar-text').textContent = bar.text;
  $('page-bar-reload').hidden = !bar.reload;
}

// The sidebar tells when the session list cannot load. An empty text removes the problem.
function listProblem(text = '') {
  $('list-problem').textContent = text;
  $('list-problem').hidden = !text;
}

// The title of the error toast of a failed action on a session.
function failed(what: string, session?: { title: string; autoTitle?: string } | null): string {
  return session ? `Could not ${what} “${sessionTitle(session) || 'Untitled session'}”.` : `Could not ${what}.`;
}

// These dialogs keep their text only until submission. A reload would discard it.
const dialogEdits = new DialogEdits([
  { dialog: $('project-dialog'), fields: [$('project-name'), $('project-workspace')] },
  { dialog: $('rename-dialog'), fields: [$('rename-name')] },
  { dialog: $('continue-dialog'), fields: [$('continue-tool'), $('continue-model'), $('continue-model-other'), $('continue-effort')] },
]);
const dialogErrors = new Map([
  [$('project-dialog'), $('project-error')],
  [$('remove-project-dialog'), $('remove-project-error')],
  [$('archive-dialog'), $('archive-error')],
  [$('stop-dialog'), $('stop-error')],
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
  restarted = true;
  showPageBar();
  // The page bar tells the user to reload, so the list does not repeat it.
  listProblem();
  // A modal dialog covers the page bar. Show the message in the dialog too.
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

// Return the tool of the shown terminal. Each terminal records its own tool, so a new
// terminal can show another tool than the first one. A draft has no terminal yet. While
// the terminal list is not loaded, or when it cannot load, the tool is unknown. The
// tool of the first start would then be wrong after a continue with another tool.
function shownTool(): string {
  if (!selected || showingSettings || selected.status === 'draft') return '';
  return terminalPicker.shown()?.tool ?? '';
}

// The server sends a start warning only to the view that started the session, such as a
// base fetch that failed. This page keeps it for each session until the page reloads.
const startWarnings = new Map<string, string>();

// Show the tool of the shown terminal, the worktree branch, and the workspace path. An
// empty path hides the line. A start warning of the session shows as a mark at the end.
function showWorkspace(path: string, worktree?: Worktree) {
  const tool = shownTool();
  const branch = worktree ? `⑂ ${worktree.branch}` : '';
  const removed = worktree?.state === 'removed';
  const label = [tool, removed ? '' : branch, path].filter(Boolean).join(' · ');
  $('workspace').hidden = !path;
  $('workspace-path').textContent = label;
  $('workspace-removed').hidden = !removed;
  $('workspace').title = removed ? `${label} · ${branch}` : label;
  const warning = path && !removed && selected?.id ? startWarnings.get(selected.id) ?? '' : '';
  const mark = $('workspace-warning');
  mark.hidden = !warning;
  mark.dataset.tip = warning;
  mark.setAttribute('aria-label', `Start warning: ${warning}`);
  if (!warning) mark.classList.remove('tip-open');
}

// The hint below the terminal tells why this view cannot send input. A view of the live
// terminal has no hint. An error or information hint has its own color.
function hint(text = '', kind: '' | 'error' | 'info' = '') {
  $('terminal-hint').textContent = text;
  $('terminal-hint').hidden = !text;
  $('terminal-hint').className = kind;
  // The focus can stay in the terminal, so a screen reader also announces an error or
  // information hint. The live region always exists, so that a change is announced.
  $('terminal-announce').textContent = kind ? text : '';
}

function controls() {
  $('history-open').disabled = busy || !server;
  preparation.controls(busy, !!selected?.archived);
  $('sessions-open').disabled = $('archives-open').disabled = busy || !server;
  $('archive-session').hidden = showingSettings || !selected?.id || live(selected.status);
  $('archive-session').disabled = busy;
  $('archive-session').textContent = selected?.archived ? 'Restore' : 'Archive';
  // Only a top-level session outside Archived can have a pin.
  $('pin-session').hidden = showingSettings || !selected?.id || !!selected.parentId || !!selected.archived;
  $('pin-session').disabled = busy;
  $('pin-session').textContent = selected?.pinned ? 'Unpin' : 'Pin';
  if (!showingSettings && selected?.status === 'draft') $('status').textContent = selected.archived ? 'Draft · Archived' : 'Draft';
  $('settings-open').disabled = $('usage-open').disabled = busy || !server;
  updatePanel.controls(busy || !server);
  $('settings-close').disabled = busy;
  composer.controls(busy, !!connection?.ready && !!connection.peer?.active);
  $('add-project').disabled = busy || !server;
  // Worktree creation shows as running, but only a terminal can stop or reconnect.
  const terminalLive = !!connection?.peer?.active || hasTerminal(selected);
  const shownRun = terminalPicker.shownRun;
  // Stop session ends the process at once, so it is the last item of the More menu, away
  // from the toolbar icons. The menu moves the focus to its first item when it opens.
  const stoppable = !showingSettings && terminalLive && !shownRun;
  $('stop-session').hidden = !stoppable;
  $('stop-session').disabled = busy;
  // In the mobile layout, the More menu also has Continue in new terminal. The toolbar
  // then keeps its room for the title.
  const mobile = mobileLayout.matches;
  // A view of an earlier terminal uses Back to live terminal instead. Only a live terminal
  // gets Reconnect. An ended terminal has no process to connect to.
  const connected = showingSettings || !selected || selected.status === 'draft' || !!connection?.peer?.active || !!shownRun;
  $('reconnect').hidden = connected || !terminalLive;
  $('reconnect').disabled = busy;
  const continuation = continueAction(selected, !!connection?.peer?.active, shownRun);
  const continueControl = $('continue-action');
  const continuable = !showingSettings && continuation.visible;
  continueControl.hidden = !continuable || mobile;
  $('menu-continue').hidden = !continuable || !mobile;
  $('continue-session').disabled = $('menu-continue').disabled = $('continue-submit').disabled = busy || !!continuation.problem;
  $('continue-unavailable').textContent = $('menu-continue-problem').textContent = continuation.problem;
  $('menu-continue-problem').hidden = $('menu-continue').hidden || !continuation.problem;
  if (continuation.problem) {
    continueControl.dataset.tip = continuation.problem;
    continueControl.tabIndex = 0;
  } else {
    delete continueControl.dataset.tip;
    continueControl.removeAttribute('tabindex');
  }
  // The session or the server changed while the dialog was open. The dialog then tells
  // why it cannot start a terminal, and its start button stays off. Cancel closes it.
  if ($('continue-dialog').open) {
    const next = continueDialogError({ text: $('continue-error').textContent ?? '', hidden: $('continue-error').hidden === true }, continueProblem,
      continueDialogProblem(continuation, selected?.run?.id, continueRun), restarted);
    $('continue-error').textContent = next.error.text;
    $('continue-error').hidden = next.error.hidden;
    continueProblem = next.shown;
    if (next.blocked) $('continue-submit').disabled = true;
  }
  $('handoff-open').hidden = showingSettings || !selected?.id || handoff?.session !== selected.id || !handoff.info.available;
  $('handoff-open').disabled = busy;
  composerMenu.controls();
  terminalPicker.controls(busy);
  $('project-submit').disabled = $('remove-project-submit').disabled = $('rename-submit').disabled = busy;
  $('rename-session').hidden = $('copy-session-id').hidden = showingSettings || !selected?.id || selected.status === 'draft';
  // A family has one level. On a sub-session, New sub-session adds one to the same parent.
  // A sub-session draft needs a saved project. The server checks the other rules too.
  const organize = !showingSettings && !!selected?.id && !selected.archived;
  $('new-sub-session').hidden = !organize || !projects.some(project => project.id === selected?.projectId);
  $('new-sub-session').textContent = selected?.parentId ? 'New sub-session in this family' : 'New sub-session';
  $('new-sub-session').disabled = $('archive-submit').disabled = $('stop-submit').disabled = busy;
  // The More menu lists only the actions that apply. A live session keeps its worktree.
  $('remove-worktree').hidden = showingSettings || !selected?.worktree || selected.worktree.state === 'removed' || live(selected.status);
  $('remove-worktree').disabled = $('rename-session').disabled = $('copy-session-id').disabled = busy;
  sessionMenu.controls();
  $('project-name').disabled = $('project-workspace').disabled = $('rename-name').disabled = busy;
  for (const button of $('sessions').querySelectorAll('button')) button.disabled = busy;
}

// failure is the title of the error toast when the work fails. It names the action.
async function action(work: () => Promise<unknown>, failure = 'The action failed.'): Promise<void> {
  if (busy) return;
  busy = true;
  controls();
  try { await work(); } catch (error) { toasts.show(failure, errorMessage(error)); }
  finally { busy = false; controls(); }
}

interface RowOptions {
  showWorkspace: boolean;
  // The project of a row in Pinned. The row shows its name below the title.
  projectName?: string;
  // The top-level session of a sub-session.
  parent?: SessionInfo;
  // The family of a top-level session.
  family?: Family;
}

// Places of a sub-session that get the worktree mark after its title.
const worktreePlaces = new Set(['own worktree', 'new worktree']);

// Return a list row with the session button and its row actions. A button cannot
// contain another button, so the row holds them all. The row has one line: a status
// icon, the title, and a worktree mark for a sub-session with its own worktree. The
// status text shows in the tooltip of the icon and in a label for screen readers.
function sessionRow(session: SessionInfo, options: RowOptions): HTMLElement {
  const { showWorkspace, projectName, parent, family } = options;
  const context = !!family?.context;
  const place = parent ? placeText(session, parent) : '';
  const button = document.createElement('button');
  button.className = 'session-item' + (selected?.id === session.id ? ' selected' : '');
  button.setAttribute('aria-current', selected?.id === session.id ? 'true' : 'false');
  button.dataset.focus = `session:${session.id}`;
  const line = document.createElement('span');
  line.className = 'session-line';
  const icon = document.createElement('span');
  const title = document.createElement('strong');
  title.textContent = sessionTitle(session) || (session.status === 'draft' ? 'Untitled draft' : 'Untitled session');
  line.append(icon, title);
  if (worktreePlaces.has(place)) {
    const mark = document.createElement('span');
    mark.className = 'worktree-mark';
    mark.textContent = '⑂';
    mark.title = place === 'new worktree' ? 'Starts in a new worktree' : 'Own worktree';
    mark.setAttribute('aria-hidden', 'true');
    line.append(mark);
  }
  const label = document.createElement('span');
  label.className = 'sr-only';
  button.append(line, label);
  if (context) {
    // The top-level session is in the other collection, or it does not match the search.
    const tag = document.createElement('small');
    tag.className = 'context-tag';
    tag.textContent = session.archived === archivedList ? 'Parent of a match' : session.archived ? 'Archived' : 'Not archived';
    button.append(tag);
  }
  if (projectName) {
    const project = document.createElement('small');
    project.textContent = projectName;
    button.append(project);
  } else if (showWorkspace) {
    const workspace = document.createElement('small');
    workspace.textContent = session.workspace;
    button.append(workspace);
  }
  button.onclick = () => action(() => openSession(session), failed('open', session));
  const row = document.createElement('div');
  row.className = 'session-row' + (parent ? ' sub-session' : '') + (context ? ' context' : '');
  row.append(button);
  // The ⋯ button opens the actions of the row, so one click never runs an action.
  const actions: RowAction[] = [];
  // A sub-session draft needs a saved project. A family has one level.
  const canAdd = !parent && !context && !archivedList && projects.some(project => project.id === session.projectId);
  if (canAdd) actions.push({ label: 'New sub-session', run: () => void action(() => showSubLaunch(session.id), failed('add a sub-session to', session)) });
  // Only a top-level session outside Archived can have a pin.
  const canPin = !parent && !context && !archivedList;
  if (canPin) actions.push({ label: session.pinned ? 'Unpin' : 'Pin', run: keyboard => void pinFromList(session, keyboard) });
  // A context row is not in this collection. Its own row in the other list changes it.
  const archive: RowAction = { label: session.archived ? 'Restore' : 'Archive', run: keyboard => void archiveFromList(session, keyboard) };
  if (!context) actions.push(archive);
  // A stop ends a process, so the stop items are the last items, below a line. Stop
  // session stops the session of the row only. Stop family stops a top-level session and
  // its sub-sessions. Archived sessions have no live terminal.
  const stops: { action: RowAction; members: SessionInfo[]; family: boolean }[] = [];
  if (!context && !archivedList) {
    stops.push({ action: { label: 'Stop session', danger: true, divider: true, run: keyboard => void action(() => showStop(session, false, keyboard), failed('stop', session)) }, members: [session], family: false });
    if (!parent && family?.children.length) {
      stops.push({ action: { label: 'Stop family', danger: true, run: keyboard => void action(() => showStop(session, true, keyboard), failed('stop the family of', session)) }, members: [family.root, ...family.children], family: true });
    }
  }
  actions.push(...stops.map(stop => stop.action));
  const mark = { session, button, icon, label, place };
  if (actions.length) {
    const menu = rowMenus.create(title.textContent, `menu:${session.id}`, actions);
    row.append(menu.box);
    if (!context) {
      statusMarks.push({
        ...mark, archive: menu.items[actions.indexOf(archive)]!, menu: menu.button, fixed: canAdd || canPin,
        stops: stops.map(stop => ({ item: menu.items[actions.indexOf(stop.action)]!, members: stop.members, family: stop.family })),
      });
    }
  }
  // A context row is not in the status watch of this list. It shows the listed status.
  if (context) showRowStatus(mark, session.status);
  return row;
}

// Show a status on the icon, the tooltips, and the screen reader label of a row.
function showRowStatus(mark: { session: SessionInfo; button: HTMLElement; icon: HTMLElement; label: HTMLElement; place: string }, status: string): void {
  const { session, button, icon, label, place } = mark;
  const className = `status-icon ${statusIcon(status, session.runStatus)}`;
  const text = listStatusText(status, session, place);
  if (icon.className !== className) icon.className = className;
  if (icon.title !== text) icon.title = text;
  const tip = `${sessionTitle(session)}\n${text}\n${session.workspace}\n${session.id}\n${session.updated}`;
  if (button.title !== tip) button.title = tip;
  const spoken = `, ${listStatusLabel(status, session, place)}`;
  if (label.textContent !== spoken) label.textContent = spoken;
}

// Return a family: the row of its top-level session, then the rows of its sub-sessions.
// A family is always open. After the first sub-sessions, Show more shows the others in
// this view. The top-level row shows the workspace in Standalone. In Pinned, it shows the
// project name, or the workspace without a saved project.
function familyBlock(family: Family, showWorkspace: boolean, pinned = false): HTMLElement {
  const block = document.createElement('div');
  block.className = 'family';
  const project = pinned ? projects.find(item => item.id === family.root.projectId) : undefined;
  block.append(sessionRow(family.root, { showWorkspace: showWorkspace || (pinned && !project), ...(project ? { projectName: project.name } : {}), family }));
  if (!family.children.length) return block;
  const id = family.root.id;
  const all = !!$('filter').value.trim() || shownFamilies.has(id);
  const { shown, hidden } = shownChildren(family.children, all, selected?.id);
  const list = document.createElement('div');
  list.id = `family-${id}`;
  list.className = 'family-children';
  for (const child of shown) list.append(sessionRow(child, { showWorkspace: false, parent: family.root }));
  if (hidden) {
    const row = document.createElement('div');
    row.className = 'session-row family-more-row';
    const more = document.createElement('button');
    more.className = 'family-more';
    more.textContent = `Show ${hidden} more`;
    more.setAttribute('aria-label', `Show ${hidden} more sub-sessions of ${sessionTitle(family.root) || 'this session'}`);
    more.dataset.focus = `family-more:${id}`;
    more.onclick = () => {
      // A keyboard user continues at the first sub-session that was hidden.
      const keyboard = document.activeElement === more;
      const next = family.children.find(child => !shown.includes(child));
      shownFamilies.add(id);
      renderSessions();
      if (keyboard && next) focusSidebar(`session:${next.id}`);
    };
    row.append(more);
    list.append(row);
  }
  block.append(list);
  return block;
}

// Archive or restore a session from its row menu. The row leaves the list. A keyboard user
// then gets the nearest session row that shows, or else a sidebar control.
async function archiveFromList(session: SessionInfo, keyboard: boolean): Promise<void> {
  const before = shownSessionKeys();
  await action(() => requestArchive(session, !session.archived), failed(session.archived ? 'restore' : 'archive', session));
  if (!keyboard || (document.activeElement && document.activeElement !== document.body)) return;
  const key = nearestRow(before, `session:${session.id}`, shownSessionKeys());
  if (key) focusSidebar(key);
  else (archivedList ? $('sessions-open') : $('filter')).focus();
}

// Pin or unpin a session from its row menu. The row moves between Pinned and its project
// group. A keyboard user keeps the focus on the menu button of the row in its new place.
// An unpinned family that is older than the shown families of its group is not in the
// list. The focus then moves to the nearest session row that shows, as after an archive.
async function pinFromList(session: SessionInfo, keyboard: boolean): Promise<void> {
  const before = shownSessionKeys();
  await action(() => setPinned(session, !session.pinned), failed(session.pinned ? 'unpin' : 'pin', session));
  if (!keyboard || (document.activeElement && document.activeElement !== document.body)) return;
  // The row can move out of the visible part of the list, so scroll to the focus.
  focusSidebar(`menu:${session.id}`, true);
  if (document.activeElement instanceof HTMLElement && document.activeElement.dataset.focus === `menu:${session.id}`) return;
  const key = nearestRow(before, `session:${session.id}`, shownSessionKeys());
  if (key) focusSidebar(key, true);
  else $('filter').focus();
}

// Pin or unpin a session. A pin opens Pinned, and an unpin opens the group of the project,
// so the user sees where the family went.
async function setPinned(session: { id: string; projectId?: string }, pinned: boolean): Promise<void> {
  if (!server) return;
  await call(server, { operation: 'session-pin', session: session.id, pinned });
  if (selected?.id === session.id) selected.pinned = pinned;
  collapsedProjects.delete(pinned ? pinnedGroup : groupKey(session.projectId));
  await refreshSessions();
}

// Return the focus keys of the session rows that show. A collapsed group hides its rows.
function shownSessionKeys(): string[] {
  return [...$('sessions').querySelectorAll<HTMLElement>('.session-item')]
    .filter(item => item.getClientRects().length)
    .map(item => item.dataset.focus!);
}

// Return the status of a session in the list. A live view and the status watch get
// status changes at once. The list is older.
function rowStatus(session: SessionInfo): string {
  return connection?.peer?.active && selected?.id === session.id ? selected.status : listStatus(session, liveStatuses);
}

// Show the current status of each session in the list, without new buttons.
function showListStatuses() {
  for (const mark of statusMarks) {
    const shown = rowStatus(mark.session);
    showRowStatus(mark, shown);
    // The server archives only drafts and ended sessions. See stopShows for the stop
    // items. A menu without items does not show its button.
    mark.archive.hidden = live(shown);
    for (const stop of mark.stops) stop.item.hidden = !stopShows(stop.members.map(member => ({ ...member, status: rowStatus(member) })), stop.family);
    mark.menu.hidden = !mark.fixed && mark.archive.hidden && mark.stops.every(stop => stop.item.hidden);
  }
}

function renderSessions() {
  const query = $('filter').value.toLowerCase();
  // A status is not part of the fingerprint. A status change must not replace the buttons.
  const fingerprint = JSON.stringify([projects, sessions, query, archivedList, [...moreGroups], selected?.id, showingSettings, [...collapsedProjects], [...shownFamilies]]);
  // An open row menu keeps the buttons of the list. Its close renders the list again.
  if (fingerprint === renderedSidebar || rowMenus.open) { showListStatuses(); controls(); return; }
  renderedSidebar = fingerprint;
  $('welcome-text').textContent = welcomeText(projects);
  // New buttons replace the list. Give the keyboard focus to the new button of the same item.
  const focused = document.activeElement instanceof HTMLElement && $('sessions').contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
  statusMarks.length = 0;
  $('sessions').replaceChildren();
  $('archives-open').setAttribute('aria-pressed', String(archivedList));
  $('archived-heading').hidden = !archivedList;
  $('sessions').setAttribute('aria-label', archivedList ? 'Archived sessions' : 'Projects and sessions');
  $('filter').placeholder = archivedList ? 'Search archived sessions…' : 'Search names and folders…';
  const groups = sessionGroups(projects, sessions, query, archivedList).filter(group => !archivedList || group.families.length);
  for (const group of groups) {
    const project = group.project;
    const id = group.pinned ? pinnedGroup : project?.id ?? '';
    const name = group.pinned ? 'Pinned' : project?.name ?? 'Standalone';
    const section = document.createElement('section');
    section.className = 'project-group' + (group.pinned ? ' pinned-group' : '');
    const heading = document.createElement('div');
    heading.className = 'project-heading';
    const toggle = document.createElement('button');
    toggle.className = 'project-toggle';
    const label = document.createElement('span');
    label.className = 'project-name';
    label.textContent = name;
    label.title = group.pinned ? 'Pinned sessions of all projects' : project?.workspace ?? 'Sessions without a saved project';
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
      add.onclick = () => action(() => showLaunch(project.id), `Could not add a draft to ${name}.`);
      heading.append(add);
      // The ⋯ button opens the actions of the project, so one click never removes it.
      const menu = rowMenus.create(name, `project-menu:${id}`, [
        { label: 'Edit', run: () => showProject(project) },
        { label: 'Copy folder path', run: () => void copyFolder(project) },
        { label: 'Search this project', run: () => historySearch.open({ project: project.id, projectName: name }, 'project') },
        { label: 'Remove project', danger: true, divider: true, run: keyboard => showRemoveProject(project, keyboard) },
      ], { className: 'project-action', text: '⋯' });
      heading.append(menu.box);
    }
    for (const family of group.families) list.append(familyBlock(family, !project && !group.pinned, group.pinned));
    if (moreGroups.has(id)) {
      const more = document.createElement('button');
      more.className = 'project-more';
      more.textContent = 'Show more';
      more.title = `Show ${sessionStep} more families of ${name}`;
      more.dataset.focus = `more:${id}`;
      more.onclick = async () => {
        // A busy action disables the sidebar buttons, and a disabled button loses the focus.
        // Thus give the focus back after the action.
        const keyboard = document.activeElement === more;
        await action(async () => {
          limits().set(id, (limits().get(id) ?? sessionStep) + sessionStep);
          await refreshSessions();
        }, `Could not show more sessions of ${name}.`);
        if (keyboard && (document.activeElement === document.body || !document.activeElement)) focusSidebar(more.dataset.focus!);
      };
      list.append(more);
    }
    if (!group.families.length) {
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
    empty.textContent = archivedList ? 'No archived sessions found.' : query.trim() ? 'No matching projects or sessions.' : 'No projects yet. Click ＋ Project to add a folder.';
    $('sessions').append(empty);
  }
  showListStatuses();
  if (focused) focusSidebar(focused);
  controls();
}

// Give the keyboard focus to the sidebar button with this focus key. Show more is not there
// after a group shows all of its sessions. Then its key selects the last session of the group.
// A list refresh keeps the scroll position. reveal scrolls the list to the button, for a
// row that an action moved to another group.
function focusSidebar(key: string, reveal = false): void {
  const target = [...$('sessions').querySelectorAll<HTMLElement>('[data-focus]')].find(button => button.dataset.focus === key)
    ?? (key.startsWith('more:') ? [...document.getElementById(`project-sessions-${key.slice(5) || 'standalone'}`)?.querySelectorAll<HTMLElement>('.session-item') ?? []].at(-1) : undefined);
  target?.focus({ preventScroll: true });
  if (reveal) target?.scrollIntoView({ block: 'nearest' });
}

// Expand the group that shows the family of a session in the list: Pinned for a pinned
// family, or else the group of its project. Call it after a refresh, which lists the
// family of the selected session.
function revealFamily(id: string): void {
  const session = sessions.find(item => item.id === id);
  const root = session?.parentId ? sessions.find(item => item.id === session.parentId) : session;
  if (!root) return;
  const known = new Set(projects.map(project => project.id));
  if (collapsedProjects.delete(familyGroup(root, known, archivedList))) renderSessions();
}

// Show brief activity of each session in the list. The list refresh is too slow for it.
function watchStatuses(info: ServerInfo) {
  new Watch(info, { operation: 'status-watch' }, {
    message(message) {
      if (message.type !== 'statuses') return;
      const next = message.statuses ?? {};
      const changed = terminalsChanged(liveStatuses, next);
      // Another view can start or end a terminal of the selected session. Then read its
      // terminals again, so the Messages view names the terminal of each message.
      const id = selected?.id;
      if (id && (id in liveStatuses) !== (id in next)) void loadTerminals(id);
      liveStatuses = next;
      // The update dialog counts the live sessions of the same message as the offer.
      updatePanel.show(message.release, Object.keys(next));
      showPageBar();
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
      updatePanel.lost();
      showPageBar();
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
    // Pinned has at most pinLimit families, so one request reads the whole group. Archived
    // ignores pins.
    const groups = ['', ...nextProjects.map(project => project.id)];
    const batch = sessionWindow / sessionStep;
    const recentReads = archivedList ? [] : [call(server, { operation: 'session-list', limit: pinLimit, groups: [pinnedGroup], ...filter })];
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
    const merged = mergeSessions(projects, recent, nextWindows, sessionStep, archivedList);
    sessions = merged.sessions;
    moreGroups = new Set(merged.more);
    updatePanel.sessionsChanged();
    // An open draft editor keeps the other fields of the selected session. Another view can
    // still archive, restore, pin, or unpin it, and the toolbar shows these changes.
    if (detail && selected && selected.id === selectedId) {
      selected.archived = detail.archived;
      selected.pinned = detail.pinned;
    }
    showConnection(true);
    listProblem();
    if (selected && !showingSettings && !preparation.visible) {
      if (detail && selected.id === detail.id) {
        // The status watch misses a terminal that another view started and that ended
        // within one status message. A new latest run here reads the terminal list again.
        const latest = terminalPicker.all.at(-1);
        if (!opening && detail.run?.id && latest?.run && latest.run !== detail.run.id) void loadTerminals(detail.id);
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
    if (!restarted) listProblem(`Cannot load the session list. The list can be out of date. ${errorMessage(error)}`);
  } finally {
    if (generation === refreshGeneration) controls();
  }
}

function size(view: Terminal) { return terminalSize(view); }

// A hidden terminal has no size. A narrow main area hides the session while it shows the
// workspace pane. See hiddenSize in terminal-size.ts for the size that it joins with.
const shownSizes = new Map<string, Size>();

function terminalShown(): boolean {
  return !!$('terminal').clientWidth && !!$('terminal').clientHeight;
}

function rememberSize(value: Size): void {
  if (!selected?.id) return;
  shownSizes.delete(selected.id);
  shownSizes.set(selected.id, value);
}


// A view sends no resize while it opens. The terminal selector, the draft, and Handoff
// prompt load after the request, and they can change the height of the terminal area.
// At the end of the open, one fit corrects the size of the request.
let opening = false;
// The number of opens of a session view. Each open adds one, so a jump from the Messages
// view can tell that another open came after its click.
let opens = 0;

// resized tells that the size of the terminal view changed. Each frame also calls this
// function.
function requestFit(resized = false) {
  // A live view gets each frame at its own size. After a size change, the terminal is
  // larger than its area until the frame of the new size arrives. A scroll bar in that
  // time must not take space from the area, or the fit asks for a smaller size.
  $('terminal').classList.toggle('live', !!connection?.ready && !!connection.peer?.active);
  if (!terminal || !connection?.ready || connection.resizing) return;
  if (!terminalShown()) return;
  const peer = connection.peer;
  // The terminal keeps its PTY size while the on-screen keyboard shows. The lower view
  // shows the part with the cursor row. A frame keeps the part that a drag shows.
  if (keyboardShown()) {
    if (!peer?.active) return;
    return resized ? showCursor($('terminal'), terminal) : followCursor($('terminal'), terminal);
  }
  const proposed = fitSize(terminal);
  const dimensions = proposed ? terminalSize(proposed) : undefined;
  if (!dimensions) return;
  // An ended terminal has no PTY and gets no more frames. The view sets its rows itself.
  if (!peer?.active) {
    const view = terminal;
    void fitEndedRows(view, dimensions.rows, () => terminal === view);
    return;
  }
  rememberSize(dimensions);
  if (opening) return;
  // The frames keep the old size until the server applies the resize in stream order,
  // after output at the old size. The connection sends each size once.
  connection.resize(dimensions);
}

function darkScheme(): boolean {
  const scheme = getComputedStyle(document.documentElement).colorScheme;
  return scheme === 'dark' || (scheme === 'light dark' && systemDark.matches);
}

// The color of the marks of the sent messages, on the terminal background.
function markColor(): string {
  return darkScheme() ? '#8bbcff' : '#8fd6ac';
}

function terminalTheme() {
  const background = getComputedStyle($('terminal')).backgroundColor;
  // The scroll bar has no border line beside the marks of the sent messages.
  const shared = { background, overviewRulerBorder: background };
  return darkScheme()
    ? { ...shared, foreground: '#efeff1', cursor: '#d6d6dc', selectionBackground: '#46536b' }
    : { ...shared, foreground: '#d7e4dc', cursor: '#b8dcc3', selectionBackground: '#486e59' };
}

function updateTerminalTheme(): void {
  sideTerminal.updateTheme();
  if (!terminal) return;
  const theme = terminalTheme();
  if (terminal.options.theme?.background !== theme.background) {
    terminal.options.theme = theme;
    messageNav.restyle();
  }
}

// Stop the glide of a finger drag in the session terminal.
let stopGlide = () => {};

function makeTerminal(): Terminal {
  terminal?.dispose();
  $('terminal').replaceChildren();
  const view = terminal = new Terminal({
    ...smallestSize,
    cursorBlink: true, fontSize: 13, lineHeight: 1.25,
    fontFamily: 'Menlo, Monaco, Consolas, monospace', disableStdin: true, screenReaderMode: true,
    theme: terminalTheme(),
    // Terminal output must not open links, read the browser clipboard, or write to it.
    linkHandler: { activate() {} },
    // The scroll bar shows the marks of the sent messages. This width is the default
    // width of the scroll bar, so the terminal keeps its columns.
    overviewRuler: { width: 14 },
    // xterm.js names its decoration interface a proposed interface. The marks use it.
    // The option changes no handling of terminal output.
    allowProposedApi: true,
  });
  // The step keys go to the earlier or the later sent message. They are not terminal
  // input.
  view.attachCustomKeyEventHandler(event => {
    const direction = stepShortcut(event);
    if (!direction) return true;
    event.preventDefault();
    if (event.type === 'keydown') messageNav.step(direction);
    return false;
  });
  const host = document.createElement('div');
  host.className = 'terminal-host';
  $('terminal').append(host);
  terminal.open(host);
  // The hint of the earlier view goes before the fit. Its row would make the fit lower.
  hint();
  if (terminalShown()) {
    const fitted = fitSize(view);
    if (fitted) view.resize(fitted.cols, fitted.rows);
    rememberSize(size(view));
  } else {
    const hidden = hiddenSize(shownSizes, selected?.id ?? '');
    view.resize(hidden.cols, hidden.rows);
  }
  onTerminalInput(terminal, input => {
    // Typed input shows the cursor row again, after a drag showed other rows. xterm.js
    // shows the last rows for typed input. A glide must not move the view after that.
    if (!input.report) {
      stopGlide();
      if (keyboardShown()) showCursor($('terminal'), view);
    }
    return !!connection?.ready && !!connection.peer?.active && connection.peer.send(input);
  });
  messageNav.attach(view);
  view.onCursorMove(() => { if (keyboardShown()) followCursor($('terminal'), view); });
  // Another view can change the PTY size. Then the rows of this view change.
  view.onResize(() => { if (keyboardShown()) showCursor($('terminal'), view); });
  return view;
}

async function leaveView() {
  await preparation.flush();
  await composer.flush();
  connection?.close();
  connection = null;
  if (terminal) terminal.options.disableStdin = true;
}

// The terminal list that the latest session message asked for. An open waits for it,
// because the terminal selector can change the height of the terminal area.
let terminalsLoad: Promise<void> = Promise.resolve();

// run shows an earlier terminal of the session. Without run, the view shows the latest
// terminal.
async function openSession(session: SessionView, launch?: Launch, run = ''): Promise<number> {
  const open = ++opens;
  opening = true;
  try {
    await showSession(session, launch, run);
    await terminalsLoad;
    return open;
  } finally {
    opening = false;
    requestFit();
  }
}

async function showSession(session: SessionView, launch?: Launch, run = ''): Promise<void> {
  if (!server) throw new Error('The server is unavailable. Reload this page.');
  const start = !!launch;
  sidebar.setDrawer(false);
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
  messageNav.select('');
  // A start or a continue adds a terminal, so the list of the session is stale. Until the
  // new list arrives, the view shows no terminal selector and no tool.
  if (start || selected?.id !== session.id) terminalPicker.update([]);
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
    await preparation.open({ ...session, archived: !!session.archived, pinned: !!session.pinned, id: session.id, projectId: session.projectId ?? '' });
    await composer.select(session.id);
    renderSessions(); return;
  }
  await preparation.close();
  sessionSplit.setEnabled(true);
  // The row above the terminal holds the message bar of each session terminal. Show it
  // before the first fit, so that the size in the request is already the final size.
  messageNav.select(session.id ?? '');
  messageNav.window(terminalPicker.shown());
  const view = makeTerminal();
  let request: StreamRequest;
  if (launch?.kind === 'start' && session.id && session.preparation) {
    request = { operation: 'session-start', session: session.id, revision: session.preparation.revision, size: size(view) };
  } else if (launch?.kind === 'continue' && session.id && session.run) {
    request = { operation: 'session-continue', session: session.id, latestRun: session.run.id, tool: launch.tool, model: launch.model, effort: launch.effort, size: size(view) };
  } else if (session.id) {
    request = { operation: 'session-resume', session: session.id, size: size(view), ...(run ? { run } : {}) };
  } else {
    throw new Error('No session was selected.');
  }
  renderSessions();
  connection = new SessionConnection(server, view, request, {
    size: () => size(view),
    ready() {
      view.options.disableStdin = !connection?.peer?.active;
      messageNav.rendered();
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
          hint(message.active ? '' : terminalPicker.shownRun ? earlierHint(terminalPicker.shown()) :
            'Recorded output of the latest terminal. No process was started.');
          terminalsLoad = loadTerminals(message.session, true);
          view.options.disableStdin = true;
          history.replaceState(null, '', sessionURL(message.session));
          if (message.notice) {
            startWarnings.set(message.session, message.notice);
            showWorkspace(selected.workspace, selected.worktree);
          }
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
          if (message.error) hint(`Process ended with an error: ${message.error}`, 'error');
          else hint('Process ended. Showing saved terminal output.');
          // The view now sets its own rows. The first fit applies at once, also when the
          // size does not change.
          requestFit();
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
      hint(`Connection lost: ${errorMessage(error).replace(/\.$/, '')}. Showing the last screen. Input is off until this view connects again.`, 'error');
      controls();
      refreshSessions();
    },
  });
  try { await connection.connect(); }
  catch (error) {
    if (start && session.id) {
      await openSession(session);
      // A start that failed leaves the draft, and its form shows the reason. Otherwise the
      // session has a terminal now, and an error toast shows the reason.
      if (preparation.visible) preparation.showError(error);
      else toasts.show(failed('start', session), errorMessage(error));
      return;
    }
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

// The open whose session message read the terminal list last, and the open for which
// the view has a list from a read after that session message. See loadTerminals.
let openRead = 0, listed = 0;

// Only the newest request updates the list. A failed read keeps the list that the view
// has, so the selector and the buttons of the Messages view stay. A view without a list
// shows no selector.
//
// opening marks the read for the session message of an open. The server chose the
// terminal of an empty run before that read, so the read has that terminal. Each later
// read keeps the shown terminal: a view of the saved screen of the latest terminal first
// names that terminal by its run. When another view started a newer terminal, the view
// then shows its terminal as an earlier terminal. A read that started before the session
// message can lack the shown terminal, so it does not count for this rule.
async function loadTerminals(id: string, opening = false): Promise<void> {
  if (!server || !id) return;
  const generation = ++terminalsGeneration;
  const open = opens;
  if (opening) openRead = open;
  const fresh = openRead === open;
  let terminals: TerminalInfo[] | null = null;
  try { terminals = await call(server, { operation: 'session-terminals', session: id }); } catch { /* Keep the known list. */ }
  if (generation !== terminalsGeneration || selected?.id !== id) return;
  const shown = terminalPicker.shown();
  if (listed === opens && !terminalPicker.shownRun && shown?.run && connection?.ready && !connection.peer?.active) terminalPicker.show(shown.run);
  terminalPicker.update(terminals ?? [...terminalPicker.all]);
  if (terminals && fresh && open === opens) listed = open;
  messageNav.window(terminalPicker.shown());
  // The Messages view names the terminal of each message.
  sentHistory.mark();
  if (terminalPicker.shownRun && connection?.ready) hint(earlierHint(terminalPicker.shown()));
  // The tool on the workspace line comes from the shown terminal.
  if (selected && !showingSettings && !preparation.visible) showWorkspace(selected.workspace, selected.worktree);
  controls();
}

// The Continue dialog has the model and effort fields of a draft. The dialog shows no
// notes about the model list, as a draft does.
const continueModels = new ModelPicker('continue', { server: () => server, changed: previewContinue, quiet: true });

// The tool that the Continue dialog selects. Shell has no tool.
function continueTool(): Tool | undefined {
  return continueTools.find(tool => tool.id === $('continue-tool').value);
}

// A newly selected tool brings its default model and effort, as in a draft.
function selectContinueTool(): void {
  const tool = continueTool();
  continueModels.set(tool?.type ?? '', tool?.model ?? '', tool?.effort ?? '');
  previewContinue();
}

// Show the command that the new terminal submits.
function previewContinue(): void {
  const tool = continueTool(), type = tool?.type ?? '';
  $('continue-command').textContent = launchCommand(type, tool?.command ?? '',
    typed(type) ? continueModels.model : '', typed(type) ? continueModels.effort : '') || '(no startup command)';
}

async function showContinue(): Promise<void> {
  if (!server || !selected?.id) return;
  await composer.flush();
  const id = selected.id;
  const [detail, settings, handoff, terminals] = await Promise.all([
    call(server, { operation: 'session-config', session: id }),
    call(server, { operation: 'settings-get' }),
    call(server, { operation: 'session-handoff', session: id }),
    call(server, { operation: 'session-terminals', session: id }),
  ]);
  if (selected?.id !== id) return;
  selected = withDetail(selected, detail);
  const continuation = continueAction(selected, !!connection?.peer?.active, terminalPicker.shownRun);
  const problem = continueDialogProblem(continuation, selected.run?.id);
  if (problem) {
    showWorkspace(selected.workspace, selected.worktree);
    throw new Error(problem);
  }
  // A tool that is off is not a choice for a new terminal. The menu has the built-in
  // tools, a line, then the custom tools.
  fillToolMenu($('continue-tool') as HTMLSelectElement, settings.tools, !settings.shellOff);
  const groups = toolGroups(settings.tools, !settings.shellOff);
  const choices = [...groups.builtin, ...groups.custom].filter(choice => choice.id);
  // The dialog selects the tool of the latest terminal, the last choice of the user. Its
  // model and effort are the defaults of the tool, as for a new choice in a draft.
  continueTools = settings.tools.filter(tool => tool.enabled);
  $('continue-tool').value = defaultContinueTool(choices, [terminals[terminals.length - 1]?.toolId, selected.preparation?.toolId, settings.defaultTool], !settings.shellOff);
  selectContinueTool();
  $('continue-prompt').value = handoff.prompt;
  $('continue-workspace').textContent = selected.worktree ? `⑂ ${selected.worktree.branch} · ${selected.workspace}` : selected.workspace;
  $('continue-warning').hidden = selected.run?.status !== 'interrupted';
  $('continue-error').hidden = true;
  continueProblem = '';
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

// Create a sub-session draft in the family of a session and open it.
async function showSubLaunch(parent: string): Promise<void> {
  if (!server) return;
  await leaveView();
  const session = await call(server, { operation: 'project-draft', parent });
  archivedList = false; $('filter').value = '';
  await openSession({ ...session, status: 'draft' });
  await refreshSessions();
  // The family can be in Pinned.
  revealFamily(session.id);
}

async function showWelcome(): Promise<void> {
  await leaveView();
  settingsView.close(); showingSettings = false;
  await preparation.close();
  await composer.select('');
  selected = null;
  workspacePane.select('');
  terminalPicker.update([]); terminalPicker.show('');
  messageNav.detach();
  terminal?.dispose(); terminal = null;
  sessionSplit.setEnabled(false);
  $('session-view').hidden = true;
  $('welcome').hidden = false;
  heading('Home', 'bbflow');
  showWorkspace('');
  $('status').hidden = true;
  history.replaceState(null, '', homePath);
  renderSessions();
  sidebar.setDrawer(true);
}

async function showSettings(): Promise<void> {
  await leaveView();
  await settingsView.open();
  sidebar.setDrawer(false);
  showingSettings = true;
  workspacePane.select('');
  $('session-view').hidden = $('welcome').hidden = true;
  heading('Settings');
  showWorkspace('');
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
  // The folder of a saved project cannot change. Edit project shows it as text.
  $('project-folder').hidden = !!project;
  $('project-folder-view').hidden = !project;
  $('project-folder-path').textContent = project?.workspace ?? '';
  $('project-help').textContent = project
    ? 'The folder of a project cannot change. To use another folder, add a new project.'
    : 'Any existing folder works. Git is optional.';
  $('project-error').hidden = true;
  $('project-submit').textContent = project ? 'Save' : 'Add project';
  showDialog($('project-dialog'));
}

// Copy the folder of a project. The ⋯ button of the project then shows a confirmation.
async function copyFolder(project: Project): Promise<void> {
  try {
    await navigator.clipboard.writeText(project.workspace);
    rowMenus.confirm(`project-menu:${project.id}`, 'Folder path copied');
  } catch (error) { toasts.show(`Could not copy the folder path of ${project.name}.`, errorMessage(error)); }
}

// Ask before the removal of a project. keyboard is true when the user chose Remove
// project with the keyboard.
function showRemoveProject(project: Project, keyboard: boolean): void {
  removingProject = { project, keyboard };
  $('remove-project-summary').textContent = `The sessions of “${project.name}” move to Standalone. Pinned sessions stay in Pinned.`;
  $('remove-project-folder').textContent = project.workspace;
  $('remove-project-error').hidden = true;
  showDialog($('remove-project-dialog'));
}

// A busy action disables the sidebar buttons, so a closed dialog cannot return the focus
// to the button that opened it. Give the focus to the sidebar button with this key, or to
// the search box when that button is gone. A rename can move the button out of the
// visible part of the list, so the list scrolls to it.
function refocusSidebar(key: string): void {
  if (document.activeElement && document.activeElement !== document.body) return;
  focusSidebar(key, true);
  if (!document.activeElement || document.activeElement === document.body) $('filter').focus();
}

// The group key of a project in the session list. A session without a saved project is
// in the Standalone group.
function groupKey(projectId = ''): string {
  return projects.some(project => project.id === projectId) ? projectId : '';
}

type ArchiveTarget = { id: string; parentId?: string; projectId?: string; title: string; autoTitle?: string; status?: string };

// The top-level session that the archive dialog asks about, and the IDs of the
// sub-sessions that the dialog lists. The server archives the family only when its
// sub-sessions are still these.
let archiving: { session: ArchiveTarget; members: string[] } | null = null;

// The server rejects a family archive when the sub-sessions changed after the check.
const familyChanged = 'sub-sessions of this family changed';

// Read a top-level session and its sub-sessions that are not archived, with their current
// status. For a sub-session, read only that session. A pinned family is in Pinned. Another
// view can pin or unpin it at any time, so read both groups.
async function readFamily(session: ArchiveTarget): Promise<SessionInfo[]> {
  if (!server) return [];
  const page = await call(server, { operation: 'session-list', groups: [pinnedGroup, groupKey(session.projectId)], limit: 1, session: session.id });
  return page.sessions.filter(item => (item.id === session.id || item.parentId === session.id) && !item.archived);
}

// Read the sub-sessions of a top-level session that are not archived.
async function familyChildren(session: ArchiveTarget): Promise<SessionInfo[]> {
  return (await readFamily(session)).filter(item => item.parentId === session.id);
}

// The session that the stop dialog asks about, and the sessions that it lists. family is
// true for Stop family, and then session is a top-level session. A family stop sends only
// the listed members, so a member that starts later continues. keyboard is true when the user chose the item with
// the keyboard.
let stopping: { session: SessionInfo; family: boolean; members: string[]; keyboard: boolean } | null = null;

// Ask before a stop from the sidebar, because the view may not show the session. Stop
// session asks about the session of the row. Stop family lists the members with a live
// terminal and their status, and it names the members that cannot stop yet. When no
// session to stop has a live terminal now, the list refresh shows that, and no dialog
// opens.
async function showStop(session: SessionInfo, family: boolean, keyboard: boolean): Promise<void> {
  const read = await readFamily(session);
  const current = read.find(member => member.id === session.id) ?? session;
  const { stop, starting } = stopMembers(family ? read : [current]);
  if (!stop.length) {
    await refreshSessions();
    return;
  }
  stopping = { session, family, members: stop.map(member => member.id), keyboard };
  const text = stopText(current, stop, starting, family);
  $('stop-title').textContent = text.title;
  $('stop-summary').textContent = text.summary;
  $('stop-members').replaceChildren(...text.lines.map(line => {
    const item = document.createElement('li');
    item.textContent = line;
    return item;
  }));
  $('stop-members').hidden = !text.lines.length;
  $('stop-note').textContent = text.note;
  $('stop-note').hidden = !text.note;
  $('stop-submit').textContent = text.submit;
  $('stop-error').hidden = true;
  showDialog($('stop-dialog'));
}

// Show the members of a family in the archive dialog.
function fillArchiveDialog(session: ArchiveTarget, children: SessionInfo[]): void {
  archiving = { session, members: children.map(child => child.id) };
  const title = sessionTitle(session) || 'Untitled session';
  $('archive-summary').textContent = children.length
    ? `This archives “${title}” and ${children.length} sub-session${children.length === 1 ? '' : 's'}:`
    : `This archives “${title}”. It has no sub-sessions now.`;
  $('archive-members').replaceChildren(...[session, ...children].map(member => {
    const item = document.createElement('li');
    item.textContent = sessionTitle(member) || (member.status === 'draft' ? 'Untitled draft' : 'Untitled session');
    return item;
  }));
}

// Archive or restore a session. Archive of a top-level session with sub-sessions asks
// first, because it archives the whole family. Each archive sends the sub-sessions that
// the user saw, also an empty list. The server archives nothing if another view added a
// sub-session. The dialog then shows the current members.
async function requestArchive(session: ArchiveTarget, archived: boolean): Promise<void> {
  if (!server) return;
  if (!archived) {
    await setArchived(session.id, false);
    return;
  }
  const children = session.parentId ? [] : await familyChildren(session);
  if (children.length) {
    fillArchiveDialog(session, children);
    $('archive-error').hidden = true;
    showDialog($('archive-dialog'));
    return;
  }
  try {
    await setArchived(session.id, true, false, []);
    return;
  } catch (error) {
    if (!errorMessage(error).includes(familyChanged)) throw error;
  }
  const now = await familyChildren(session);
  if (!now.length) throw new Error('The sub-sessions of this family changed. Try the archive again.');
  fillArchiveDialog(session, now);
  $('archive-error').textContent = 'The sub-sessions of this family changed. Check the list again.';
  $('archive-error').hidden = false;
  showDialog($('archive-dialog'));
}

// Archive or restore a session. The selected session first saves its launch choices and
// message editor. Its view then closes, or opens in the normal list after a restore.
// Settings stays open. Done then opens the welcome view or the restored session.
async function setArchived(id: string, archived: boolean, family = false, members?: string[]): Promise<void> {
  if (!server) return;
  // The archive of a family also archives a selected sub-session of that family.
  const current = selected?.id === id || (family && archived && !!selected?.parentId && selected.parentId === id) ? selected : null;
  if (current) {
    await preparation.flush();
    await composer.flush();
  }
  await call(server, { operation: 'session-archive', session: id, archived, ...(members ? { members } : {}) });
  if (current) {
    current.archived = archived;
    // Archive removes the pin.
    if (archived) current.pinned = false;
    if (showingSettings) {
      if (archived) selected = null;
    } else if (archived) await showWelcome();
    else {
      archivedList = false; $('filter').value = '';
      await openSession(current);
    }
  }
  await refreshSessions();
  // A restored session opens in the normal list. Its family can be in Pinned.
  if (current?.id && !archived && !showingSettings) revealFamily(current.id);
}

async function initialize() {
  systemDark.addEventListener('change', updateTerminalTheme);
  controls();
  $('archive-session').onclick = () => action(async () => {
    if (selected?.id) await requestArchive({ ...selected, id: selected.id }, !selected.archived);
  }, failed(selected?.archived ? 'restore' : 'archive', selected));
  $('pin-session').onclick = () => action(async () => {
    if (selected?.id) await setPinned({ ...selected, id: selected.id }, !selected.pinned);
  }, failed(selected?.pinned ? 'unpin' : 'pin', selected));
  $('cancel-archive').onclick = () => $('archive-dialog').close();
  $('cancel-stop').onclick = () => $('stop-dialog').close();
  $('stop-form').onsubmit = event => {
    event.preventDefault();
    if (!stopping) return;
    const { session, family, members, keyboard } = stopping;
    void action(async () => {
      if (!server) return;
      try {
        await call(server, { operation: 'session-stop', session: session.id, ...(family ? { members } : {}) });
      } catch (error) {
        // The sessions that stopped show in the list. The dialog stays open for a retry.
        $('stop-error').textContent = errorMessage(error);
        $('stop-error').hidden = false;
        await refreshSessions();
        return;
      }
      $('stop-dialog').close();
      // A view of the live terminal gets the exit message. A view of an earlier terminal
      // reads the stored status of the stopped run.
      await refreshSessions();
      if (selected?.id && members.includes(selected.id)) await loadTerminals(selected.id);
    }, failed(family ? 'stop the family of' : 'stop', session)).then(() => {
      if (keyboard && !$('stop-dialog').open) refocusSidebar(`menu:${session.id}`);
    });
  };
  $('page-bar-reload').onclick = () => location.reload();
  // A click shows the start warning on devices without hover. A focus loss hides it.
  $('workspace-warning').onclick = () => $('workspace-warning').classList.toggle('tip-open');
  $('workspace-warning').onblur = () => $('workspace-warning').classList.remove('tip-open');
  $('archive-form').onsubmit = event => {
    event.preventDefault();
    action(async () => {
      if (!archiving) return;
      const { session, members } = archiving;
      try {
        // Another view can archive the sub-sessions first, so that the list is empty now.
        await setArchived(session.id, true, members.length > 0, members);
        $('archive-dialog').close();
      } catch (error) {
        let message = errorMessage(error);
        if (message.includes(familyChanged)) {
          // Another view changed the sub-sessions. Show them now. Nothing is archived.
          fillArchiveDialog(session, await familyChildren(session));
          message = 'The sub-sessions of this family changed. Check the list again.';
        }
        $('archive-error').textContent = message;
        $('archive-error').hidden = false;
      }
    }, failed('archive', archiving?.session));
  };
  $('new-sub-session').onclick = () => action(async () => {
    if (selected?.id) await showSubLaunch(selected.id);
  }, failed('add a sub-session to', selected));
  $('archives-open').onclick = () => action(async () => {
    archivedList = !archivedList;
    await refreshSessions();
  }, 'Could not change the session list.');
  $('sessions-open').onclick = () => action(async () => {
    archivedList = false;
    await refreshSessions();
  }, 'Could not change the session list.');
  $('home-link').onclick = event => {
    // Keep a plain click in this page so drafts save. Let modified clicks open a new tab.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void action(showWelcome, 'Could not open Home.');
  };
  // The dot on Settings tells of a new release. Then Settings opens at its card.
  $('settings-open').onclick = () => action(async () => {
    const updates = updatePanel.attention;
    await showSettings();
    if (updates) updatePanel.reveal();
  }, 'Could not open Settings.');
  $('usage-open').onclick = () => action(() => usageDialog.open(), 'Could not open Usage.');
  $('settings-close').onclick = () => action(async () => {
    settingsView.close(); showingSettings = false;
    if (selected) await openSession(selected);
    else await showWelcome();
  }, 'Could not leave Settings.');
  $('remove-worktree').onclick = () => action(async () => {
    if (!server || !selected?.id) return;
    await call(server, { operation: 'worktree-remove', session: selected.id });
    await refreshSessions();
  }, failed('remove the worktree of', selected));
  $('add-project').onclick = () => showProject();
  $('cancel-project').onclick = () => $('project-dialog').close();
  $('project-form').onsubmit = event => {
    event.preventDefault();
    const project = editingProject;
    void action(async () => {
      if (!server) return;
      try {
        if (project) await call(server, { operation: 'project-rename', project: project.id, name: $('project-name').value });
        else {
          await call(server, { operation: 'project-add', name: $('project-name').value, workspace: $('project-workspace').value.trim() });
          // The archived list shows only groups with archived sessions. Show the new project.
          if (archivedList) { archivedList = false; $('filter').value = ''; }
        }
        $('project-dialog').close();
        await refreshSessions();
      } catch (error) {
        $('project-error').textContent = errorMessage(error);
        $('project-error').hidden = false;
      }
    }, 'Could not save the project.').then(() => {
      if (project && !$('project-dialog').open) refocusSidebar(`project-menu:${project.id}`);
    });
  };
  $('cancel-remove-project').onclick = () => $('remove-project-dialog').close();
  $('remove-project-form').onsubmit = event => {
    event.preventDefault();
    const removing = removingProject;
    if (!removing) return;
    const { project, keyboard } = removing;
    void action(async () => {
      if (!server) return;
      try {
        // A save of the launch choices that ends after the removal would bring back the
        // old project of the selected draft.
        await preparation.flush();
        await call(server, { operation: 'project-remove', project: project.id });
      } catch (error) {
        $('remove-project-error').textContent = errorMessage(error);
        $('remove-project-error').hidden = false;
        return;
      }
      $('remove-project-dialog').close();
      // The selected session leaves the project but keeps its view. Thus Settings and the
      // sidebar drawer stay open.
      if (selected?.projectId === project.id) selected.projectId = '';
      await refreshSessions();
    }, `Could not remove ${project.name}.`).then(() => {
      // The ⋯ button of the project is gone. A keyboard user continues from the search box.
      if (keyboard && !$('remove-project-dialog').open) refocusSidebar(`project-menu:${project.id}`);
    });
  };
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
    sessionMenu.confirm('Session ID copied');
  }, failed('copy the session ID of', selected));
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
    }, failed('rename', selected));
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
  $('reconnect').onclick = () => action(async () => { if (selected) await openSession(selected); }, failed('reconnect to', selected));
  $('continue-session').onclick = () => action(showContinue, failed('continue', selected));
  mobileLayout.addEventListener('change', controls);
  $('menu-continue').onclick = () => $('continue-session').click();
  $('handoff-open').onclick = () => action(async () => {
    if (!selected?.id) return;
    await loadHandoff(selected.id);
    if (handoff?.session === selected.id && handoff.info.available) handoffPrompt.open(handoff.info);
    else composer.problem('The handoff folder of this session is not available. Continue in a new terminal to write it again.');
  }, failed('show the handoff prompt of', selected));
  $('cancel-continue').onclick = () => $('continue-dialog').close();
  $('continue-tool').onchange = selectContinueTool;
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
      if (!$('continue-dialog').open || !selected?.id) return;
      // The session or the server can change after the dialog opened. The dialog then
      // shows the problem.
      const continuation = continueAction(selected, !!connection?.peer?.active, terminalPicker.shownRun);
      if (restarted || continueDialogProblem(continuation, selected.run?.id, continueRun)) return;
      const tool = $('continue-tool').value;
      const type = continueTool()?.type ?? '';
      const model = typed(type) ? continueModels.model : '', effort = typed(type) ? continueModels.effort : '';
      $('continue-dialog').close();
      await openSession(selected, { kind: 'continue', tool, model, effort });
    }, failed('start a new terminal in', selected));
  };
  $('stop-session').onclick = () => action(async () => {
    if (!server || !selected?.id || terminalPicker.shownRun) return;
    const { stopped } = await call(server, { operation: 'session-stop', session: selected.id });
    // The status and the exit hint show a stop. The hint also shows a stop without effect.
    if (stopped) selected.status = 'ended';
    else hint('The session has no live terminal. Nothing was stopped.', 'info');
    // A view of an earlier terminal gets no exit message. The refresh reads the stored
    // status of the stopped run.
    await refreshSessions();
    if (stopped) showStatus();
    await loadTerminals(selected.id);
  }, failed('stop', selected));
  new ResizeObserver(() => requestFit(true)).observe($('terminal'));
  stopGlide = touchScroll($('terminal'), () => terminal);
  followKeyboard();
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
    void composerMenu.refresh();
    const route = parseRoute(location.pathname);
    if (route.page === 'settings') await action(showSettings, 'Could not open Settings.');
    else if (route.page === 'session') await action(() => openSession(sessions.find(s => s.id === route.id) || { id: route.id, title: 'Session', workspace: '', status: 'unknown' }), 'Could not open the session of this address.');
    setInterval(() => {
      if (document.hidden || busy) return;
      refreshSessions();
      // A new terminal has no run until its process starts. Read the list again until then.
      if (selected?.id && terminalPicker.starting()) void loadTerminals(selected.id);
    }, 5000);
  } catch (error) {
    server = null;
    showConnection(false);
    $('sessions').replaceChildren();
    listProblem(`Cannot connect to the bbflow server. ${errorMessage(error)}`);
  }
  controls();
}

window.addEventListener('DOMContentLoaded', initialize);
