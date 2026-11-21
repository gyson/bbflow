import { test } from 'node:test';
import assert from 'node:assert/strict';

// Node has no DOMParser. This test double reads the root element of the fixture text.
// The browser check covers the real XML parser.
class FixtureParser {
  static types = [];
  parseFromString(text, type) {
    FixtureParser.types.push(type);
    const broken = text.includes('<broken');
    const tag = /<([^\s?!/>][^\s>/]*)([^>]*)>/.exec(text);
    let root = null;
    if (tag) {
      const colon = tag[1].indexOf(':');
      const prefix = colon < 0 ? '' : tag[1].slice(0, colon);
      const namespace = new RegExp(`xmlns${prefix ? `:${prefix}` : ''}="([^"]*)"`).exec(tag[2]);
      root = { localName: tag[1].slice(colon + 1), namespaceURI: namespace ? namespace[1] : null };
    }
    return { documentElement: root, getElementsByTagNameNS: (ns, name) => name === 'parsererror' && broken ? [{}] : [] };
  }
}
globalThis.DOMParser = FixtureParser;
import { baselineMoved, baselineRequest, baseText, countText, effectiveLayout, fileEntries, fenceLanguage, FolderTree, Generation, hasSVG, imageDetails, imageSides, isSVG, svgRoot, languageName, openFolders, scopeId, scopeLabel, scopeOf, scopeRange, scopeRequest, sideImage, sideNote, sizeText, statusTitle, stepScope, timelineHeading, treeRows } from './dist/diff-model.js';

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

test('a failed first read of the workspace folder shows a note until the next request', () => {
  const tree = new FolderTree();
  tree.request(['']);
  assert.deepEqual(names(tree), ['note:Reading…']);
  tree.fail('');
  assert.deepEqual(names(tree), ['note:Cannot read this folder. Click Refresh to try again.']);
  // A refresh starts a new request. The note shows that the read is in progress again.
  const token = tree.request(tree.refreshPaths(200));
  assert.deepEqual(names(tree), ['note:Reading…']);
  tree.apply(reply(folder('', [entry('a.txt')])), token, true);
  assert.deepEqual(names(tree), ['file:a.txt']);
  // A later failure keeps the shown entries.
  tree.request(['']);
  tree.fail('');
  assert.deepEqual(names(tree), ['file:a.txt']);
  // A new session starts without the note.
  tree.fail('');
  tree.clear();
  tree.request(['']);
  assert.deepEqual(names(tree), ['note:Reading…']);
});

test('a failed refresh names the open folders that have no list', () => {
  const tree = new FolderTree();
  tree.apply(reply(folder('', [entry('a', 'folder'), entry('b', 'folder'), entry('c', 'folder')])), tree.request(['']), true);
  tree.open('a');
  tree.apply(reply(folder('a', [entry('a.go')])), tree.request(['a']), false);
  // The refresh replaces the first request of b. Then c opens with a request of its own.
  tree.open('b');
  const first = tree.request(['b']);
  const refresh = tree.request(tree.refreshPaths(200));
  tree.open('c');
  tree.request(['c']);
  assert.equal(tree.current('b', first), false);
  assert.deepEqual(tree.unread(refresh), ['b']);
  // A reply of the refresh for b ends the wait.
  tree.apply(reply(folder('b', [entry('b.go')])), refresh, true);
  assert.deepEqual(tree.unread(refresh), []);
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

test('fenced code languages come from the first word of the info string', () => {
  assert.equal(fenceLanguage('go'), 'go');
  assert.equal(fenceLanguage('golang'), 'go');
  assert.equal(fenceLanguage(' TS title=app.ts'), 'typescript');
  assert.equal(fenceLanguage('Python'), 'python');
  assert.equal(fenceLanguage('bash'), 'shell');
  assert.equal(fenceLanguage('md'), 'markdown');
  assert.equal(fenceLanguage(''), '');
  assert.equal(fenceLanguage('text'), '');
  assert.equal(fenceLanguage('constructor'), '');
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
  assert.match(sideNote({ state: 'tooLarge', size: 5 << 20 }), /1 MiB for text and 5 MiB for PNG, JPEG, GIF, and WebP images/);
  assert.match(sideNote({ state: 'other', size: 0 }), /folder/);
});

test('a late reply is not current', () => {
  const generation = new Generation();
  const first = generation.next();
  const second = generation.next();
  assert.equal(generation.current(first), false);
  assert.equal(generation.current(second), true);
});

const ids = ['c'.repeat(40), 'b'.repeat(40), 'a'.repeat(40)];
const listed = [{ id: ids[0], subject: 'Newest', files: 2 }, { id: ids[1], subject: 'Middle', files: 1 }, { id: ids[2], subject: 'Oldest', files: 3 }];

test('a scope maps to its request and back', () => {
  // Item 0 is the uncommitted changes. Item k is commit k - 1 of the list, newest first.
  const cases = [
    ['all', { baseline: 'base' }],
    [{ newer: 0, older: 0 }, { baseline: 'head' }],
    [{ newer: 2, older: 2 }, { baseline: 'commit', from: ids[1], to: ids[1] }],
    [{ newer: 1, older: 3 }, { baseline: 'commit', from: ids[2], to: ids[0] }],
    [{ newer: 0, older: 2 }, { baseline: 'commit', from: ids[1] }],
  ];
  for (const [scope, request] of cases) {
    assert.deepEqual(scopeRequest(scope, listed), request);
    assert.deepEqual(scopeOf(request.baseline, request.from, request.to, listed), scope);
    const baseline = { kind: request.baseline, label: '', commit: 'old', from: request.from, to: request.to };
    assert.deepEqual(baselineRequest(baseline), request);
  }
  // A commit that left the list, or a to commit older than from, has no scope.
  assert.equal(scopeOf('commit', 'gone', undefined, listed), null);
  assert.equal(scopeOf('commit', ids[0], 'gone', listed), null);
  assert.equal(scopeOf('commit', ids[0], ids[2], listed), null);
  // A folder outside Git shows the uncommitted changes.
  assert.deepEqual(scopeOf('', undefined, undefined, []), { newer: 0, older: 0 });
});

test('a range has the two items in either order, and a step leaves a range at its end', () => {
  assert.deepEqual(scopeRange(3, 1), { newer: 1, older: 3 });
  assert.deepEqual(scopeRange(0, 2), { newer: 0, older: 2 });
  const one = item => ({ newer: item, older: item });
  // [ steps to the older item, and ] to the newer item. The ends stop.
  assert.deepEqual(stepScope(one(1), true, 4), one(2));
  assert.deepEqual(stepScope(one(1), false, 4), one(0));
  assert.equal(stepScope(one(3), true, 4), null);
  assert.equal(stepScope(one(0), false, 4), null);
  // A range, and All changes, go to the end in the step direction.
  assert.deepEqual(stepScope({ newer: 1, older: 3 }, true, 4), one(3));
  assert.deepEqual(stepScope({ newer: 1, older: 3 }, false, 4), one(1));
  assert.deepEqual(stepScope('all', true, 4), one(3));
  assert.deepEqual(stepScope('all', false, 4), one(0));
  assert.deepEqual(stepScope('all', true, 1), one(0));
});

test('the scope button names the selected changes', () => {
  assert.equal(scopeLabel('all', listed), 'All changes');
  assert.equal(scopeLabel({ newer: 0, older: 0 }, listed), 'Uncommitted changes');
  assert.equal(scopeLabel({ newer: 2, older: 2 }, listed), 'Middle');
  assert.equal(scopeId({ newer: 2, older: 2 }, listed), 'bbbbbbb');
  assert.equal(scopeId({ newer: 1, older: 2 }, listed), '');
  assert.equal(scopeLabel({ newer: 1, older: 3 }, listed), '3 commits, aaaaaaa to ccccccc');
  assert.equal(scopeLabel({ newer: 0, older: 1 }, listed), '1 commit and uncommitted changes');
  assert.equal(scopeLabel({ newer: 0, older: 3 }, listed), '3 commits and uncommitted changes');
  assert.equal(baseText({ commit: ids[2] }), 'Since the worktree base (aaaaaaa)');
  assert.equal(baseText({ commit: ids[2], branch: 'origin/main' }), 'Since the merge base with origin/main (aaaaaaa)');
  assert.equal(timelineHeading(undefined), 'Uncommitted changes and latest commits');
  assert.equal(timelineHeading({ commit: ids[2], branch: 'main' }), 'Uncommitted changes and commits since main');
});

test('a file reply moved when the server did not use the requested commit', () => {
  const request = { baseline: 'commit', from: 'abc' };
  assert.equal(baselineMoved(request, { kind: 'commit', label: '', commit: 'p', from: 'abc' }), false);
  assert.equal(baselineMoved(request, { kind: 'base', label: '', commit: 'b' }), true);
  assert.equal(baselineMoved(request, { kind: 'commit', label: '', commit: 'p', from: 'def' }), true);
  // The to commit must match too.
  const range = { baseline: 'commit', from: 'abc', to: 'def' };
  assert.equal(baselineMoved(range, { kind: 'commit', label: '', commit: 'p', from: 'abc', to: 'def' }), false);
  assert.equal(baselineMoved(range, { kind: 'commit', label: '', commit: 'p', from: 'abc' }), true);
  assert.equal(baselineMoved(request, { kind: 'commit', label: '', commit: 'p', from: 'abc', to: 'def' }), true);
  // A base request moves when the base is gone. The default request and a file outside
  // Git never move.
  assert.equal(baselineMoved({ baseline: 'base' }, { kind: 'head', label: '', commit: 'h' }), true);
  assert.equal(baselineMoved({ baseline: 'base' }, { kind: 'base', label: '', commit: 'b' }), false);
  assert.equal(baselineMoved({ baseline: 'head' }, { kind: 'head', label: '', commit: 'h' }), false);
  assert.equal(baselineMoved({}, { kind: 'head', label: '', commit: 'h' }), false);
  assert.equal(baselineMoved({}, { kind: '', label: '', commit: '' }), false);
});

test('a raster image side and SVG text give an image', () => {
  const png = { state: 'image', mediaType: 'image/png', data: 'iVBORw0K', size: 6 };
  assert.deepEqual(sideImage('a.png', png, true), { url: 'data:image/png;base64,iVBORw0K', format: 'PNG' });
  // The server names the format. The file extension does not matter.
  assert.deepEqual(sideImage('a.txt', { ...png, mediaType: 'image/webp' }, false), { url: 'data:image/webp;base64,iVBORw0K', format: 'WebP' });
  assert.equal(sideImage('a.png', { ...png, mediaType: 'image/svg+xml' }, true), null);
  assert.equal(sideImage('a.png', { ...png, mediaType: 'constructor' }, true), null);
  assert.equal(sideImage('a.png', { state: 'binary', size: 6 }, true), null);
  // SVG text shows only as an image URL. Its text cannot end the URL or add markup.
  const svg = { state: 'text', text: '<svg xmlns="http://www.w3.org/2000/svg"><a href="#">"x"</a></svg>', size: 9 };
  const image = sideImage('icons/Logo.SVG', svg, true);
  assert.equal(image.format, 'SVG');
  assert.ok(image.url.startsWith('data:image/svg+xml;charset=utf-8,%3Csvg%20'));
  assert.doesNotMatch(image.url.slice(5), /[<>"# ]/);
  assert.equal(decodeURIComponent(image.url.slice(image.url.indexOf(',') + 1)), svg.text);
  assert.equal(sideImage('logo.svg', svg, false), null);
  assert.equal(sideImage('logo.svg', { ...svg, symlink: true }, true), null);
  assert.equal(sideImage('logo.svg.txt', svg, true), null);
  assert.equal(sideImage('logo.svg', { ...svg, text: 'not svg' }, true), null);
  assert.equal(sideImage('logo.svg', { ...svg, text: '<html><svg xmlns="http://www.w3.org/2000/svg"/></html>' }, true), null);
});

test('SVG text needs an svg root element in the SVG namespace and no parse error', () => {
  FixtureParser.types.length = 0;
  assert.equal(svgRoot('<svg xmlns="http://www.w3.org/2000/svg"/>'), true);
  assert.deepEqual(FixtureParser.types, ['image/svg+xml']);
  assert.equal(svgRoot('<é:svg xmlns:é="http://www.w3.org/2000/svg"/>'), true);
  assert.equal(svgRoot('<svg xmlns="http://www.w3.org/1999/xhtml"/>'), false);
  assert.equal(svgRoot('<svg viewBox="0 0 1 1"/>'), false);
  assert.equal(svgRoot('<html xmlns="http://www.w3.org/2000/svg"/>'), false);
  assert.equal(svgRoot('<svg xmlns="http://www.w3.org/2000/svg"><broken'), false);
  // A side parses its text one time.
  const side = { state: 'text', text: '<svg xmlns="http://www.w3.org/2000/svg"/>', size: 42 };
  const file = { path: 'a.svg', baseline: { kind: 'head', label: '', commit: 'h' }, old: side, new: side };
  FixtureParser.types.length = 0;
  hasSVG(file, true);
  imageSides(file, true, true);
  assert.equal(FixtureParser.types.length, 1);
});

test('the image view shows the sides that are present, and a note for a side that is not an image', () => {
  const baseline = { kind: 'head', label: '', commit: 'h' };
  const png = { state: 'image', mediaType: 'image/png', data: 'AA==', size: 1 };
  const missing = { state: 'missing', size: 0 };
  const file = (old, now, path = 'img/a.png') => ({ path, baseline, old, new: now });
  assert.deepEqual(imageSides(file(missing, png), true, true), [
    { label: 'New', alt: 'New a.png', url: 'data:image/png;base64,AA==', format: 'PNG', size: 1, note: '' },
  ]);
  assert.deepEqual(imageSides(file(png, missing), false, true), null);
  assert.deepEqual(imageSides(file(png, png), false, true).map(side => side.label), ['']);
  // A type change from text to an image shows the text in place of the old image.
  const sides = imageSides(file({ state: 'text', text: 'x', size: 1 }, png), true, true);
  assert.deepEqual(sides.map(side => [side.label, side.url !== '', side.note, side.text]), [['Old', false, '', 'x'], ['New', true, '', undefined]]);
  const link = imageSides(file({ state: 'text', text: 'a.png', size: 5, symlink: true }, png), true, true)[0];
  assert.deepEqual([link.note, link.text], ['Symbolic link. The text is the link target.', 'a.png']);
  assert.match(imageSides(file({ state: 'tooLarge', size: 9 << 20 }, png), true, true)[0].note, /too large/);
  // Without an image on a shown side, the file shows as text or with a note.
  assert.equal(imageSides(file({ state: 'binary', size: 1 }, { state: 'tooLarge', size: 9 << 20 }), true, true), null);
  // Source shows SVG text as text. Next to a raster image, the SVG text shows in place
  // of the SVG image.
  const svg = { state: 'text', text: '<svg xmlns="http://www.w3.org/2000/svg"/>', size: 42 };
  assert.equal(imageSides(file(svg, svg, 'a.svg'), true, true).length, 2);
  assert.equal(imageSides(file(svg, svg, 'a.svg'), true, false), null);
  assert.deepEqual(imageSides(file(svg, png, 'a.svg'), true, false).map(side => [side.format, side.text]), [['', svg.text], ['PNG', undefined]]);
  // Source keeps SVG text in view next to a side without text.
  const binary = { state: 'binary', size: 4 };
  assert.deepEqual(imageSides(file(svg, binary, 'a.svg'), true, false).map(side => [side.text, side.note]), [[svg.text, ''], [undefined, sideNote(binary)]]);
  assert.equal(imageSides(file(svg, binary, 'a.svg'), true, true)[0].format, 'SVG');
  assert.equal(imageSides(file({ state: 'text', text: 'x', size: 1 }, binary, 'a.txt'), true, false), null);
  assert.equal(hasSVG(file(svg, missing, 'a.svg'), true), true);
  assert.equal(hasSVG(file(svg, missing, 'a.svg'), false), false);
  assert.equal(hasSVG(file(png, png), true), false);
  // The old side of a rename uses its old path.
  const renamed = file(svg, svg, 'renamed.txt');
  assert.deepEqual(imageSides(renamed, true, true, 'rename-me.svg').map(side => [side.alt, side.format, side.text]), [['Old rename-me.svg', 'SVG', undefined], ['New renamed.txt', '', svg.text]]);
  assert.equal(imageSides(renamed, true, true), null);
  assert.equal(hasSVG(renamed, true, 'rename-me.svg'), true);
  assert.equal(hasSVG(renamed, false, 'rename-me.svg'), false);
  // The pointer text of Git LFS in an SVG path is text, not an image.
  const pointer = { state: 'text', text: 'version https://git-lfs.github.com/spec/v1\noid sha256:0\nsize 9\n', size: 60 };
  assert.deepEqual(imageSides(file(pointer, svg, 'pointer.svg'), true, true).map(side => [side.format, side.text === pointer.text]), [['', true], ['SVG', false]]);
  assert.equal(hasSVG(file(pointer, missing, 'pointer.svg'), true), false);
});

test('image details name the format, the pixel size, and the file size', () => {
  const side = { label: '', alt: '', url: 'data:', format: 'PNG', size: 34 * 1024, note: '' };
  assert.equal(imageDetails(side), 'PNG · 34 KiB');
  assert.equal(imageDetails(side, 512, 256), 'PNG · 512 × 256 · 34 KiB');
  // An SVG file has no pixel size.
  assert.equal(imageDetails({ ...side, format: 'SVG', size: 1 }, 300, 150), 'SVG · 1 byte');
  assert.equal(sizeText(1023), '1023 bytes');
  assert.equal(sizeText(1536), '1.5 KiB');
  assert.equal(sizeText(5 << 20), '5.0 MiB');
  assert.equal(sizeText(12 << 20), '12 MiB');
});
