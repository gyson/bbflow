import { ActionMenu } from './action-menu.js';
import { element } from './dom.js';
import { call, sessionTitle } from './protocol.js';
import type { ComposerState, Draft, PreparedSession, Project, SentPage, ServerInfo, SessionInfo, TerminalInfo } from './protocol.js';
import { listStatus, listStatusText } from './session-status.js';

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

// Return the text that Home shows without a project, above its ＋ Project button. With
// a project, the groups and their counts show the state, so Home needs no text.
export function homeText(projects: number): string {
  return projects ? '' : 'No projects yet.';
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
export interface RowDetail { tool: string; last?: LastMessage; unsent: boolean }

// The reads of that data. HomeView reads from the server.
export interface HomeReads {
  session(id: string): Promise<PreparedSession>;
  sent(id: string): Promise<SentPage>;
  draft(id: string): Promise<ComposerState>;
  terminals(id: string): Promise<TerminalInfo[]>;
}

// HomeRows holds the sessions of Home, and the data that Home reads for each row. It
// uses no page elements. reads returns null while the server is not known. changed
// runs after a reply changes a row.
export class HomeRows {
  private listed: SessionInfo[] = [];
  private statuses: Record<string, string> = {};
  // The live sessions that the session list does not hold, and the IDs that a read
  // asked for since Home opened.
  private readonly extra = new Map<string, SessionInfo>();
  private readonly asked = new Set<string>();
  private readonly details = new Map<string, RowDetail>();
  // The status of each row at its latest read, and the number of that read.
  private readonly read = new Map<string, { status: string; turn: number }>();
  // The rows whose terminals a reply gave since Home opened.
  private readonly tools = new Set<string>();
  private turns = 0;

  constructor(private readonly reads: () => HomeReads | null, private readonly changed: () => void) {}

  // Take the session list and the pushed statuses.
  update(listed: SessionInfo[], statuses: Record<string, string>): void {
    this.listed = listed;
    this.statuses = statuses;
  }

  // Make the next load read each row again, with its terminals. Home calls it when it
  // opens. The rows keep their data until the replies arrive.
  reopen(): void {
    this.read.clear();
    this.tools.clear();
    this.asked.clear();
  }

  groups(): HomeGroups { return homeGroups(this.listed, [...this.extra.values()], this.statuses); }

  detail(id: string): RowDetail | undefined { return this.details.get(id); }

  // Return a session by its ID, for the top-level session of a row.
  session(id: string): SessionInfo | undefined { return this.listed.find(session => session.id === id) ?? this.extra.get(id); }

  // Read the data that the rows need. A row reads again when its status changes, because
  // a send starts output.
  load(): void {
    const reads = this.reads();
    if (!reads) return;
    for (const id of unlisted(this.listed, this.statuses)) {
      if (this.asked.has(id)) continue;
      this.asked.add(id);
      void reads.session(id).then(session => {
        if (!(id in this.statuses)) return;
        this.extra.set(id, listedSession(session));
        this.load();
        this.changed();
      // The next load asks again.
      }).catch(() => { this.asked.delete(id); });
    }
    const { running, idle } = this.groups();
    const shown = new Set<string>();
    for (const [status, sessions] of [['running', running], ['idle', idle]] as const) {
      for (const { id } of sessions) {
        shown.add(id);
        if (this.read.get(id)?.status === status) continue;
        const turn = ++this.turns;
        this.read.set(id, { status, turn });
        // The tool changes only with a new terminal, and a new terminal gives a new row.
        // Thus a row reads its terminals until one reply gives them. A reply that fails,
        // or that a newer read replaces, gives nothing.
        void Promise.all([
          reads.sent(id),
          reads.draft(id),
          this.tools.has(id) ? Promise.resolve<TerminalInfo[] | null>(null) : reads.terminals(id),
        ]).then(([sent, composer, list]) => {
          if (this.read.get(id)?.turn !== turn) return;
          if (list) this.tools.add(id);
          const last = lastMessage(sent);
          const tool = list ? list.at(-1)?.tool ?? '' : this.details.get(id)?.tool ?? '';
          this.details.set(id, { tool, unsent: unsent(composer.draft), ...(last ? { last } : {}) });
          this.changed();
        // After a failed read, the row keeps its earlier data. The next status change
        // reads it again.
        }).catch(() => {});
      }
    }
    // A session that ended leaves Home. A new terminal of it reads its data again.
    for (const id of [...this.details.keys()]) if (!shown.has(id)) this.details.delete(id);
    for (const id of [...this.read.keys()]) if (!shown.has(id)) this.read.delete(id);
    for (const id of [...this.tools]) if (!shown.has(id)) this.tools.delete(id);
    for (const id of [...this.extra.keys()]) if (!(id in this.statuses)) { this.extra.delete(id); this.asked.delete(id); }
  }
}

const serverReads = (server: ServerInfo): HomeReads => ({
  session: id => call(server, { operation: 'session-config', session: id }),
  sent: id => call(server, { operation: 'composer-sent', session: id }),
  draft: id => call(server, { operation: 'composer-draft', session: id }),
  terminals: id => call(server, { operation: 'session-terminals', session: id }),
});

interface Host {
  server(): ServerInfo | null;
  // Open a session of Home.
  open(session: SessionInfo): void;
  // Create a draft in a project and open it.
  draft(project: Project): void;
  // Open the Add project dialog.
  addProject(): void;
}

// HomeView shows Home: the New session menu, and the live sessions of all projects in
// the groups Running and Idle. The session list and the status watch supply the rows.
// Home reads the tool, the latest sent message, and the saved draft of each row.
export class HomeView {
  private readonly view = element('home', HTMLElement);
  private readonly problemLine = element('home-problem', HTMLElement);
  private readonly groups = element('home-groups', HTMLElement);
  private readonly empty = element('home-empty', HTMLElement);
  private readonly text = element('home-text', HTMLElement);
  private readonly addProject = element('home-add-project', HTMLButtonElement);
  private readonly items = element('home-new', HTMLElement);
  private readonly menu = new ActionMenu('home-new');
  private readonly rows: HomeRows;
  private projects: Project[] = [];
  // The first session list arrived. Before it, Home shows only a problem.
  private loaded = false;
  private trouble = '';
  private rendered = '';
  private menuProjects = '';

  constructor(private readonly host: Host) {
    this.rows = new HomeRows(() => {
      const server = host.server();
      return server ? serverReads(server) : null;
    }, () => this.render());
    this.addProject.onclick = () => host.addProject();
    // The times of the rows change without a message from the server.
    setInterval(() => this.render(), 30000);
    this.menu.controls();
  }

  get visible(): boolean { return !this.view.hidden; }

  // Show or hide Home. A shown Home reads the data of each row again. A hidden Home
  // reads nothing.
  show(visible: boolean): void {
    this.view.hidden = !visible;
    if (!visible) return;
    this.rows.reopen();
    this.refresh();
  }

  // Take the session list and the pushed statuses. The host calls it after each change.
  update(projects: Project[], listed: SessionInfo[], statuses: Record<string, string>): void {
    this.projects = projects;
    this.rows.update(listed, statuses);
    this.loaded = true;
    this.refresh();
  }

  // Show why the page cannot read the session list, or remove that text with ''. The
  // sidebar shows the same text, but Home can show without the sidebar. While the text
  // shows, the rows can be out of date, so Home shows them dimmed.
  problem(text: string): void {
    this.trouble = text;
    this.render();
  }

  // Turn the Add project button off while the page cannot add a project.
  controls(off: boolean): void { this.addProject.disabled = off; }

  private refresh(): void {
    if (this.loaded && this.visible) this.rows.load();
    this.render();
  }

  private render(): void {
    if (!this.visible) return;
    if (this.problemLine.textContent !== this.trouble) this.problemLine.textContent = this.trouble;
    this.problemLine.hidden = !this.trouble;
    this.view.classList.toggle('stale', !!this.trouble);
    if (!this.loaded) return;
    this.renderMenu();
    const { running, idle } = this.rows.groups();
    const now = Date.now();
    const row = (session: SessionInfo, status: string) => {
      const detail = this.rows.detail(session.id);
      return {
        id: session.id, status,
        title: sessionTitle(session) || 'Untitled session',
        place: placeLine(session, this.projects, session.parentId ? this.rows.session(session.parentId) : undefined, detail?.tool),
        // The group tells that a session runs, so only an idle row shows a time. The
        // update time of a running session changes with each list read. The row does not
        // show it, so it must not replace the buttons.
        time: status === 'idle' ? since(session.updated, now) : '',
        updated: status === 'idle' ? session.updated : '',
        tip: listStatusText(status, session),
        last: detail?.last?.text ?? '',
        sent: detail?.last ? since(detail.last.created, now) : '',
        unsent: !!detail?.unsent,
      };
    };
    const model = { text: homeText(this.projects.length), running: running.map(session => row(session, 'running')), idle: idle.map(session => row(session, 'idle')) };
    const fingerprint = JSON.stringify(model);
    if (fingerprint === this.rendered) return;
    this.rendered = fingerprint;
    this.text.textContent = model.text;
    this.empty.hidden = !model.text;
    // New buttons replace the rows. Give the keyboard focus to the new button of the same session.
    const focused = document.activeElement instanceof HTMLElement && this.groups.contains(document.activeElement) ? document.activeElement.dataset.session : undefined;
    this.groups.replaceChildren();
    // Without a project, no session can start from Home, so Home shows no groups.
    this.groups.hidden = !!model.text;
    if (model.text) return;
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
      section.setAttribute('aria-labelledby', heading.id);
      section.append(heading);
      // The count of the heading tells that a group has no session.
      if (!rows.length) { this.groups.append(section); continue; }
      const list = document.createElement('div');
      list.className = 'home-rows';
      for (const item of rows) {
        const button = document.createElement('button');
        button.className = 'home-row';
        button.dataset.session = item.id;
        const icon = document.createElement('span');
        icon.className = `status-icon ${item.status}`;
        icon.title = item.tip;
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
            sent.textContent = `${item.sent} ago`;
            message.append(' ', sent);
          }
          body.append(message);
        }
        if (item.unsent) {
          const chip = document.createElement('span');
          chip.className = 'home-chip';
          chip.textContent = 'Unsent message';
          body.append(chip);
        }
        button.append(icon, body);
        const session = byId.get(item.id)!;
        button.onclick = () => this.host.open(session);
        list.append(button);
      }
      section.append(list);
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
