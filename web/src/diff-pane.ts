import { call, errorMessage } from './protocol.js';
import type { ChangedFile, DiffRequest, ServerInfo, WorkspaceChanges, WorkspaceFile, WorkspaceFiles } from './protocol.js';
import { ActionMenu } from './action-menu.js';
import { element } from './dom.js';
import { baselineMoved, baselineRequest, baseText, countText, effectiveLayout, fileEntries, FolderTree, Generation, hasSVG, imageSides, openable, scopeId, scopeLabel, scopeOf, scopeRange, scopeRequest, shortId, sideNote, statusTitle, stepScope, timelineHeading } from './diff-model.js';
import type { DiffLayout, FileEntry, FileScope, Scope, TreeRow } from './diff-model.js';
import { showDiff, showFile } from './diff-editor.js';
import type { CodeView } from './diff-editor.js';
import { showImages } from './image-view.js';
import { previewable, renderMarkdown } from './markdown.js';

type Send = typeof call;
export interface Editor { showDiff: typeof showDiff; showFile: typeof showFile; showImages: typeof showImages }

const maxFolderRequest = 200; // The server lists at most this number of folders in one request.
const listLimit = 'The file list is incomplete. bbflow limits the number of files that it lists.';
const errorTime = 6000; // An error message of the file menu shows for this time, in ms.

// One selected file of a view. preview shows the current file, not its diff.
interface Pick { path: string; preview: boolean }

// The key of a scope menu item. Commit IDs are hexadecimal, so this key is unique.
const uncommittedKey = ':uncommitted';

// DiffPane fills the Changes and Files views of the workspace pane. They share the
// change list and the folder tree. Changes shows the changed files and their diffs.
// Files shows the folders of the workspace and the current files. Each view has its own
// selected file and filter text. Both are read-only. The layout, the selections, and the
// open folders belong to this view. Other browser tabs keep their own state.
export class DiffPane {
  private readonly pane = element('diff-pane', HTMLElement);
  private readonly title = element('diff-title', HTMLElement);
  private readonly controls = element('diff-controls', HTMLElement);
  private readonly scopeButton = element('diff-scope', HTMLButtonElement);
  private readonly scopeIdText = element('diff-scope-id', HTMLElement);
  private readonly scopeText = element('diff-scope-label', HTMLElement);
  private readonly scopeMenu = element('diff-scope-menu', HTMLElement);
  private readonly splitButton = element('diff-split', HTMLButtonElement);
  private readonly unifiedButton = element('diff-unified', HTMLButtonElement);
  private readonly summary = element('diff-summary', HTMLElement);
  private readonly status = element('diff-status', HTMLElement);
  private readonly filter = element('diff-filter', HTMLInputElement);
  private readonly list = element('diff-list', HTMLElement);
  private readonly path = element('diff-path', HTMLElement);
  private readonly counts = element('diff-counts', HTMLElement);
  private readonly toggleButton = element('diff-toggle', HTMLButtonElement);
  private readonly sourceButton = element('diff-source', HTMLButtonElement);
  private readonly fileMenu = new ActionMenu('diff-menu');
  private readonly copyPathItem = element('diff-copy-path', HTMLButtonElement);
  private readonly copyRelativeItem = element('diff-copy-relative', HTMLButtonElement);
  private readonly revealLine = element('diff-reveal-line', HTMLElement);
  private readonly revealItem = element('diff-reveal', HTMLButtonElement);
  private readonly previewButton = element('diff-preview', HTMLButtonElement);
  private readonly openItem = element('diff-open', HTMLButtonElement);
  private readonly previewDialog = element('preview-dialog', HTMLDialogElement);
  private readonly previewTitle = element('preview-title', HTMLElement);
  private readonly previewBody = element('preview-body', HTMLElement);
  private readonly note = element('diff-note', HTMLElement);
  private readonly editorParent = element('diff-editor', HTMLElement);

  private session = '';
  private visible = false;
  private isOpen = false;
  private layout: DiffLayout = 'split';
  // An SVG file shows as an image. Source shows its text, or the diff of its text.
  private svgSource = false;
  private shownLayout: DiffLayout | null = null;
  private shownMode: 'file' | 'diff' | null = null; // What the editor shows now.
  private scope: FileScope = 'changed';
  // The selected baseline. Without a choice, the server uses its default.
  private choice: DiffRequest | undefined;
  private menuOpen = false;
  // The menu item whose dot starts a range. The next dot ends the range.
  private pending: string | null = null;
  private changes: WorkspaceChanges | null = null;
  // A file reply showed that the commit of the list is not in the history of HEAD now.
  // The pane reads no file until a list read succeeds. Thus a failed list read does not
  // start an automatic retry.
  private staleList = false;
  private changesError = '';
  // The paths that the filter searches in Files. They are present only during a search.
  private paths: WorkspaceFiles | null = null;
  private readonly tree = new FolderTree();
  private filesError = '';
  private ignoreError = '';
  private picks: Record<FileScope, Pick> = { changed: { path: '', preview: false }, files: { path: '', preview: true } };
  private filters: Record<FileScope, string> = { changed: '', files: '' };
  private file: WorkspaceFile | null = null;
  private view: CodeView | null = null;
  private refreshedAt = 0;
  private readonly listGeneration = new Generation();
  private readonly fileGeneration = new Generation();
  private listAbort: AbortController | null = null;
  private fileAbort: AbortController | null = null;
  // Counts the clicks of the file menu and the changes of its file. Only the result of
  // the latest click on the selected file shows.
  private menuRequest = 0;
  private menuSubject = ''; // The session and the file of the shown result.

  constructor(
    private readonly server: () => ServerInfo | null,
    private readonly send: Send = call,
    private readonly editor: Editor = { showDiff, showFile, showImages },
  ) {
    element('diff-refresh', HTMLButtonElement).onclick = () => void this.refresh();
    element('diff-close', HTMLButtonElement).onclick = () => this.close();
    element('diff-back', HTMLButtonElement).onclick = () => {
      this.setReading(false);
      // Give the focus to the row of the file, so that the keyboard continues there.
      for (const button of this.list.querySelectorAll('button')) {
        if (button.dataset.file === this.selected) button.focus();
      }
    };
    this.splitButton.onclick = () => this.setLayout('split');
    this.unifiedButton.onclick = () => this.setLayout('unified');
    this.filter.oninput = () => {
      if (this.searching() && !this.paths) return void this.refresh();
      // The next search reads the paths again.
      if (!this.searching()) this.paths = null;
      this.renderList();
      this.renderStatus();
    };
    this.scopeButton.onclick = () => this.setMenu(!this.menuOpen);
    // A click outside the menu closes it. The capture phase sees the click before a
    // handler can replace its target.
    document.addEventListener('click', event => {
      const target = event.target as Node | null;
      if (this.menuOpen && !this.scopeMenu.contains(target) && !this.scopeButton.contains(target)) this.setMenu(false);
    }, true);
    this.scopeMenu.addEventListener('pointerover', event => this.preview(event.target));
    this.scopeMenu.addEventListener('pointerleave', () => this.preview(null));
    this.pane.addEventListener('keydown', event => this.onKey(event));
    this.toggleButton.onclick = () => {
      if (!this.selected) return;
      // Files shows no diffs. Its button opens the diff of the file in Changes.
      if (this.scope === 'files') {
        this.picks.changed = { path: this.selected, preview: false };
        this.filters.changed = '';
        this.openChanges();
        // The change of the view showed the list. Show the diff of the file.
        this.setReading(true);
        return;
      }
      this.pick.preview = !this.pick.preview;
      this.renderFile();
    };
    this.sourceButton.onclick = () => {
      this.svgSource = !this.svgSource;
      this.renderFile();
    };
    this.copyPathItem.onclick = () => {
      const workspace = this.workspace(this.session);
      if (!workspace) return this.fileMenu.confirm('Cannot copy the path: the session workspace is not known.', errorTime);
      void this.copy(absolutePath(workspace, this.selected), 'Path copied');
    };
    this.copyRelativeItem.onclick = () => void this.copy(this.selected, 'Relative path copied');
    this.revealItem.onclick = () => this.reveal();
    this.previewButton.onclick = () => this.openPreview();
    this.openItem.onclick = () => this.openInBrowser();
    element('preview-close', HTMLButtonElement).onclick = () => this.previewDialog.close();
    // The divider of the file list changes the editor width without a change of the pane.
    const observer = new ResizeObserver(() => this.relayout());
    observer.observe(this.pane);
    observer.observe(this.editorParent);
    // Files change while agents work. Read them again when the user comes back.
    window.addEventListener('focus', () => {
      if (Date.now() - this.refreshedAt > 1000) void this.refresh();
    });
    this.show();
  }

  // Select the session of this view. An empty session, for a draft, Settings, or the
  // home page, has no changes. The state stays until the view selects another session.
  // The workspace pane hides this view before it selects a session. When the pane shows
  // the view again, the view reads the changes or files of the session.
  select(session: string): void {
    this.visible = !!session;
    if (!session || session === this.session) {
      this.show();
      return;
    }
    this.session = session;
    this.listAbort?.abort();
    this.fileAbort?.abort();
    this.listGeneration.next();
    this.fileGeneration.next();
    this.choice = undefined;
    this.menuOpen = false;
    this.pending = null;
    this.changes = this.paths = this.file = null;
    this.staleList = false;
    this.changesError = this.filesError = this.ignoreError = '';
    this.tree.clear();
    this.picks = { changed: { path: '', preview: false }, files: { path: '', preview: true } };
    this.filters = { changed: '', files: '' };
    this.filter.value = '';
    this.setReading(false);
    this.clearFile();
    this.list.replaceChildren();
    this.summary.textContent = '';
    this.setStatus('');
    this.show();
  }

  // The workspace pane sets these. close closes the pane. openChanges shows Changes.
  close: () => void = () => {};
  openChanges: () => void = () => {};
  // The page sets this. It gives the absolute workspace path of a session, or an empty
  // string when the page does not know it.
  workspace: (session: string) => string = () => '';

  // The workspace pane shows or hides the Changes or Files view. Without a scope, the
  // pane keeps its scope.
  setShown(open: boolean, scope = this.scope): void {
    if (open === this.isOpen && scope === this.scope) return;
    this.isOpen = open;
    if (scope !== this.scope) {
      this.filters[this.scope] = this.filter.value;
      this.scope = scope;
      this.filter.value = this.filters[scope];
      this.setReading(false);
      this.paths = null;
      this.renderList();
      this.renderStatus();
    }
    this.show();
    // A refresh also loads the selected file of the shown view.
    if (open) void this.refresh();
  }

  // A narrow pane shows the file list or the file view, not both. A click on a file
  // shows the file view, and Back shows the list. The CSS of a wider pane ignores this
  // state.
  private setReading(reading: boolean): void {
    this.pane.classList.toggle('reading', reading);
  }

  private get pick(): Pick { return this.picks[this.scope]; }
  private get selected(): string { return this.pick.path; }
  private get outsideGit(): boolean { return this.changes?.repository === false; }

  async refresh(): Promise<void> {
    const server = this.server();
    if (!this.isOpen || !this.visible || !this.session || !server) return;
    this.refreshedAt = Date.now();
    const generation = this.listGeneration.next();
    this.listAbort?.abort();
    const abort = this.listAbort = new AbortController();
    // A file request uses the baseline of the earlier list. Its reply must not change
    // the newer choice. This refresh reads the file again when its list arrives.
    this.fileAbort?.abort();
    this.fileGeneration.next();
    const session = this.session;
    if (!this.changes && !this.changesError) this.setStatus('Reading changes…');
    const files = this.scope === 'files';
    // Take the folders now. A click can open or close a folder during the request.
    const folderPaths = files ? this.tree.refreshPaths(maxFolderRequest) : [];
    const token = this.tree.request(folderPaths);
    // A folder whose read failed shows "Reading…" again during this request.
    if (files) this.renderList();
    const results = await Promise.allSettled([
      this.send(server, { operation: 'workspace-changes', session, diff: this.choice ?? {} }, abort.signal),
      files ? this.send(server, { operation: 'workspace-folders', session, diff: { folders: folderPaths } }, abort.signal) : null,
      this.searching() ? this.send(server, { operation: 'workspace-files', session }, abort.signal) : null,
    ]);
    if (!this.listGeneration.current(generation) || abort.signal.aborted) return;
    const [changes, folders, paths] = results;
    const failure = (result: PromiseSettledResult<unknown>): string => result.status === 'rejected' ? errorMessage(result.reason) : '';
    this.changesError = failure(changes);
    if (changes.status === 'fulfilled') {
      this.changes = changes.value;
      this.staleList = false;
      // The server uses its default baseline when a selected commit left the history of
      // HEAD, for example after a rebase. Keep that default after the next commit.
      if (this.choice && baselineMoved(this.choice, this.changes.baseline)) this.choice = undefined;
    }
    if (files) {
      this.filesError = failure(folders) || failure(paths);
      this.paths = paths.status === 'fulfilled' ? paths.value : null;
      if (folders.status === 'fulfilled' && folders.value) {
        this.ignoreError = folders.value.ignoreError ?? '';
        void this.readAlone(this.tree.apply(folders.value, token, true), generation);
      } else if (folders.status === 'rejected') {
        // The workspace folder has no list after a failure of its first read.
        if (this.tree.current('', token)) this.tree.fail('');
        // This request replaced the request of a folder that opened a moment ago.
        void this.readAlone(this.tree.unread(token), generation);
      }
    }
    this.renderScope();
    this.show();
    this.renderStatus();
    if (!files) this.selectChanged();
    this.renderList();
    void this.loadFile();
  }


  // A filter in Files searches all paths that Git knows. It shows a list, not the tree.
  private searching(): boolean {
    return this.scope === 'files' && !this.outsideGit && !!this.filter.value.trim();
  }

  private change(path: string): ChangedFile | undefined {
    return this.changes?.files.find(file => file.path === path);
  }

  private entries(): FileEntry[] {
    return fileEntries(this.changes?.files ?? [], this.paths?.paths ?? [], this.scope, this.filter.value);
  }

  // Changed always shows one of its files. Select the first file when the selected file
  // is not in the list.
  private selectChanged(): void {
    const entries = this.entries();
    if (entries.some(entry => entry.path === this.selected)) return;
    this.picks.changed = { path: entries[0]?.path ?? '', preview: false };
  }

  private toggleFolder(path: string): void {
    if (this.tree.isOpen(path)) {
      this.tree.close(path);
      this.renderList();
      return;
    }
    this.tree.open(path);
    this.renderList();
    void this.readFolder(path);
  }

  // Read one folder in its own request. A later request for the folder, or a close of
  // the folder, makes this request obsolete. Then its reply and its failure do nothing.
  // A failure keeps the shown entries of the folder and shows the error.
  //
  // A click on a folder shows the result of its own request. A read after a refresh
  // keeps the first error of that refresh, so that a later reply does not hide it.
  private async readFolder(path: string, afterRefresh = false): Promise<void> {
    const server = this.server();
    if (!server || (path && !this.tree.isOpen(path))) return;
    const token = this.tree.request([path]);
    try {
      const reply = await this.send(server, { operation: 'workspace-folders', session: this.session, diff: { folders: [path] } });
      if (!this.tree.current(path, token)) return;
      this.tree.apply(reply, token, false);
      this.ignoreError = reply.ignoreError ?? '';
      if (!afterRefresh) this.filesError = '';
    } catch (error) {
      if (!this.tree.current(path, token)) return;
      this.tree.fail(path);
      if (!afterRefresh || !this.filesError) this.filesError = errorMessage(error);
    }
    this.renderList();
    this.renderStatus();
  }

  // Read each of these folders in its own request, one after the other. Stop when a
  // newer refresh starts. Continue after a failure, because each folder needs its own
  // result. A folder without a result stays on "Reading…".
  private async readAlone(paths: string[], generation: number): Promise<void> {
    for (const path of paths) {
      if (!this.listGeneration.current(generation)) return;
      await this.readFolder(path, true);
    }
  }

  private show(): void {
    const changes = this.scope === 'changed';
    this.title.textContent = changes ? 'Changes' : 'Files';
    this.pane.setAttribute('aria-label', changes ? 'Changes' : 'Files');
    this.controls.hidden = !changes;
    this.filter.placeholder = changes ? 'Filter changes' : 'Filter files';
    this.filter.setAttribute('aria-label', this.filter.placeholder);
    // The pressed button is the shown layout. A narrow pane shows Unified, and Split
    // waits for a wider pane.
    const shown = effectiveLayout(this.layout, this.editorParent.clientWidth || Infinity);
    const waiting = this.layout === 'split' && shown === 'unified';
    this.splitButton.setAttribute('aria-pressed', String(shown === 'split'));
    this.unifiedButton.setAttribute('aria-pressed', String(shown === 'unified'));
    this.splitButton.classList.toggle('waiting', waiting);
    this.splitButton.title = waiting ? 'The pane is too narrow for Split. Widen the pane, or make the file list narrower.' : '';
    this.filter.disabled = this.outsideGit;
    this.filter.title = this.outsideGit ? 'The filter needs a Git repository.' : '';
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  // Show the most important problem of the shown file list.
  private renderStatus(): void {
    let text = '';
    if (this.scope === 'changed') {
      if (this.changesError) text = `Cannot read the changes: ${this.changesError}`;
      else if (this.changes?.truncated) text = listLimit;
    } else if (this.filesError) text = `Cannot read the files: ${this.filesError}`;
    else if (this.searching() && this.paths?.truncated) text = listLimit;
    else if (this.ignoreError) text = `Cannot mark the files that Git ignores: ${this.ignoreError}`;
    this.setStatus(text);
  }

  private setLayout(layout: DiffLayout): void {
    this.layout = layout;
    this.show();
    this.relayout();
  }

  // Use Unified when the pane is too narrow for Split. Keep the preferred layout.
  private relayout(): void {
    this.show();
    if (this.shownLayout && this.shownLayout !== effectiveLayout(this.layout, this.editorParent.clientWidth)) this.renderFile();
  }

  // The selected scope. A pending choice shows before its reply arrives.
  private currentScope(): Scope {
    const changes = this.changes;
    if (!changes?.repository) return { newer: 0, older: 0 };
    const source = this.choice ? { kind: this.choice.baseline, from: this.choice.from, to: this.choice.to } : changes.baseline;
    return scopeOf(source.kind, source.from, source.to, changes.commits) ?? { newer: 0, older: 0 };
  }

  // Select a scope and read its changes. A range of every item stays a range. It can
  // differ from All changes, for example when a commit merged the default branch.
  private choose(scope: Scope): void {
    const changes = this.changes;
    if (!changes?.repository) return;
    this.choice = scopeRequest(scope, changes.commits);
    this.renderScope();
    this.renderFileMenu();
    void this.refresh();
  }

  // The menu item of the pending dot, or -1.
  private pendingItem(): number {
    if (this.pending === uncommittedKey) return 0;
    const index = this.changes?.commits.findIndex(commit => commit.id === this.pending) ?? -1;
    return index < 0 ? -1 : index + 1;
  }

  private itemKey(item: number): string {
    return item === 0 ? uncommittedKey : this.changes?.commits[item - 1]?.id ?? uncommittedKey;
  }

  private setMenu(open: boolean): void {
    this.menuOpen = open;
    this.pending = null;
    this.renderMenu();
  }

  // The first dot selects its item and waits for a second dot. The second dot selects
  // the items between the two dots. The same dot again cancels the range.
  private clickDot(item: number): void {
    const first = this.pendingItem();
    if (first < 0) {
      this.pending = this.itemKey(item);
      this.choose({ newer: item, older: item });
      return;
    }
    this.pending = null;
    if (first === item) this.renderMenu();
    else this.choose(scopeRange(first, item));
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.menuOpen) {
      event.preventDefault();
      if (this.pending !== null) {
        this.pending = null;
        this.renderMenu();
      } else {
        this.setMenu(false);
        this.scopeButton.focus();
      }
      return;
    }
    // [ and ] step to the older or the newer item. Typing in a field and other key
    // combinations keep their usual effect. The read-only diff editor does not type.
    if ((event.key !== '[' && event.key !== ']') || event.metaKey || event.ctrlKey || event.altKey) return;
    const changes = this.changes;
    const target = event.target as HTMLElement | null;
    if (this.scope !== 'changed' || !changes?.repository || this.scopeButton.disabled) return;
    if (target?.closest?.('input, textarea, select') || (target?.isContentEditable && !this.editorParent.contains(target))) return;
    event.preventDefault();
    const next = stepScope(this.currentScope(), event.key === '[', changes.commits.length + 1);
    if (!next) return;
    this.pending = null;
    this.choose(next);
  }

  // While a dot waits for the second dot, the pointer over another dot shows the range
  // that a click selects.
  private preview(target: EventTarget | null): void {
    for (const element of this.scopeMenu.querySelectorAll('.preview')) element.classList.remove('preview');
    const dot = (target as HTMLElement | null)?.closest?.<HTMLElement>('.scope-dot');
    const first = this.pendingItem();
    const item = dot ? Number(dot.dataset.item) : first;
    if (first < 0 || item === first) return;
    const newer = Math.min(first, item), older = Math.max(first, item);
    for (const row of this.scopeMenu.querySelectorAll<HTMLElement>('.scope-row')) {
      const index = Number(row.dataset.item);
      if (index < newer || index > older) continue;
      row.classList.add('preview');
      if (index > newer) row.querySelector('.rail-up')?.classList.add('preview');
      if (index < older) row.querySelector('.rail-down')?.classList.add('preview');
    }
  }

  // The scope button shows the selected changes. A single commit shows its short ID and
  // its subject.
  private renderScope(): void {
    const changes = this.changes;
    const commits = changes?.repository ? changes.commits : [];
    const scope = this.currentScope();
    const id = scopeId(scope, commits), label = scopeLabel(scope, commits);
    this.scopeIdText.textContent = id;
    this.scopeIdText.hidden = !id;
    this.scopeText.textContent = label;
    this.scopeButton.title = id ? `${id} ${label}` : label;
    // Keep the menu open to its notice of omitted commits.
    this.scopeButton.disabled = !changes?.repository || (commits.length === 0 && !changes.base && !changes.moreCommits);
    if (this.scopeButton.disabled) this.menuOpen = false;
    const files = changes?.files ?? [];
    this.summary.textContent = changes?.repository ? `${files.length} ${files.length === 1 ? 'file' : 'files'}` : '';
    this.renderMenu();
  }

  // The menu has All changes, then a timeline with the uncommitted changes and the
  // commits, newest first. Item 0 is the uncommitted changes. Each row has a dot. Rails
  // join the dots, and the rails of the selected items use the accent color.
  private renderMenu(): void {
    this.scopeButton.setAttribute('aria-expanded', String(this.menuOpen));
    this.scopeMenu.hidden = !this.menuOpen;
    const changes = this.changes;
    if (!this.menuOpen || !changes?.repository) {
      this.scopeMenu.replaceChildren();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const focused = active && this.scopeMenu.contains(active) ? { kind: active.className, item: active.dataset.item } : null;
    const commits = changes.commits, scope = this.currentScope(), all = scope === 'all';
    const range = scope === 'all' ? { newer: 0, older: commits.length } : scope;
    const pending = this.pendingItem();
    // The dots fill only for a range or All changes. One selected item highlights only
    // its row, because the dots select ranges.
    const linked = all || range.newer !== range.older;
    const parts: HTMLElement[] = [];
    if (changes.base) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scope-all';
      button.setAttribute('aria-pressed', String(all));
      button.append(textSpan('scope-subject', 'All changes'), textSpan('scope-meta', baseText(changes.base)));
      button.onclick = () => {
        this.pending = null;
        this.choose('all');
      };
      parts.push(button);
    }
    parts.push(textSpan('scope-heading', timelineHeading(changes.base)));
    const timeline = document.createElement('div');
    timeline.className = 'scope-timeline';
    const last = commits.length;
    for (let item = 0; item <= last; item++) {
      const commit = commits[item - 1];
      const selected = item >= range.newer && item <= range.older;
      const row = document.createElement('div');
      row.className = 'scope-row' + (selected ? ' in' : '') + (selected && linked ? ' linked' : '') + (item === pending ? ' pending' : '');
      row.dataset.item = String(item);
      const gutter = textSpan('scope-gutter', '');
      // The last rail continues to the notice of omitted commits. All changes includes
      // those commits.
      const up = textSpan('scope-rail rail-up' + (item === 0 ? ' none' : '') + (selected && item > range.newer ? ' on' : ''), '');
      const down = textSpan('scope-rail rail-down' + (item === last && !changes.moreCommits ? ' none' : '') +
        (selected && (item < range.older || (all && changes.moreCommits)) ? ' on' : ''), '');
      const name = commit ? `${shortId(commit.id)} ${commit.subject}` : 'Uncommitted changes';
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'scope-dot' + (commit ? '' : ' uncommitted');
      dot.dataset.item = String(item);
      dot.title = pending < 0 ? `Start a range at ${name}` : pending === item ? 'Cancel the range' : `End the range at ${name}`;
      dot.setAttribute('aria-label', dot.title);
      dot.onclick = () => this.clickDot(item);
      gutter.append(up, down, dot);
      const text = document.createElement('button');
      text.type = 'button';
      text.className = 'scope-text';
      text.dataset.item = String(item);
      text.setAttribute('aria-pressed', String(selected && range.newer === range.older && !all));
      text.title = commit ? `Show only commit ${name}` : 'Show only the uncommitted changes in the current files, with untracked files';
      const subject = document.createElement('span');
      subject.className = 'scope-subject';
      if (commit) subject.append(textSpan('scope-id', shortId(commit.id)), ` ${commit.subject}`);
      else subject.textContent = 'Uncommitted changes';
      const count = textSpan('scope-count', commit ? String(commit.files) : '');
      if (commit) count.title = `${commit.files} ${commit.files === 1 ? 'file' : 'files'} changed`;
      text.append(subject, count);
      // The row leaves the page when the menu closes. The focus goes to the scope button,
      // so that [ and ] still step.
      text.onclick = () => {
        this.pending = null;
        this.menuOpen = false;
        this.choose({ newer: item, older: item });
        this.scopeButton.focus();
      };
      row.append(gutter, text);
      timeline.append(row);
    }
    parts.push(timeline);
    if (changes.moreCommits) parts.push(textSpan('scope-note', 'Older commits are not listed.'));
    parts.push(textSpan('scope-hint', pending >= 0
      ? 'Click a second dot to show all changes between the two dots. Click the same dot, or press Escape, to cancel.'
      : 'Click a row to show one change. Click two dots to show all changes between them. Press [ or ] to step.'));
    this.scopeMenu.replaceChildren(...parts);
    if (!focused) return;
    for (const button of this.scopeMenu.querySelectorAll<HTMLElement>('button')) {
      if (button.className !== focused.kind || button.dataset.item !== focused.item) continue;
      button.focus({ preventScroll: true });
      return;
    }
  }

  private renderList(): void {
    if (this.scope === 'files' && !this.searching()) {
      this.setRows(this.tree.rows(this.changes?.files ?? []).map(row => this.treeItem(row)));
      return;
    }
    const entries = this.entries();
    if (entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'diff-empty';
      empty.textContent = this.filter.value.trim() ? 'No files match the filter.' :
        this.outsideGit ? `${this.changes?.reason || 'Not a Git repository.'} Files shows the workspace.` : 'No changes.';
      this.setRows([empty]);
      return;
    }
    this.setRows(entries.map(entry => this.listItem(entry)));
  }

  // Replace the rows of the list. Keep the keyboard focus on the row of the same path,
  // so that Tab continues from an opened folder to its entries.
  private setRows(rows: HTMLLIElement[]): void {
    const active = document.activeElement;
    const focused = active instanceof HTMLButtonElement && this.list.contains(active) ? { ...active.dataset } : null;
    this.list.replaceChildren(...rows);
    if (!focused) return;
    for (const button of this.list.querySelectorAll('button')) {
      if (button.dataset.folder !== focused.folder || button.dataset.file !== focused.file) continue;
      button.focus({ preventScroll: true });
      return;
    }
  }

  // One row of the Files tree. A folder opens and closes. Other entries open in the
  // file view.
  private treeItem(row: TreeRow): HTMLLIElement {
    const item = document.createElement('li');
    const indent = `${10 + row.depth * 14}px`;
    if (row.kind === 'note') {
      item.className = 'diff-empty tree-note';
      item.style.paddingLeft = indent;
      item.textContent = row.name;
      return item;
    }
    const folder = row.kind === 'folder';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'diff-file tree-row' + (row.ignored ? ' ignored' : '');
    button.style.paddingLeft = indent;
    const twisty = document.createElement('span');
    twisty.className = 'tree-twisty';
    twisty.textContent = folder ? row.expanded ? '▾' : '▸' : '';
    const status = document.createElement('span');
    status.className = `diff-status-letter status-${row.change ? row.change.status : 'none'}`;
    status.textContent = row.change ? row.change.status : row.changed ? '•' : '';
    button.title = row.change ? `${statusTitle(row.change)}: ${row.path}` : row.changed ? `Has changes: ${row.path}` : row.ignored ? `Ignored by Git: ${row.path}` : row.path;
    button.append(twisty, pathLabel(row.name), status);
    if (folder) {
      button.dataset.folder = row.path;
      button.setAttribute('aria-expanded', String(row.expanded));
      button.onclick = () => this.toggleFolder(row.path);
    } else {
      button.dataset.file = row.path;
      button.setAttribute('aria-current', String(row.path === this.selected));
      button.onclick = () => this.open(row.path, true);
    }
    item.append(button);
    return item;
  }

  // Select a file. A file from Files opens in the file view. A file from Changes opens
  // as a diff.
  private open(path: string, preview: boolean): void {
    this.picks[this.scope] = { path, preview };
    this.setReading(true);
    for (const button of this.list.querySelectorAll('button')) {
      if (button.dataset.file !== undefined) button.setAttribute('aria-current', String(button.dataset.file === path));
    }
    if (this.file?.path === path) this.renderFile();
    void this.loadFile();
  }

  private listItem(entry: FileEntry): HTMLLIElement {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'diff-file' + (entry.change ? '' : ' unchanged');
    button.dataset.file = entry.path;
    button.setAttribute('aria-current', String(entry.path === this.selected));
    button.title = entry.change ? `${statusTitle(entry.change)}: ${entry.path}` : entry.path;
    const status = document.createElement('span');
    status.className = `diff-status-letter status-${entry.change ? entry.change.status : 'none'}`;
    status.textContent = entry.change ? entry.change.status : '·';
    button.append(status, pathLabel(entry.path));
    button.onclick = () => this.open(entry.path, this.scope === 'files');
    item.append(button);
    return item;
  }

  private async loadFile(): Promise<void> {
    const server = this.server();
    this.fileAbort?.abort();
    const generation = this.fileGeneration.next();
    if (!server || !this.selected) {
      this.clearFile();
      return;
    }
    if (this.staleList) {
      this.clearFile();
      this.showNote('The selected changes are not in the history of HEAD now. Click Refresh to read the changes again.');
      return;
    }
    const path = this.selected;
    const change = this.change(path);
    // Remove the previous file at once. A refresh of the same file keeps it in view.
    if (this.file?.path !== path) {
      this.destroyView();
      this.file = null;
      this.showNote('');
    }
    this.renderHeader();
    const abort = this.fileAbort = new AbortController();
    try {
      // The server reads a file outside Git without a baseline. Files shows the current
      // files, so its file requests do not end at a commit.
      const baseline = this.changes?.repository ? baselineRequest(this.changes.baseline) : {};
      if (this.scope === 'files') delete baseline.to;
      const diff = { ...baseline, path, ...(change?.oldPath ? { oldPath: change.oldPath } : {}) };
      const file = await this.send(server, { operation: 'workspace-file', session: this.session, diff }, abort.signal);
      if (!this.fileGeneration.current(generation)) return;
      // A selected commit or the base left the history of HEAD after the list was read.
      // The server then used the default baseline. Read the list again, so that the menu, the
      // counts, and the diff use the same baseline.
      if (baselineMoved(diff, file.baseline)) {
        this.staleList = true;
        this.choice = undefined;
        return void this.refresh();
      }
      // Keep the scroll position when a refresh finds the same content in the same mode.
      // Changes and Files can show the same file as a diff and as plain text.
      if (this.view && this.shownMode === this.mode(file) && JSON.stringify(file) === JSON.stringify(this.file)) return;
      this.file = file;
      this.renderFile();
    } catch (error) {
      if (!this.fileGeneration.current(generation) || abort.signal.aborted) return;
      this.file = null;
      this.previewButton.hidden = this.sourceButton.hidden = true;
      this.renderFileMenu();
      this.destroyView();
      this.showNote(`Cannot read this file: ${errorMessage(error)}`);
    }
  }

  private renderHeader(): void {
    const change = this.change(this.selected);
    this.path.replaceChildren(pathLabel(this.selected));
    this.path.title = change?.oldPath ? `${change.oldPath} → ${this.selected}` : this.selected;
    // Files shows no line counts. It shows the current file only.
    const counts = change && this.scope === 'changed' ? countText(change) : { added: '', removed: '' };
    const added = document.createElement('span');
    added.className = 'added';
    added.textContent = counts.added;
    const removed = document.createElement('span');
    removed.className = 'removed';
    removed.textContent = counts.removed;
    this.counts.replaceChildren(added, removed);
    if (!change && this.changes?.repository && this.scope === 'changed') {
      const tag = document.createElement('span');
      tag.className = 'diff-tag';
      tag.textContent = 'Unchanged';
      this.counts.append(tag);
    }
    this.toggleButton.hidden = !change;
    this.toggleButton.textContent = this.pick.preview ? 'View diff' : 'View file';
    const to = this.changes?.repository ? this.changes.baseline.to : undefined;
    this.toggleButton.title = this.scope === 'files' ? 'Show the diff of this file in Changes' :
      this.pick.preview ? 'Show the diff' : to ? `Show the file at commit ${shortId(to)}` : 'Show the current file';
    this.previewButton.hidden = !this.previewFile();
    const file = this.file;
    this.sourceButton.hidden = !file || file.path !== this.selected || !hasSVG(file, this.mode(file) === 'diff', this.change(file.path)?.oldPath);
    this.sourceButton.textContent = this.svgSource ? 'View image' : 'View source';
    this.sourceButton.title = this.svgSource ? 'Show the SVG file as an image' : 'Show the text of the SVG file';
    this.renderFileMenu();
  }

  // The file menu shows for a selected file. Show in Finder shows only for a current
  // file that is in the workspace now. Open in browser shows only for such an HTML file.
  private renderFileMenu(): void {
    // A result is about its file. Another file or session ends the result, and a later
    // reply of an earlier click does not show.
    const subject = `${this.session}\n${this.selected}`;
    if (subject !== this.menuSubject) {
      this.menuSubject = subject;
      this.menuRequest++;
      this.fileMenu.clear();
    }
    this.copyPathItem.hidden = this.copyRelativeItem.hidden = !this.selected;
    this.revealItem.hidden = !this.revealFile();
    this.openItem.hidden = !this.openFile();
    this.revealLine.hidden = this.revealItem.hidden && this.openItem.hidden;
    this.fileMenu.controls();
  }

  // Copy a path of the selected file. The tooltip of the menu button shows the result.
  private async copy(text: string, done: string): Promise<void> {
    await this.fileRequest(done, 'Cannot copy the path', () => navigator.clipboard.writeText(text));
  }

  // The loaded file of the selection, when the view shows its current version and the
  // file is in the workspace now. A scope that ends at a commit does not show the
  // current file. Thus the item goes away when Changes selects such a scope, before the
  // file reply. A file that the pane read at a commit is not the current file either,
  // also after Changes selects another scope. The server rejects a symlink, so the item
  // does not show for one.
  private revealFile(): WorkspaceFile | null {
    if (this.scope === 'changed' && this.choice?.to) return null;
    const file = this.file;
    return file && file.path === this.selected && !file.baseline.to && file.new.state !== 'missing' && !file.new.symlink ? file : null;
  }

  // The loaded file of the selection, when it is a current HTML file that the browser can
  // open. The rules of revealFile also apply.
  private openFile(): WorkspaceFile | null {
    if (this.scope === 'changed' && this.choice?.to) return null;
    const file = this.file;
    return file && file.path === this.selected && openable(file) ? file : null;
  }

  // Ask the server to show the selected file in Finder. Finder selects the file and does
  // not open it.
  private reveal(): void {
    const server = this.server();
    const file = this.revealFile();
    if (!server || !file) return;
    void this.fileRequest('Shown in Finder', 'Cannot show the file in Finder',
      () => this.send(server, { operation: 'workspace-reveal', session: this.session, diff: { path: file.path } }));
  }

  // Ask the server to open the current file in the default browser. The browser loads
  // the file itself, so a later change shows after a reload in the browser.
  private openInBrowser(): void {
    const server = this.server();
    const file = this.openFile();
    if (!server || !file) return;
    void this.fileRequest('Opened in browser', 'Cannot open the file in the browser',
      () => this.send(server, { operation: 'workspace-open', session: this.session, diff: { path: file.path } }));
  }

  // Run the action of a file menu item. The tooltip of the menu button shows the result.
  // The result names the action. An error also gives the reason. Only the result of the
  // latest click shows, and only while its file stays selected. See renderFileMenu.
  private async fileRequest(done: string, failed: string, send: () => Promise<unknown>): Promise<void> {
    const request = ++this.menuRequest;
    let text = done;
    let duration: number | undefined;
    try {
      await send();
    } catch (error) {
      text = `${failed}: ${errorMessage(error)}`;
      duration = errorTime;
    }
    if (request === this.menuRequest) this.fileMenu.confirm(text, duration);
  }

  // The loaded file of the selection, when it is a Markdown file that Preview can show.
  private previewFile(): WorkspaceFile | null {
    const file = this.file;
    return file && file.path === this.selected && previewable(file) ? file : null;
  }

  // Show the rendered text of the loaded file. The dialog keeps this text until it
  // closes. Refresh reads the file again, and the next Preview shows the new text.
  private openPreview(): void {
    const file = this.previewFile();
    if (!file) return;
    this.previewTitle.replaceChildren(pathLabel(file.path));
    this.previewTitle.title = file.path;
    // renderMarkdown escapes the file text and adds no raw HTML from it.
    this.previewBody.innerHTML = renderMarkdown(file.new.text ?? '');
    this.previewBody.scrollTop = 0;
    this.previewDialog.showModal();
  }

  private renderFile(): void {
    this.destroyView();
    this.renderHeader();
    const file = this.file;
    if (!file || file.path !== this.selected) return;
    this.shownMode = this.mode(file);
    const layout = effectiveLayout(this.layout, this.editorParent.clientWidth);
    if (this.shownMode === 'file') {
      const side = file.new;
      // In Changes, a scope that ends at a commit shows the file at that commit.
      const to = this.scope === 'changed' && file.baseline.to ? shortId(file.baseline.to) : '';
      if (side.state === 'missing') return this.showNote(to ? `This file is not in commit ${to}.` : 'This file is not in the workspace now.');
      const images = imageSides(file, false, !this.svgSource);
      if (images) {
        this.showNote(to ? `The file at commit ${to}.` : '');
        this.view = this.editor.showImages(this.editorParent, images, layout);
        return;
      }
      if (side.state !== 'text') return this.showNote(sideNote(side));
      this.showNote([to ? `The file at commit ${to}.` : '', side.symlink ? 'Symbolic link. The text is the link target.' : ''].filter(Boolean).join(' '));
      this.view = this.editor.showFile(this.editorParent, file.path, side.text ?? '');
      return;
    }
    // A side that is not an image shows its text or a note in its place.
    const images = imageSides(file, true, !this.svgSource, this.change(file.path)?.oldPath);
    if (images) {
      this.showNote('');
      this.view = this.editor.showImages(this.editorParent, images, layout);
      this.shownLayout = layout;
      return;
    }
    const blocked = [file.old, file.new].map(sideNote).find(Boolean);
    if (blocked) return this.showNote(blocked);
    this.showNote(file.old.symlink || file.new.symlink ? 'Symbolic link. The text is the link target.' : '');
    this.view = this.editor.showDiff(this.editorParent, file.path, file.old.text ?? '', file.new.text ?? '', layout);
    this.shownLayout = layout;
  }

  // A file without a change, or a file that the view previews, shows as plain text.
  private mode(file: WorkspaceFile): 'file' | 'diff' {
    return !this.change(file.path) || this.pick.preview ? 'file' : 'diff';
  }

  private showNote(text: string): void {
    this.note.textContent = text;
    this.note.hidden = !text;
  }

  private destroyView(): void {
    this.view?.destroy();
    this.view = null;
    this.shownLayout = this.shownMode = null;
    this.editorParent.replaceChildren();
  }

  private clearFile(): void {
    this.destroyView();
    this.file = null;
    this.path.replaceChildren();
    this.counts.replaceChildren();
    this.toggleButton.hidden = this.previewButton.hidden = this.sourceButton.hidden = true;
    this.renderFileMenu();
    this.showNote('');
  }
}

// Join the absolute workspace path and a path relative to it.
export function absolutePath(workspace: string, path: string): string {
  return `${workspace.replace(/\/+$/, '')}/${path}`;
}

function textSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

// Show the file name in full and shorten its folder first. A long path then keeps its
// most useful part in view.
function pathLabel(path: string): HTMLSpanElement {
  const label = document.createElement('span');
  label.className = 'diff-name';
  const slash = path.lastIndexOf('/') + 1;
  if (slash > 0) {
    const folder = document.createElement('span');
    folder.className = 'diff-folder';
    folder.textContent = path.slice(0, slash);
    label.append(folder);
  }
  const name = document.createElement('span');
  name.className = 'diff-base';
  name.textContent = path.slice(slash);
  label.append(name);
  return label;
}
