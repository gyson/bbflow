import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countText, effectiveLayout, fileEntries, Generation, languageName, sideNote, statusTitle } from './dist/diff-model.js';

const change = (path, status = 'M', extra = {}) => ({ path, status, added: 1, removed: 2, ...extra });

test('changed scope lists only changes in path order', () => {
  const changes = [change('b.txt'), change('a.txt', 'A', { untracked: true })];
  assert.deepEqual(fileEntries(changes, ['c.txt'], 'changed', '').map(entry => entry.path), ['a.txt', 'b.txt']);
});

test('all scope merges unchanged paths with changes, including deleted files', () => {
  const changes = [change('gone.txt', 'D'), change('src/app.ts')];
  const entries = fileEntries(changes, ['README.md', 'src/app.ts'], 'all', '');
  assert.deepEqual(entries.map(entry => [entry.path, entry.change?.status ?? '']), [['README.md', ''], ['gone.txt', 'D'], ['src/app.ts', 'M']]);
});

test('the filter matches any part of the path without case', () => {
  const entries = fileEntries([change('web/src/Diff-Pane.ts'), change('docs/SPEC.md')], [], 'changed', ' diff ');
  assert.deepEqual(entries.map(entry => entry.path), ['web/src/Diff-Pane.ts']);
});

test('split changes to unified only in a narrow pane', () => {
  assert.equal(effectiveLayout('split', 519), 'unified');
  assert.equal(effectiveLayout('split', 520), 'split');
  assert.equal(effectiveLayout('unified', 2000), 'unified');
});

test('languages come from the file name', () => {
  assert.equal(languageName('internal/server/diff.go'), 'go');
  assert.equal(languageName('web/src/App.TSX'), 'tsx');
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
