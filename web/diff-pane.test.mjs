import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiffPane } from './dist/diff-pane.js';

// A small fake DOM. It has only the parts that the pane uses.
class Node {
  children = [];
  attributes = new Map();
  dataset = {};
  style = {};
  classList = { toggle() {} };
  hidden = false;
  disabled = false;
  value = '';
  title = '';
  clientWidth = 1000;
  constructor(tag = 'div') { this.tag = tag; }
  set textContent(text) { this.text = text; this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  get selectedOptions() { return this.querySelectorAll('option').filter(option => option.value === this.value); }
  showModal() {}
  close() {}
  focus() {}
}

class Option extends Node {
  constructor(text = '', value = '') {
    super('option');
    this.textContent = text;
    this.value = value;
  }
}

const ids = ['diff-pane', 'diff-title', 'diff-controls', 'diff-baseline', 'diff-split', 'diff-unified', 'diff-summary',
  'diff-status', 'diff-filter', 'diff-list', 'diff-path', 'diff-counts', 'diff-toggle', 'diff-copy', 'diff-preview',
  'preview-dialog', 'preview-title', 'preview-body', 'diff-note', 'diff-editor', 'diff-refresh', 'diff-close', 'preview-close'];
const server = { protocol: 'test', instance: 'test', port: 1234, dataDir: '/fixture' };
const commit = '0123456789abcdef0123456789abcdef01234567';
const settle = () => new Promise(resolve => setImmediate(resolve));

const baselines = {
  head: { kind: 'head', label: 'Uncommitted changes', commit: 'head' },
  commit: { kind: 'commit', label: 'Changes from commit 0123456', commit: 'parent', from: commit },
};
const changes = (baseline, extra = {}) => ({ repository: true, base: false, baseline, commits: [{ id: commit, subject: 'Fix' }],
  files: [{ path: 'a.txt', status: 'M', added: 1, removed: 1 }], truncated: false, ...extra });
const file = baseline => ({ path: 'a.txt', baseline, old: { state: 'text', text: 'a\n', size: 2 }, new: { state: 'text', text: 'b\n', size: 2 } });

function setup() {
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  for (const name of ['HTMLElement', 'HTMLDialogElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLButtonElement']) globalThis[name] = Node;
  globalThis.Option = Option;
  globalThis.ResizeObserver = class { observe() {} };
  globalThis.window = { addEventListener() {} };
  globalThis.document = { getElementById: id => nodes[id], createElement: tag => new Node(tag) };
  const pending = [];
  const send = (server, request, signal) => new Promise((resolve, reject) => pending.push({ request, signal, resolve, reject }));
  const shown = [];
  const view = { destroy() {} };
  const editor = { showDiff: (parent, path, old, now) => { shown.push(`${path}: ${old}->${now}`); return view; }, showFile: () => view };
  const pane = new DiffPane(() => server, send, editor);
  pane.select('session');
  pane.setShown(true, 'changed');
  return { nodes, pending, shown };
}

test('a file reply without the selected commit reads the list again, and a failed read stops there', async () => {
  const { nodes, pending, shown } = setup();
  assert.deepEqual(pending[0].request.diff, {});
  pending[0].resolve(changes(baselines.head));
  await settle();
  assert.deepEqual(pending[1].request.diff, { baseline: 'head', path: 'a.txt' });
  pending[1].resolve(file(baselines.head));
  await settle();
  assert.equal(shown.length, 1);

  // Select the commit. The list and the file request use it.
  nodes['diff-baseline'].value = `commit:${commit}`;
  nodes['diff-baseline'].onchange();
  assert.deepEqual(pending[2].request.diff, { baseline: 'commit', from: commit });
  pending[2].resolve(changes(baselines.commit));
  await settle();
  assert.deepEqual(pending[3].request.diff, { baseline: 'commit', from: commit, path: 'a.txt' });

  // A rebase removed the commit before the file request. The pane does not show this
  // file. It reads the list again with the default baseline, and that read fails.
  pending[3].resolve(file(baselines.head));
  await settle();
  assert.equal(shown.length, 1);
  assert.equal(pending[4].request.operation, 'workspace-changes');
  assert.deepEqual(pending[4].request.diff, {});
  pending[4].reject(new Error('connection lost'));
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(pending.length, 5, 'the failed list read started another request');
  assert.equal(nodes['diff-status'].textContent, 'Cannot read the changes: connection lost');
  assert.match(nodes['diff-note'].textContent, /not in the history of HEAD now/);

  // A later refresh recovers with the default baseline.
  nodes['diff-refresh'].onclick();
  assert.deepEqual(pending[5].request.diff, {});
  pending[5].resolve(changes(baselines.head, { commits: [] }));
  await settle();
  assert.deepEqual(pending[6].request.diff, { baseline: 'head', path: 'a.txt' });
  pending[6].resolve(file(baselines.head));
  await settle();
  assert.equal(shown.length, 2);
  assert.equal(nodes['diff-note'].hidden, true);
  assert.equal(nodes['diff-baseline'].value, 'head');
});

test('the menu shows the notice of omitted commits also with an empty list', async () => {
  const { nodes, pending } = setup();
  pending[0].resolve(changes(baselines.head, { commits: [], moreCommits: true }));
  await settle();
  const select = nodes['diff-baseline'];
  const options = select.querySelectorAll('option');
  assert.deepEqual(options.map(option => [option.textContent, option.disabled]),
    [['Uncommitted changes', false], ['Older commits are not listed.', true]]);
  assert.equal(select.disabled, false);

  // Without omitted commits, one choice leaves the menu off.
  nodes['diff-refresh'].onclick();
  pending[2].resolve(changes(baselines.head, { commits: [] }));
  await settle();
  assert.equal(select.querySelectorAll('option').length, 1);
  assert.equal(select.disabled, true);
});
