import { call, errorMessage } from './protocol.js';
import type { BaselineKind, ChangedFile, ServerInfo, WorkspaceChanges, WorkspaceFile, WorkspaceFiles } from './protocol.js';
import { dragDivider } from './divider-drag.js';
import { element } from './dom.js';
import { countText, effectiveLayout, fileEntries, FolderTree, Generation, sideNote, statusTitle } from './diff-model.js';
import type { DiffLayout, FileEntry, FileScope, TreeRow } from './diff-model.js';
import { showDiff, showFile } from './diff-editor.js';
import type { CodeView } from './diff-editor.js';

type Send = typeof call;
export interface Editor { showDiff: typeof showDiff; showFile: typeof showFile }

const minPaneWidth = 320;
const minSessionWidth = 360;
const maxFolderRequest = 200; // The server lists at most this number of folders in one request.
const listLimit = 'The file list is incomplete. BonBon limits the number of files that it lists.';

// DiffPane shows the changed files and the folders of the selected session workspace.
// It is read-only. Its layout, width, file selection, file list scope, and open folders
// belong to this view. Other browser tabs keep their own state.
export class DiffPane {
  private readonly openButton = element('diff-open', HTMLButtonElement);
  private readonly row = element('session-row', HTMLElement);
  private readonly pane = element('diff-pane', HTMLElement);
  private readonly divider = element('diff-divider', HTMLElement);
  private readonly baselineSelect = element('diff-baseline', HTMLSelectElement);
  private readonly splitButton = element('diff-split', HTMLButtonElement);
  private readonly unifiedButton = element('diff-unified', HTMLButtonElement);
  private readonly summary = element('diff-summary', HTMLElement);
  private readonly status = element('diff-status', HTMLElement);
  private readonly changedButton = element('diff-changed', HTMLButtonElement);
  private readonly filesButton = element('diff-files-tab', HTMLButtonElement);
  private readonly filter = element('diff-filter', HTMLInputElement);
  private readonly list = element('diff-list', HTMLElement);
  private readonly path = element('diff-path', HTMLElement);
  private readonly counts = element('diff-counts', HTMLElement);
  private readonly toggleButton = element('diff-toggle', HTMLButtonElement);
  private readonly copyButton = element('diff-copy', HTMLButtonElement);
  private readonly note = element('diff-note', HTMLElement);
  private readonly editorParent = element('diff-editor', HTMLElement);

  private session = '';
  private visible = false;
  private isOpen = false;
  private layout: DiffLayout = 'split';
  private shownLayout: DiffLayout | null = null;
  private scope: FileScope = 'changed';
  private baseline: BaselineKind | undefined;
  // The worktree base commit from the latest reply that had it. The label keeps it when
  // the user selects Uncommitted changes, so the menu text stays the same.
  private baseCommit = '';
  private changes: WorkspaceChanges | null = null;
  private changesError = '';
  // The paths that the filter searches in Files. They are present only during a search.
  private paths: WorkspaceFiles | null = null;
  private readonly tree = new FolderTree();
  private filesError = '';
  private ignoreError = '';
  private selected = '';
  private preview = false; // Show the current file, not its diff.
  private file: WorkspaceFile | null = null;
  private view: CodeView | null = null;
  private width = 0;
  private refreshedAt = 0;
  private readonly listGeneration = new Generation();
  private readonly fileGeneration = new Generation();
  private listAbort: AbortController | null = null;
  private fileAbort: AbortController | null = null;

  constructor(
    private readonly server: () => ServerInfo | null,
    private readonly send: Send = call,
    private readonly editor: Editor = { showDiff, showFile },
  ) {
    this.openButton.onclick = () => this.toggle();
    element('diff-close', HTMLButtonElement).onclick = () => this.toggle(false);
    element('diff-refresh', HTMLButtonElement).onclick = () => void this.refresh();
    this.splitButton.onclick = () => this.setLayout('split');
    this.unifiedButton.onclick = () => this.setLayout('unified');
    this.changedButton.onclick = () => this.setScope('changed');
    this.filesButton.onclick = () => this.setScope('files');
    this.filter.oninput = () => {
      if (this.searching() && !this.paths) return void this.refresh();
      // The next search reads the paths again.
      if (!this.searching()) this.paths = null;
      this.renderList();
      this.renderStatus();
    };
    this.baselineSelect.onchange = () => {
      this.baseline = this.baselineSelect.value === 'base' ? 'base' : 'head';
      void this.refresh();
    };
    this.toggleButton.onclick = () => {
      if (!this.selected) return;
      this.preview = !this.preview;
      this.renderFile();
    };
    this.copyButton.onclick = async () => {
      try {
        await navigator.clipboard.writeText(this.selected);
        this.copyButton.textContent = 'Copied';
      } catch (error) {
        this.copyButton.textContent = 'Copy failed';
        this.copyButton.title = errorMessage(error);
      }
      setTimeout(() => { this.copyButton.textContent = 'Copy path'; this.copyButton.title = ''; }, 1500);
    };
    dragDivider(this.divider, 'x', 'resizing-diff', {
      start: () => this.pane.getBoundingClientRect().width,
      // A drag to the left makes the pane wider.
      move: (width, offset) => this.resize(width - offset),
    });
    this.divider.onkeydown = event => {
      const width = this.pane.getBoundingClientRect().width;
      if (event.key === 'ArrowLeft') this.resize(width + 20);
      else if (event.key === 'ArrowRight') this.resize(width - 20);
      else return;
      event.preventDefault();
    };
    new ResizeObserver(() => this.relayout()).observe(this.pane);
    // Files change while agents work. Read them again when the user comes back.
    window.addEventListener('focus', () => {
      if (Date.now() - this.refreshedAt > 1000) void this.refresh();
    });
    this.show();
  }

  // Select the session of this view. An empty session, for a draft, Settings, or the
  // home page, hides the pane. The state stays until the view selects another session.
  select(session: string): void {
    this.visible = !!session;
    if (!session || session === this.session) {
      this.show();
      if (session && this.isOpen) void this.refresh();
      return;
    }
    this.session = session;
    this.listAbort?.abort();
    this.fileAbort?.abort();
    this.listGeneration.next();
    this.fileGeneration.next();
    this.baseline = undefined;
    this.baseCommit = '';
    this.changes = this.paths = this.file = null;
    this.changesError = this.filesError = this.ignoreError = '';
    this.tree.clear();
    this.selected = '';
    this.preview = false;
    this.filter.value = '';
    this.clearFile();
    this.list.replaceChildren();
    this.summary.textContent = '';
    this.setStatus('');
    this.show();
    if (this.isOpen) void this.refresh();
  }

  toggle(open = !this.isOpen): void {
    this.isOpen = open;
    this.show();
    if (open) void this.refresh();
  }

  async refresh(): Promise<void> {
    const server = this.server();
    if (!this.isOpen || !this.visible || !this.session || !server) return;
    this.refreshedAt = Date.now();
    const generation = this.listGeneration.next();
    this.listAbort?.abort();
    const abort = this.listAbort = new AbortController();
    const session = this.session;
    if (!this.changes && !this.changesError) this.setStatus('Reading changes…');
    const files = this.shownScope() === 'files';
    // Take the folders now. A click can open or close a folder during the request.
    const folderPaths = files ? this.tree.refreshPaths(maxFolderRequest) : [];
    const token = this.tree.request(folderPaths);
    const results = await Promise.allSettled([
      this.send(server, { operation: 'workspace-changes', session, diff: this.baseline ? { baseline: this.baseline } : {} }, abort.signal),
      files ? this.send(server, { operation: 'workspace-folders', session, diff: { folders: folderPaths } }, abort.signal) : null,
      this.searching() ? this.send(server, { operation: 'workspace-files', session }, abort.signal) : null,
    ]);
    if (!this.listGeneration.current(generation) || abort.signal.aborted) return;
    const [changes, folders, paths] = results;
    const failure = (result: PromiseSettledResult<unknown>): string => result.status === 'rejected' ? errorMessage(result.reason) : '';
    this.changesError = failure(changes);
    if (changes.status === 'fulfilled') this.changes = changes.value;
    // A folder outside Git shows Files. Read them now.
    if (!files && this.shownScope() === 'files') return this.refresh();
    if (files) {
      this.filesError = failure(folders) || failure(paths);
      this.paths = paths.status === 'fulfilled' ? paths.value : null;
      if (folders.status === 'fulfilled' && folders.value) {
        this.ignoreError = folders.value.ignoreError ?? '';
        void this.readAlone(this.tree.apply(folders.value, token, true), generation);
      } else if (folders.status === 'rejected') {
        // This request replaced the request of a folder that opened a moment ago.
        void this.readAlone(this.tree.unread(token), generation);
      }
    }
    this.renderBaseline();
    this.show();
    this.renderStatus();
    if (!files) this.selectChanged();
    this.renderList();
    void this.loadFile();
  }

  // A folder outside Git has no changes. It always shows Files.
  private shownScope(): FileScope {
    return this.changes?.repository === false ? 'files' : this.scope;
  }

  // A filter in Files searches all paths that Git knows. It shows a list, not the tree.
  private searching(): boolean {
    return this.shownScope() === 'files' && this.changes?.repository !== false && !!this.filter.value.trim();
  }

  private change(path: string): ChangedFile | undefined {
    return this.changes?.files.find(file => file.path === path);
  }

  private entries(): FileEntry[] {
    return fileEntries(this.changes?.files ?? [], this.paths?.paths ?? [], this.shownScope(), this.filter.value);
  }

  // Changed always shows one of its files. Select the first file when the selected file
  // is not in the list.
  private selectChanged(): void {
    const entries = this.entries();
    if (entries.some(entry => entry.path === this.selected)) return;
    this.selected = entries[0]?.path ?? '';
    this.preview = false;
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
    this.openButton.hidden = !this.visible;
    this.openButton.setAttribute('aria-pressed', String(this.isOpen));
    const label = this.isOpen ? 'Hide changes and files' : 'Show changes and files';
    this.openButton.setAttribute('aria-label', label);
    this.openButton.dataset.tip = label;
    this.pane.hidden = this.divider.hidden = !this.isOpen || !this.visible;
    // The pressed button is the shown layout. A narrow pane shows Unified, and Split
    // waits for a wider pane.
    const shown = effectiveLayout(this.layout, this.editorParent.clientWidth || Infinity);
    const waiting = this.layout === 'split' && shown === 'unified';
    this.splitButton.setAttribute('aria-pressed', String(shown === 'split'));
    this.unifiedButton.setAttribute('aria-pressed', String(shown === 'unified'));
    this.splitButton.classList.toggle('waiting', waiting);
    this.splitButton.title = waiting ? 'The pane is too narrow for Split. Drag the divider to the left to widen the pane.' : '';
    const scope = this.shownScope();
    const outside = this.changes?.repository === false;
    this.changedButton.setAttribute('aria-pressed', String(scope === 'changed'));
    this.filesButton.setAttribute('aria-pressed', String(scope === 'files'));
    this.changedButton.disabled = this.filter.disabled = outside;
    this.changedButton.title = outside ? this.changes?.reason || 'Not a Git repository.' : '';
    this.filter.title = outside ? 'The filter needs a Git repository.' : '';
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  // Show the most important problem of the shown file list.
  private renderStatus(): void {
    let text = '';
    if (this.shownScope() === 'changed') {
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

  private setScope(scope: FileScope): void {
    this.scope = scope;
    this.show();
    this.renderList();
    this.renderStatus();
    void this.refresh();
  }

  private resize(width: number): void {
    const max = Math.max(minPaneWidth, this.row.clientWidth - minSessionWidth);
    this.width = Math.round(Math.max(minPaneWidth, Math.min(max, width)));
    this.pane.style.flexBasis = `${this.width}px`;
  }

  // Use Unified when the pane is too narrow for Split. Keep the preferred layout.
  private relayout(): void {
    this.show();
    if (this.shownLayout && this.shownLayout !== effectiveLayout(this.layout, this.editorParent.clientWidth)) this.renderFile();
  }

  private renderBaseline(): void {
    const changes = this.changes;
    const options: HTMLOptionElement[] = [];
    if (changes?.baseline.kind === 'base') this.baseCommit = changes.baseline.commit.slice(0, 7);
    if (changes?.base) options.push(new Option(this.baseCommit ? `Since worktree base (${this.baseCommit})` : 'Since worktree base', 'base'));
    options.push(new Option('Uncommitted changes', 'head'));
    this.baselineSelect.replaceChildren(...options);
    // A folder outside Git has an empty baseline.
    this.baselineSelect.value = changes?.baseline.kind || 'head';
    this.baselineSelect.disabled = !changes?.repository || options.length < 2;
    const files = changes?.files ?? [];
    this.summary.textContent = changes?.repository ? `${files.length} ${files.length === 1 ? 'file' : 'files'}` : '';
  }

  private renderList(): void {
    if (this.shownScope() === 'files' && !this.searching()) {
      this.setRows(this.tree.rows(this.changes?.files ?? []).map(row => this.treeItem(row)));
      return;
    }
    const entries = this.entries();
    if (entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'diff-empty';
      empty.textContent = this.filter.value.trim() ? 'No files match the filter.' : 'No changes.';
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

  // Select a file. A file from Files opens in the file view. A file from Changed opens
  // as a diff.
  private open(path: string, preview: boolean): void {
    this.selected = path;
    this.preview = preview;
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
    button.onclick = () => this.open(entry.path, this.shownScope() === 'files');
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
      // The server reads a file outside Git without a baseline.
      const baseline = this.changes?.repository ? { baseline: this.changes.baseline.kind } : {};
      const diff = { ...baseline, path, ...(change?.oldPath ? { oldPath: change.oldPath } : {}) };
      const file = await this.send(server, { operation: 'workspace-file', session: this.session, diff }, abort.signal);
      if (!this.fileGeneration.current(generation)) return;
      // Keep the scroll position when a refresh finds the same content.
      if (this.view && JSON.stringify(file) === JSON.stringify(this.file)) return;
      this.file = file;
      this.renderFile();
    } catch (error) {
      if (!this.fileGeneration.current(generation) || abort.signal.aborted) return;
      this.file = null;
      this.destroyView();
      this.showNote(`Cannot read this file: ${errorMessage(error)}`);
    }
  }

  private renderHeader(): void {
    const change = this.change(this.selected);
    this.path.replaceChildren(pathLabel(this.selected));
    this.path.title = change?.oldPath ? `${change.oldPath} → ${this.selected}` : this.selected;
    const counts = change ? countText(change) : { added: '', removed: '' };
    const added = document.createElement('span');
    added.className = 'added';
    added.textContent = counts.added;
    const removed = document.createElement('span');
    removed.className = 'removed';
    removed.textContent = counts.removed;
    this.counts.replaceChildren(added, removed);
    if (!change && this.changes?.repository) {
      const tag = document.createElement('span');
      tag.className = 'diff-tag';
      tag.textContent = 'Unchanged';
      this.counts.append(tag);
    }
    this.toggleButton.hidden = !change;
    this.toggleButton.textContent = this.preview ? 'View diff' : 'View file';
    this.copyButton.hidden = !this.selected;
  }

  private renderFile(): void {
    this.destroyView();
    this.renderHeader();
    const file = this.file;
    if (!file || file.path !== this.selected) return;
    if (!this.change(file.path) || this.preview) {
      const side = file.new;
      if (side.state === 'missing') return this.showNote('This file is not in the workspace now.');
      if (side.state !== 'text') return this.showNote(sideNote(side));
      this.showNote(side.symlink ? 'Symbolic link. The text is the link target.' : '');
      this.view = this.editor.showFile(this.editorParent, file.path, side.text ?? '');
      return;
    }
    const blocked = [file.old, file.new].map(sideNote).find(Boolean);
    if (blocked) return this.showNote(blocked);
    this.showNote(file.old.symlink || file.new.symlink ? 'Symbolic link. The text is the link target.' : '');
    const layout = effectiveLayout(this.layout, this.editorParent.clientWidth);
    this.view = this.editor.showDiff(this.editorParent, file.path, file.old.text ?? '', file.new.text ?? '', layout);
    this.shownLayout = layout;
  }

  private showNote(text: string): void {
    this.note.textContent = text;
    this.note.hidden = !text;
  }

  private destroyView(): void {
    this.view?.destroy();
    this.view = null;
    this.shownLayout = null;
    this.editorParent.replaceChildren();
  }

  private clearFile(): void {
    this.destroyView();
    this.file = null;
    this.path.replaceChildren();
    this.counts.replaceChildren();
    this.toggleButton.hidden = this.copyButton.hidden = true;
    this.showNote('');
  }
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
