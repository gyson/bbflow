import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countText, effectiveLayout, fileEntries, Generation, languageName, openFolders, sideNote, statusTitle, treeRows } from './dist/diff-model.js';

const change = (path, status = 'M', extra = {}) => ({ path, status, added: 1, removed: 2, ...extra });

test('changed scope lists only changes in path order', () => {
  const changes = [change('b.txt'), change('a.txt', 'A', { untracked: true })];
  assert.deepEqual(fileEntries(changes, ['c.txt'], 'changed', '').map(entry => entry.path), ['a.txt', 'b.txt']);
});

test('files scope merges unchanged paths with changes, including deleted files', () => {
  const changes = [change('gone.txt', 'D'), change('src/app.ts')];
  const entries = fileEntries(changes, ['README.md', 'src/app.ts'], 'files', '');
  assert.deepEqual(entries.map(entry => [entry.path, entry.change?.status ?? '']), [['README.md', ''], ['gone.txt', 'D'], ['src/app.ts', 'M']]);
});

test('the filter matches any part of the path without case', () => {
  const entries = fileEntries([change('web/src/Diff-Pane.ts'), change('docs/SPEC.md')], [], 'changed', ' diff ');
  assert.deepEqual(entries.map(entry => entry.path), ['web/src/Diff-Pane.ts']);
});

const folder = (path, entries, extra = {}) => [path, { path, entries, ...extra }];
const entry = (name, kind = 'file', extra = {}) => ({ name, kind, ...extra });
const shape = rows => rows.map(row => `${'  '.repeat(row.depth)}${row.kind}:${row.name}`);

test('the tree shows the entries of open folders below their folder', () => {
  const folders = new Map([
    folder('', [entry('docs', 'folder'), entry('src', 'folder'), entry('README.md'), entry('link', 'symlink')]),
    folder('src', [entry('deep', 'folder'), entry('main.go')]),
    folder('src/deep', []),
    folder('docs', [entry('hidden.md')]),
  ]);
  const rows = treeRows(folders, new Set(['src', 'src/deep']), []);
  assert.deepEqual(shape(rows), [
    'folder:docs', 'folder:src', '  folder:deep', '    note:Empty folder', '  file:main.go', 'file:README.md', 'symlink:link',
  ]);
  assert.deepEqual(rows.map(row => row.path), ['docs', 'src', 'src/deep', 'src/deep', 'src/main.go', 'README.md', 'link']);
  assert.deepEqual(rows.filter(row => row.expanded).map(row => row.path), ['src', 'src/deep']);
});

test('the tree has a note for a folder that is unread, missing, or too long', () => {
  assert.deepEqual(shape(treeRows(new Map(), new Set(), [])), ['note:Reading…']);
  const folders = new Map([
    folder('', [entry('a', 'folder'), entry('b', 'folder'), entry('c', 'folder'), entry('file', 'file')]),
    folder('b', [], { missing: true }),
    folder('c', [entry('one')], { truncated: true }),
  ]);
  const rows = shape(treeRows(folders, new Set(['a', 'b', 'c', 'file']), []));
  assert.equal(rows[1], '  note:Reading…');
  assert.match(rows[3], /^  note:This folder is not available now/);
  assert.equal(rows[5], '  file:one');
  assert.match(rows[6], /^  note:This folder has more entries/);
  // An open path that is not a folder has no entries.
  assert.equal(rows[7], 'file:file');
  assert.equal(rows.length, 8);
});

test('the tree marks changes, folders with changes, and ignored entries', () => {
  const folders = new Map([
    folder('', [entry('build', 'folder', { ignored: true }), entry('src', 'folder'), entry('vendor', 'folder'), entry('a.txt')]),
    folder('src', [entry('app.ts'), entry('same.ts')]),
  ]);
  const changes = [change('src/app.ts'), change('src/old/gone.ts', 'D'), change('vendor/lib', 'A', { untracked: true })];
  const rows = new Map(treeRows(folders, new Set(['src']), changes).map(row => [row.path, row]));
  assert.equal(rows.get('src/app.ts').change.status, 'M');
  assert.equal(rows.get('src/same.ts').change, undefined);
  assert.deepEqual(['src', 'vendor', 'build', 'a.txt'].map(path => rows.get(path).changed), [true, true, false, false]);
  assert.equal(rows.get('build').ignored, true);
  assert.equal(rows.get('src').ignored, false);
});

test('a folder request lists the workspace folder first and keeps parents within the limit', () => {
  const expanded = new Set(['src/deep', 'docs', 'src']);
  assert.deepEqual(openFolders(expanded, 200), ['', 'docs', 'src', 'src/deep']);
  assert.deepEqual(openFolders(expanded, 3), ['', 'docs', 'src']);
  assert.deepEqual(openFolders(new Set(), 200), ['']);
});

test('split changes to unified only in a narrow pane', () => {
  assert.equal(effectiveLayout('split', 519), 'unified');
  assert.equal(effectiveLayout('split', 520), 'split');
  assert.equal(effectiveLayout('unified', 2000), 'unified');
});

test('languages come from the file name', () => {
  assert.equal(languageName('internal/server/diff.go'), 'go');
  assert.equal(languageName('web/src/App.TSX'), 'tsx');
  assert.equal(languageName('src/main/scala/Board.scala'), 'scala');
  assert.equal(languageName('scripts/Setup.sc'), 'scala');
  assert.equal(languageName('build.sbt'), 'scala');
  assert.equal(languageName('scripts/release.sh'), 'shell');
  assert.equal(languageName('home/.zshrc'), 'shell');
  assert.equal(languageName('Makefile'), '');
  assert.equal(languageName('.gitignore'), '');
  assert.equal(languageName('archive.tar.gz'), '');
});

test('counts and titles describe each status', () => {
  assert.deepEqual(countText(change('a.txt')), { added: '+1', removed: '−2' });
  assert.deepEqual(countText(change('a.bin', 'M', { binary: true, added: -1, removed: -1 })), { added: 'binary', removed: '' });
  assert.deepEqual(countText(change('a.txt', 'A', { added: -1, removed: 0 })), { added: '', removed: '' });
  assert.equal(statusTitle(change('new', 'R', { oldPath: 'old' })), 'Renamed from old');
  assert.equal(statusTitle(change('new', 'A', { untracked: true })), 'Added, not tracked by Git');
  assert.equal(statusTitle(change('kept', 'M', { untracked: true })), 'Modified, not tracked by Git');
  assert.equal(statusTitle(change('x', 'D')), 'Deleted');
});

test('only text and missing sides have no note', () => {
  assert.equal(sideNote({ state: 'text', text: 'x', size: 1 }), '');
  assert.equal(sideNote({ state: 'missing', size: 0 }), '');
  assert.match(sideNote({ state: 'binary', size: 3 }), /Binary/);
  assert.match(sideNote({ state: 'tooLarge', size: 5 << 20 }), /1 MiB/);
  assert.match(sideNote({ state: 'other', size: 0 }), /folder/);
});

test('a late reply is not current', () => {
  const generation = new Generation();
  const first = generation.next();
  const second = generation.next();
  assert.equal(generation.current(first), false);
  assert.equal(generation.current(second), true);
});
