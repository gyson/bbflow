import { call, errorMessage } from './protocol.js';
import type { BaselineKind, ServerInfo, WorkspaceChanges, WorkspaceFile, WorkspaceFiles } from './protocol.js';
import { dragDivider } from './divider-drag.js';
import { element } from './dom.js';
import { countText, effectiveLayout, fileEntries, Generation, sideNote, statusTitle } from './diff-model.js';
import type { DiffLayout, FileEntry, FileScope } from './diff-model.js';
import { showDiff, showFile } from './diff-editor.js';
import type { CodeView } from './diff-editor.js';

type Send = typeof call;
export interface Editor { showDiff: typeof showDiff; showFile: typeof showFile }

const minPaneWidth = 320;
const minSessionWidth = 360;

// DiffPane shows the changed files of the selected session workspace. It is read-only.
// Its layout, width, file selection, and file list scope belong to this view. Other
// browser tabs keep their own state.
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
  private readonly allButton = element('diff-all', HTMLButtonElement);
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
  private changes: WorkspaceChanges | null = null;
  private paths: WorkspaceFiles | null = null;
  private selected = '';
  private readonly previews = new Set<string>();
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
    this.allButton.onclick = () => this.setScope('all');
    this.filter.oninput = () => this.renderList();
    this.baselineSelect.onchange = () => {
      this.baseline = this.baselineSelect.value === 'base' ? 'base' : 'head';
      void this.refresh();
    };
    this.toggleButton.onclick = () => {
      if (!this.selected) return;
      if (this.previews.has(this.selected)) this.previews.delete(this.selected);
      else this.previews.add(this.selected);
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
    this.changes = this.paths = this.file = null;
    this.selected = '';
    this.previews.clear();
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
    if (!this.changes) this.setStatus('Reading changes…');
    try {
      const diff = this.baseline ? { baseline: this.baseline } : {};
      const [changes, paths] = await Promise.all([
        this.send(server, { operation: 'workspace-changes', session, diff }, abort.signal),
        this.scope === 'all' ? this.send(server, { operation: 'workspace-files', session }, abort.signal) : Promise.resolve(this.paths),
      ]);
      if (!this.listGeneration.current(generation)) return;
      this.changes = changes;
      this.paths = paths;
      this.renderBaseline();
      if (!changes.repository) {
        this.setStatus(changes.reason || 'Not a Git repository.');
        this.list.replaceChildren();
        this.selected = '';
        this.clearFile();
        return;
      }
      const truncated = changes.truncated || (this.scope === 'all' && paths?.truncated);
      this.setStatus(truncated ? 'The file list is incomplete. BonBon limits the number of files that it lists.' : '');
      const entries = this.entries();
      if (!entries.some(entry => entry.path === this.selected)) this.selected = entries[0]?.path ?? '';
      this.renderList();
      void this.loadFile();
    } catch (error) {
      if (!this.listGeneration.current(generation) || abort.signal.aborted) return;
      this.setStatus(`Cannot read the changes: ${errorMessage(error)}`);
    }
  }

  private entries(): FileEntry[] {
    return fileEntries(this.changes?.files ?? [], this.paths?.paths ?? [], this.scope, this.filter.value);
  }

  private show(): void {
    this.openButton.hidden = !this.visible;
    this.openButton.setAttribute('aria-pressed', String(this.isOpen));
    this.pane.hidden = this.divider.hidden = !this.isOpen || !this.visible;
    // The pressed button is the shown layout. A narrow pane shows Unified, and Split
    // waits for a wider pane.
    const shown = effectiveLayout(this.layout, this.editorParent.clientWidth || Infinity);
    const waiting = this.layout === 'split' && shown === 'unified';
    this.splitButton.setAttribute('aria-pressed', String(shown === 'split'));
    this.unifiedButton.setAttribute('aria-pressed', String(shown === 'unified'));
    this.splitButton.classList.toggle('waiting', waiting);
    this.splitButton.title = waiting ? 'The pane is too narrow for Split. Drag the divider to the left to widen the pane.' : '';
    this.changedButton.setAttribute('aria-pressed', String(this.scope === 'changed'));
    this.allButton.setAttribute('aria-pressed', String(this.scope === 'all'));
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  private setLayout(layout: DiffLayout): void {
    this.layout = layout;
    this.show();
    this.relayout();
  }

  private setScope(scope: FileScope): void {
    this.scope = scope;
    this.show();
    if (scope === 'all' && !this.paths) void this.refresh();
    else this.renderList();
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
    if (changes?.base) options.push(new Option(changes.baseline.kind === 'base' ? `Since worktree base (${changes.baseline.commit.slice(0, 7)})` : 'Since worktree base', 'base'));
    options.push(new Option('Uncommitted changes', 'head'));
    this.baselineSelect.replaceChildren(...options);
    this.baselineSelect.value = changes?.baseline.kind ?? 'head';
    this.baselineSelect.disabled = !changes?.repository || options.length < 2;
    const files = changes?.files ?? [];
    this.summary.textContent = changes?.repository ? `${files.length} ${files.length === 1 ? 'file' : 'files'}` : '';
  }

  private renderList(): void {
    const entries = this.entries();
    if (entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'diff-empty';
      empty.textContent = this.filter.value.trim() ? 'No files match the filter.' : this.scope === 'changed' ? 'No changes.' : 'No files.';
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(...entries.map(entry => this.listItem(entry)));
  }

  private listItem(entry: FileEntry): HTMLLIElement {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'diff-file' + (entry.change ? '' : ' unchanged');
    button.setAttribute('aria-current', String(entry.path === this.selected));
    button.title = entry.change ? `${statusTitle(entry.change)}: ${entry.path}` : entry.path;
    const status = document.createElement('span');
    status.className = `diff-status-letter status-${entry.change ? entry.change.status : 'none'}`;
    status.textContent = entry.change ? entry.change.status : '·';
    button.append(status, pathLabel(entry.path));
    button.onclick = () => {
      this.selected = entry.path;
      for (const other of this.list.querySelectorAll('button')) other.setAttribute('aria-current', String(other === button));
      void this.loadFile();
    };
    item.append(button);
    return item;
  }

  private async loadFile(): Promise<void> {
    const server = this.server();
    const changes = this.changes;
    this.fileAbort?.abort();
    const generation = this.fileGeneration.next();
    if (!server || !changes?.repository || !this.selected) {
      this.clearFile();
      return;
    }
    const path = this.selected;
    const change = changes.files.find(file => file.path === path);
    // Remove the previous file at once. A refresh of the same file keeps it in view.
    if (this.file?.path !== path) {
      this.destroyView();
      this.file = null;
      this.showNote('');
    }
    this.renderHeader();
    const abort = this.fileAbort = new AbortController();
    try {
      const diff = { baseline: changes.baseline.kind, path, ...(change?.oldPath ? { oldPath: change.oldPath } : {}) };
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
    const change = this.changes?.files.find(file => file.path === this.selected);
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
    if (!change) {
      const tag = document.createElement('span');
      tag.className = 'diff-tag';
      tag.textContent = 'Unchanged';
      this.counts.append(tag);
    }
    this.toggleButton.hidden = !change;
    this.toggleButton.textContent = this.previews.has(this.selected) ? 'View diff' : 'View file';
    this.copyButton.hidden = !this.selected;
  }

  private renderFile(): void {
    this.destroyView();
    this.renderHeader();
    const file = this.file;
    if (!file || file.path !== this.selected) return;
    const change = this.changes?.files.find(entry => entry.path === file.path);
    if (!change || this.previews.has(file.path)) {
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
