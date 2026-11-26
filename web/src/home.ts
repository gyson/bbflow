import { ActionMenu } from './action-menu.js';
import { element } from './dom.js';
import { call, sessionTitle } from './protocol.js';
import type { Draft, PreparedSession, Project, SentPage, ServerInfo, SessionInfo, TerminalInfo } from './protocol.js';
import { listStatus } from './session-status.js';

// Home lists the sessions that have a live terminal, in two groups.
export interface HomeGroups { running: SessionInfo[]; idle: SessionInfo[] }

const byTitle = (a: SessionInfo, b: SessionInfo) =>
  sessionTitle(a).localeCompare(sessionTitle(b), undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

// Return the sessions of Home. listed has the sessions of the sidebar list. extra has
// live sessions that the list does not hold. statuses has the pushed statuses of the
// live terminals. An extra session counts only while it has a pushed status, because its
// own status can be old.
// The order of a group does not follow the output of the sessions. Running sorts by
// title. Idle shows the session with the latest activity first.
export function homeGroups(listed: SessionInfo[], extra: SessionInfo[], statuses: Record<string, string>): HomeGroups {
  const groups: HomeGroups = { running: [], idle: [] };
  const seen = new Set<string>();
  for (const session of [...listed, ...extra.filter(item => item.id in statuses)]) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    const status = listStatus(session, statuses);
    if (status === 'running') groups.running.push(session);
    else if (status === 'idle') groups.idle.push(session);
  }
  groups.running.sort(byTitle);
  groups.idle.sort((a, b) => b.updated.localeCompare(a.updated) || byTitle(a, b));
  return groups;
}

// Return the IDs of the live terminals that the list does not hold.
export function unlisted(listed: SessionInfo[], statuses: Record<string, string>): string[] {
  const known = new Set(listed.map(session => session.id));
  return Object.keys(statuses).filter(id => !known.has(id));
}

// Tell if a saved draft holds a message that the user did not send. A pending draft is
// a send that can have reached the terminal, so it is not an unsent message.
export function unsent(draft: Pick<Draft, 'text' | 'attachments' | 'pending'>): boolean {
  return !draft.pending && (draft.text.trim() !== '' || draft.attachments.length > 0);
}

export interface LastMessage { text: string; created: string }

// Return the latest sent message of a page of sent messages, which lists the newest
// message first. A message without text names the number of its attachments.
export function lastMessage(page: SentPage): LastMessage | undefined {
  const message = page.messages[0];
  if (!message) return undefined;
  const files = message.attachments.length;
  const text = message.text.trim() || (files ? `${files} attachment${files === 1 ? '' : 's'}` : '');
  return text ? { text, created: message.created } : undefined;
}

// Return a time span in one unit, such as "<1 min", "12 min", "3 h", or "2 d".
export function elapsedText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / 1440)} d`;
}

// Return the span from a recorded time to now, or '' without a valid time.
export function since(time: string, now: number): string {
  const then = Date.parse(time);
  return Number.isNaN(then) ? '' : elapsedText(now - then);
}

// Return the line below the title of a row: the project, the tool, the worktree, and
// the top-level session of a sub-session. A session without a saved project shows its
// workspace. tool is the tool of the latest terminal. Before it is known, the line
// shows the tool of the launch.
export function placeLine(session: SessionInfo, projects: Project[], parent: SessionInfo | undefined, tool = ''): string {
  const project = projects.find(item => item.id === session.projectId);
  return [
    project?.name ?? session.workspace,
    tool || session.preparation?.toolName || '',
    session.worktree ? 'worktree' : '',
    parent ? `↳ ${sessionTitle(parent) || 'Untitled session'}` : '',
  ].filter(Boolean).join(' · ');
}

// Return the text that Home shows in place of the groups, or '' when a session has a
// live terminal.
export function homeText(projects: number, liveSessions: number): string {
  if (!projects) return 'Click ＋ Project to add a folder. Then click ＋ New session to start a session.';
  if (!liveSessions) return 'No session has a live terminal. Click ＋ New session to start one. To continue an earlier session, select it in the sidebar.';
  return '';
}

// Convert the saved data of one session to a row of the session list. The update time
// is not part of that data.
export function listedSession(session: PreparedSession): SessionInfo {
  return {
    archived: session.archived, pinned: session.pinned, parentId: session.parentId ?? '', projectId: session.projectId, id: session.id,
    title: session.title, autoTitle: session.autoTitle ?? '', workspace: session.workspace, updated: '', status: session.status, viewers: 0,
    ...(session.preparation ? { preparation: session.preparation } : {}),
    ...(session.worktree ? { worktree: session.worktree } : {}),
    ...(session.run ? { runStatus: session.run.status } : {}),
  };
}

// The data of a row that the session list does not hold.
interface Detail { tool: string; last?: LastMessage; unsent: boolean }

interface Host {
  server(): ServerInfo | null;
  // Open a session of Home.
  open(session: SessionInfo): void;
  // Create a draft in a project and open it.
  draft(project: Project): void;
  // Open the Add project dialog.
  addProject(): void;
}

const groupNotes = {
  running: 'A screen change in the last 10 seconds.',
  idle: 'Live, with no screen change in the last 10 seconds. Idle does not mean that the agent is ready for input.',
};

// HomeView shows Home: the New session menu, and the live sessions of all projects in
// the groups Running and Idle. The session list and the status watch supply the rows.
// Home reads the tool, the latest sent message, and the saved draft of each row.
export class HomeView {
  private readonly view = element('home', HTMLElement);
  private readonly groups = element('home-groups', HTMLElement);
  private readonly empty = element('home-empty', HTMLElement);
  private readonly text = element('home-text', HTMLElement);
  private readonly addProject = element('home-add-project', HTMLButtonElement);
  private readonly items = element('home-new', HTMLElement);
  private readonly menu = new ActionMenu('home-new');
  private projects: Project[] = [];
  private listed: SessionInfo[] = [];
  private statuses: Record<string, string> = {};
  // The first session list arrived. Before it, Home shows nothing.
  private loaded = false;
  private readonly extra = new Map<string, SessionInfo>();
  private readonly details = new Map<string, Detail>();
  // The status of each row at its latest read, and the number of that read.
  private readonly read = new Map<string, { status: string; turn: number }>();
  private turns = 0;
  private rendered = '';
  private menuProjects = '';

  constructor(private readonly host: Host) {
    this.addProject.onclick = () => host.addProject();
    // The times of the rows change without a message from the server.
    setInterval(() => this.render(), 30000);
    this.menu.controls();
  }

  get visible(): boolean { return !this.view.hidden; }

  // Show or hide Home. A shown Home reads the data of each row again, with its terminals.
  show(visible: boolean): void {
    this.view.hidden = !visible;
    if (!visible) return;
    this.read.clear();
    this.extra.clear();
    this.refresh();
  }

  // Take the session list and the pushed statuses. The host calls it after each change.
  update(projects: Project[], listed: SessionInfo[], statuses: Record<string, string>): void {
    this.projects = projects;
    this.listed = listed;
    this.statuses = statuses;
    this.loaded = true;
    this.refresh();
  }

  // Turn the Add project button off while the page cannot add a project.
  controls(off: boolean): void { this.addProject.disabled = off; }

  private rows(): HomeGroups { return homeGroups(this.listed, [...this.extra.values()], this.statuses); }

  private refresh(): void {
    if (!this.loaded) return;
    if (this.visible) this.load();
    this.render();
  }

  // Read the data that a row needs. A row reads again when its status changes, because
  // a send starts output. A hidden Home reads nothing.
  private load(): void {
    const server = this.host.server();
    if (!server) return;
    for (const id of unlisted(this.listed, this.statuses)) {
      if (this.extra.has(id) || this.read.has(`session:${id}`)) continue;
      const turn = ++this.turns;
      this.read.set(`session:${id}`, { status: '', turn });
      void call(server, { operation: 'session-config', session: id }).then(session => {
        if (this.read.get(`session:${id}`)?.turn !== turn) return;
        this.extra.set(id, listedSession(session));
        this.refresh();
      }).catch(() => { this.read.delete(`session:${id}`); });
    }
    const { running, idle } = this.rows();
    const shown = new Set<string>();
    for (const [status, sessions] of [['running', running], ['idle', idle]] as const) {
      for (const session of sessions) {
        shown.add(session.id);
        const earlier = this.read.get(session.id);
        if (earlier?.status === status) continue;
        // The tool changes only with a new terminal, and a new terminal gives a new row.
        // Thus only the first read of a row reads the terminals.
        const turn = ++this.turns;
        this.read.set(session.id, { status, turn });
        void Promise.all([
          call(server, { operation: 'composer-sent', session: session.id }),
          call(server, { operation: 'composer-draft', session: session.id }),
          earlier ? Promise.resolve<TerminalInfo[] | null>(null) : call(server, { operation: 'session-terminals', session: session.id }),
        ]).then(([sent, composer, terminals]) => {
          if (this.read.get(session.id)?.turn !== turn) return;
          const last = lastMessage(sent);
          const tool = terminals ? terminals.at(-1)?.tool ?? '' : this.details.get(session.id)?.tool ?? '';
          this.details.set(session.id, { tool, unsent: unsent(composer.draft), ...(last ? { last } : {}) });
          this.render();
        // After a failed read, the row keeps its earlier data. The next status change
        // reads it again.
        }).catch(() => {});
      }
    }
    // A session that ended leaves Home. A new terminal of it reads its data again.
    for (const id of [...this.details.keys()]) if (!shown.has(id)) { this.details.delete(id); this.read.delete(id); }
    for (const id of [...this.extra.keys()]) if (!(id in this.statuses)) { this.extra.delete(id); this.read.delete(`session:${id}`); }
  }

  private render(): void {
    if (!this.loaded || !this.visible) return;
    this.renderMenu();
    const { running, idle } = this.rows();
    const now = Date.now();
    const sessions = new Map([...this.listed, ...this.extra.values()].map(session => [session.id, session]));
    const row = (session: SessionInfo, status: string) => {
      const detail = this.details.get(session.id);
      return {
        id: session.id, status,
        title: sessionTitle(session) || 'Untitled session',
        place: placeLine(session, this.projects, sessions.get(session.parentId), detail?.tool),
        time: status === 'running' ? 'now' : since(session.updated, now),
        // The update time of a running session changes with each list read. The row does
        // not show it, so it must not replace the buttons.
        updated: status === 'idle' ? session.updated : '',
        last: detail?.last?.text ?? '',
        sent: detail?.last ? since(detail.last.created, now) : '',
        unsent: !!detail?.unsent,
      };
    };
    const live = running.length + idle.length;
    const model = { text: homeText(this.projects.length, live), projects: this.projects.length, running: running.map(session => row(session, 'running')), idle: idle.map(session => row(session, 'idle')) };
    const fingerprint = JSON.stringify(model);
    if (fingerprint === this.rendered) return;
    this.rendered = fingerprint;
    this.text.textContent = model.text;
    this.empty.hidden = !model.text;
    this.addProject.hidden = model.projects > 0;
    // New buttons replace the rows. Give the keyboard focus to the new button of the same session.
    const focused = document.activeElement instanceof HTMLElement && this.groups.contains(document.activeElement) ? document.activeElement.dataset.session : undefined;
    this.groups.replaceChildren();
    this.groups.hidden = !live;
    if (!live) return;
    const byId = new Map([...running, ...idle].map(session => [session.id, session]));
    for (const [name, key, rows] of [['Running', 'running', model.running], ['Idle', 'idle', model.idle]] as const) {
      const section = document.createElement('section');
      section.className = 'home-group';
      const heading = document.createElement('h2');
      heading.id = `home-${key}`;
      const label = document.createElement('span');
      label.className = 'home-group-name';
      label.textContent = name;
      const count = document.createElement('span');
      count.className = 'home-count';
      count.textContent = String(rows.length);
      heading.append(label, ' ', count);
      const note = document.createElement('p');
      note.className = 'home-note';
      note.textContent = groupNotes[key];
      const head = document.createElement('div');
      head.className = 'home-group-heading';
      head.append(heading, note);
      const list = document.createElement('div');
      list.className = 'home-rows';
      section.setAttribute('aria-labelledby', heading.id);
      for (const item of rows) {
        const button = document.createElement('button');
        button.className = 'home-row';
        button.dataset.session = item.id;
        const icon = document.createElement('span');
        icon.className = `status-icon ${item.status}`;
        icon.setAttribute('aria-hidden', 'true');
        const body = document.createElement('span');
        body.className = 'home-row-body';
        const top = document.createElement('span');
        top.className = 'home-row-top';
        const title = document.createElement('strong');
        title.textContent = item.title;
        top.append(title);
        if (item.time) {
          const time = document.createElement('span');
          time.className = 'home-time';
          time.textContent = item.time;
          if (item.status === 'idle') time.title = `Latest activity: ${new Date(item.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
          top.append(time);
        }
        const place = document.createElement('span');
        place.className = 'home-place';
        place.textContent = item.place;
        body.append(top, place);
        if (item.last) {
          const message = document.createElement('span');
          message.className = 'home-message';
          const words = document.createElement('span');
          words.className = 'home-message-text';
          words.textContent = item.last;
          message.append(words);
          if (item.sent) {
            const sent = document.createElement('span');
            sent.className = 'home-message-time';
            sent.textContent = `sent ${item.sent} ago`;
            message.append(' ', sent);
          }
          body.append(message);
        }
        if (item.unsent) {
          const chip = document.createElement('span');
          chip.className = 'home-chip';
          chip.textContent = 'Unsent message';
          chip.title = 'The message editor of this session holds a message that is not sent.';
          body.append(chip);
        }
        button.append(icon, body);
        const session = byId.get(item.id)!;
        button.onclick = () => this.host.open(session);
        list.append(button);
      }
      if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'home-rows-empty';
        empty.textContent = key === 'running' ? 'No running session.' : 'No idle session.';
        list.append(empty);
      }
      section.append(head, list);
      this.groups.append(section);
    }
    if (focused) [...this.groups.querySelectorAll<HTMLElement>('.home-row')].find(button => button.dataset.session === focused)?.focus({ preventScroll: true });
  }

  // The New session menu has one item for each project, in the order of the sidebar.
  // Without a project, the menu button does not show.
  private renderMenu(): void {
    const fingerprint = JSON.stringify(this.projects.map(project => [project.id, project.name]));
    if (fingerprint === this.menuProjects) return;
    this.menuProjects = fingerprint;
    this.items.replaceChildren(...this.projects.map(project => {
      const item = document.createElement('button');
      item.setAttribute('role', 'menuitem');
      item.textContent = project.name;
      item.title = project.workspace;
      item.onclick = () => this.host.draft(project);
      return item;
    }));
    this.menu.controls();
  }
}
