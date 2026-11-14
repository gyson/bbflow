import type { ChangedFile, FileSide } from './protocol.js';

export type DiffLayout = 'split' | 'unified';
export type FileScope = 'changed' | 'all';

// One row of the file list. An unchanged file has no change.
export interface FileEntry { path: string; change?: ChangedFile }

// Below this width of the editor area, the split layout is too narrow to read.
export const splitMinWidth = 520;

export function effectiveLayout(preferred: DiffLayout, width: number): DiffLayout {
  return preferred === 'split' && width < splitMinWidth ? 'unified' : preferred;
}

// Changed lists only changed files. All lists every workspace path and marks changed
// files. Deleted files stay in All, because they are changes.
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
