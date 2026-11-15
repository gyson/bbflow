import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countText, effectiveLayout, fileEntries, FolderTree, Generation, languageName, openFolders, sideNote, statusTitle, treeRows } from './dist/diff-model.js';

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

const reply = (...folders) => ({ folders: folders.map(([, value]) => value) });
const names = tree => shape(tree.rows([]));

test('only the latest request of a reopened folder applies its reply', () => {
  const tree = new FolderTree();
  tree.apply(reply(folder('', [entry('src', 'folder')])), tree.request(['']), true);
  tree.open('src');
  const first = tree.request(['src']);
  tree.close('src');
  tree.open('src');
  const second = tree.request(['src']);
  assert.deepEqual(tree.apply(reply(folder('src', [entry('new.go')])), second, false), []);
  // The earlier request ends last. Its reply and its failure are obsolete.
  assert.equal(tree.current('src', first), false);
  tree.apply(reply(folder('src', [entry('old.go')])), first, false);
  assert.deepEqual(names(tree), ['folder:src', '  file:new.go']);
  assert.equal(tree.isOpen('src'), true);
});

test('a reply for a closed folder, or for a folder below it, does nothing', () => {
  const tree = new FolderTree();
  tree.apply(reply(folder('', [entry('src', 'folder')])), tree.request(['']), true);
  tree.open('src');
  tree.open('src/deep');
  const token = tree.request(['src', 'src/deep']);
  tree.close('src');
  tree.apply(reply(folder('src', [entry('deep', 'folder')]), folder('src/deep', [entry('x.go')])), token, false);
  assert.equal(tree.current('src/deep', token), false);
  tree.open('src');
  assert.deepEqual(names(tree), ['folder:src', '  note:Reading…']);
});

test('a refresh at the shared entry limit keeps the shown entries of a folder', () => {
  const tree = new FolderTree();
  tree.apply(reply(folder('', [entry('big', 'folder'), entry('src', 'folder')])), tree.request(['']), true);
  for (const path of ['big', 'src']) {
    tree.open(path);
    tree.apply(reply(folder(path, [entry(`${path}.go`)])), tree.request([path]), false);
  }
  const shown = ['folder:big', '  file:big.go', 'folder:src', '  file:src.go'];
  assert.deepEqual(names(tree), shown);
  // The folders before src used the limit. The reply has no entries for src.
  const paths = tree.refreshPaths(200);
  const alone = tree.apply(reply(folder('', [entry('big', 'folder'), entry('src', 'folder')]), folder('big', [entry('big.go')]), folder('src', [], { truncated: true })), tree.request(paths), true);
  assert.deepEqual(alone, ['src']);
  assert.deepEqual(names(tree), shown);
  // The reply for src alone is complete. A folder that is too long alone shows its note.
  tree.apply(reply(folder('src', [entry('later.go')])), tree.request(['src']), false);
  assert.deepEqual(names(tree).slice(2), ['folder:src', '  file:later.go']);
  assert.deepEqual(tree.apply(reply(folder('src', [entry('one.go')], { truncated: true })), tree.request(['src']), false), []);
  assert.match(names(tree)[4], /^  note:This folder has more entries/);
});

test('a failed request keeps the shown entries of a folder and closes a folder without a list', () => {
  const tree = new FolderTree();
  tree.apply(reply(folder('', [entry('big', 'folder'), entry('new', 'folder'), entry('src', 'folder')])), tree.request(['']), true);
  for (const path of ['big', 'src']) {
    tree.open(path);
    tree.apply(reply(folder(path, [entry(`${path}.go`)])), tree.request([path]), false);
  }
  // A refresh at the shared limit asks for a request for src alone. That request fails.
  const refresh = tree.request(tree.refreshPaths(200));
  const alone = tree.apply(reply(folder('', [entry('big', 'folder'), entry('new', 'folder'), entry('src', 'folder')]), folder('big', [entry('big.go')]), folder('src', [], { truncated: true })), refresh, true);
  assert.deepEqual(alone, ['src']);
  tree.request(['src']);
  tree.fail('src');
  assert.equal(tree.isOpen('src'), true);
  assert.deepEqual(names(tree), ['folder:big', '  file:big.go', 'folder:new', 'folder:src', '  file:src.go']);
  // A folder that opens for the first time has no list. Its failed request closes it.
  tree.open('new');
  tree.request(['new']);
  tree.fail('new');
  assert.equal(tree.isOpen('new'), false);
  // The workspace folder never closes.
  tree.fail('');
  assert.equal(names(tree).length, 5);
});

test('a refresh closes a folder that is gone and the folders above the request limit', () => {
  const tree = new FolderTree();
  tree.apply(reply(folder('', [entry('a', 'folder'), entry('b', 'folder')])), tree.request(['']), true);
  for (const path of ['a', 'a/deep', 'b']) tree.open(path);
  // The reply for one opened folder keeps a folder that is gone, with a note.
  tree.apply(reply(folder('b', [], { missing: true })), tree.request(['b']), false);
  assert.equal(tree.isOpen('b'), true);
  assert.deepEqual(tree.refreshPaths(3), ['', 'a', 'a/deep']);
  assert.equal(tree.isOpen('b'), false);
  const token = tree.request(['', 'a', 'a/deep']);
  tree.apply(reply(folder('', [entry('b', 'folder')]), folder('a', [], { missing: true }), folder('a/deep', [], { missing: true })), token, true);
  assert.equal(tree.isOpen('a') || tree.isOpen('a/deep'), false);
  assert.deepEqual(names(tree), ['folder:b']);
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
