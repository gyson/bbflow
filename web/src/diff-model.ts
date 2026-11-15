import type { ChangedFile, FileSide, FolderEntry, WorkspaceFolder, WorkspaceFolders } from './protocol.js';

export type DiffLayout = 'split' | 'unified';
export type FileScope = 'changed' | 'files';

// One row of the file list. An unchanged file has no change.
export interface FileEntry { path: string; change?: ChangedFile }

// Below this width of the editor area, the split layout is too narrow to read.
export const splitMinWidth = 520;

export function effectiveLayout(preferred: DiffLayout, width: number): DiffLayout {
  return preferred === 'split' && width < splitMinWidth ? 'unified' : preferred;
}

// Changed lists only changed files. Files lists every workspace path that Git knows and
// marks changed files. It is the result of the filter in Files. Deleted files stay in
// it, because they are changes.
export function fileEntries(changes: ChangedFile[], paths: string[], scope: FileScope, query: string): FileEntry[] {
  const byPath = new Map(changes.map(change => [change.path, change]));
  let entries: FileEntry[];
  if (scope === 'changed') {
    entries = changes.map(change => ({ path: change.path, change }));
  } else {
    const all = new Set([...paths, ...byPath.keys()]);
    entries = [...all].map(path => {
      const change = byPath.get(path);
      return change ? { path, change } : { path };
    });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const needle = query.trim().toLowerCase();
  return needle ? entries.filter(entry => entry.path.toLowerCase().includes(needle)) : entries;
}

// One row of the Files tree. A note row has a text about its folder as the name.
export interface TreeRow {
  path: string;
  name: string;
  depth: number;
  kind: FolderEntry['kind'] | 'note';
  ignored: boolean;
  expanded: boolean;
  change: ChangedFile | undefined;
  changed: boolean; // A folder with a changed file below it.
}

// List the rows of the Files tree in display order. The key of the workspace folder is
// an empty path. An open folder shows its entries, or a note until its list arrives.
export function treeRows(folders: ReadonlyMap<string, WorkspaceFolder>, expanded: ReadonlySet<string>, changes: ChangedFile[]): TreeRow[] {
  const byPath = new Map(changes.map(change => [change.path, change]));
  // A deleted file is not in a folder list. The mark on its folder shows the change.
  const changedFolders = new Set<string>();
  for (const { path } of changes) {
    for (let slash = path.indexOf('/'); slash > 0; slash = path.indexOf('/', slash + 1)) changedFolders.add(path.slice(0, slash));
  }
  const rows: TreeRow[] = [];
  const add = (parent: string, depth: number): void => {
    const note = (name: string): void => {
      rows.push({ path: parent, name, depth, kind: 'note', ignored: false, expanded: false, change: undefined, changed: false });
    };
    const folder = folders.get(parent);
    if (!folder) return note('Reading…');
    if (folder.missing) return note('This folder is not available now.');
    for (const entry of folder.entries) {
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      const open = entry.kind === 'folder' && expanded.has(path);
      rows.push({ path, name: entry.name, depth, kind: entry.kind, ignored: !!entry.ignored, expanded: open, change: byPath.get(path), changed: changedFolders.has(path) });
      if (open) add(path, depth + 1);
    }
    if (folder.truncated) note('This folder has more entries. BonBon limits the number of entries that it lists.');
    else if (folder.entries.length === 0) note('Empty folder');
  };
  add('', 0);
  return rows;
}

// The folders of one list request: the workspace folder, then the open folders in path
// order. A parent comes before its folders, so a limit keeps the parents.
export function openFolders(expanded: ReadonlySet<string>, limit: number): string[] {
  return ['', ...[...expanded].sort()].slice(0, limit);
}

// FolderTree holds the open folders of the Files tree and their lists. Each request
// takes a token for its folders. Only the latest request of an open folder applies its
// reply. Thus an earlier reply cannot replace newer entries or close a reopened folder.
export class FolderTree {
  private readonly folders = new Map<string, WorkspaceFolder>();
  private readonly expanded = new Set<string>();
  private readonly reads = new Map<string, object>();

  clear(): void {
    this.folders.clear();
    this.expanded.clear();
    this.reads.clear();
  }

  isOpen(path: string): boolean { return this.expanded.has(path); }
  open(path: string): void { this.expanded.add(path); }

  // Close a folder and the folders below it. Their requests become obsolete, and a
  // refresh does not list them.
  close(path: string): void {
    for (const open of [...this.expanded]) {
      if (open !== path && !open.startsWith(`${path}/`)) continue;
      this.expanded.delete(open);
      this.folders.delete(open);
      this.reads.delete(open);
    }
  }

  // The folders of a refresh request. One request has a folder limit. Close the open
  // folders above it.
  refreshPaths(limit: number): string[] {
    const paths = openFolders(this.expanded, limit);
    const listed = new Set(paths);
    for (const path of [...this.expanded]) if (!listed.has(path)) this.close(path);
    return paths;
  }

  // Start a request for these folders. Earlier requests for them become obsolete.
  request(paths: string[]): object {
    const token = {};
    for (const path of paths) this.reads.set(path, token);
    return token;
  }

  // Report that the request of this token is the latest request for the folder.
  current(path: string, token: object): boolean { return this.reads.get(path) === token; }

  // Apply the reply of a request. Skip a folder that a later request reads or that the
  // user closed. Return the folders that need a request of their own.
  //
  // The folders of one reply share the entry limit. A truncated folder in a reply for
  // more than one folder can thus have fewer entries than its own reply has. Keep its
  // shown entries until its own reply arrives. A refresh closes a folder that is gone.
  // The reply for one opened folder keeps it, with a note.
  apply(reply: WorkspaceFolders, token: object, refresh: boolean): string[] {
    const alone: string[] = [];
    for (const folder of reply.folders) {
      if (!this.current(folder.path, token)) continue;
      if (folder.truncated && reply.folders.length > 1) alone.push(folder.path);
      else if (folder.missing && folder.path && refresh) this.close(folder.path);
      else this.folders.set(folder.path, folder);
    }
    return alone;
  }

  rows(changes: ChangedFile[]): TreeRow[] { return treeRows(this.folders, this.expanded, changes); }
}

export function statusTitle(change: ChangedFile): string {
  if (change.untracked) return change.status === 'M' ? 'Modified, not tracked by Git' : 'Added, not tracked by Git';
  switch (change.status) {
    case 'A': return 'Added';
    case 'D': return 'Deleted';
    case 'R': return `Renamed from ${change.oldPath ?? ''}`;
    case 'T': return 'Type changed';
    default: return 'Modified';
  }
}

// Counts are -1 when the server does not know them, for example for a binary file.
export function countText(change: ChangedFile): { added: string; removed: string } {
  if (change.binary) return { added: 'binary', removed: '' };
  return {
    added: change.added >= 0 ? `+${change.added}` : '',
    removed: change.removed > 0 ? `−${change.removed}` : '',
  };
}

// Explain a side that has no text to show. Return an empty string for text.
export function sideNote(side: FileSide): string {
  switch (side.state) {
    case 'binary': return 'Binary file. BonBon does not show its content.';
    case 'tooLarge': return 'This file is larger than 1 MiB. BonBon does not show its content.';
    case 'other': return 'This path is a folder, a submodule, or a special file.';
    default: return '';
  }
}

export type Language = 'javascript' | 'jsx' | 'typescript' | 'tsx' | 'go' | 'python' | 'json' | 'markdown' | 'css' | 'html' | 'yaml' | 'rust' | 'scala' | 'shell' | '';

const extensions: Record<string, Language> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', mts: 'typescript',
  cts: 'typescript', tsx: 'tsx', go: 'go', py: 'python', json: 'json', md: 'markdown', markdown: 'markdown',
  css: 'css', html: 'html', htm: 'html', yaml: 'yaml', yml: 'yaml', rs: 'rust', scala: 'scala', sc: 'scala',
  sbt: 'scala', sh: 'shell', bash: 'shell', zsh: 'shell',
};

export function languageName(path: string): Language {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (['.bashrc', '.zshrc', '.profile'].includes(name)) return 'shell';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? extensions[name.slice(dot + 1)] ?? '' : '';
}

// Each request takes a new number. A reply for an older number is late. A late reply
// must not replace a newer view.
export class Generation {
  private value = 0;
  next(): number { return ++this.value; }
  current(value: number): boolean { return value === this.value; }
}
