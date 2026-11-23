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
import { DiffPane, absolutePath } from './dist/diff-pane.js';

// A small fake DOM. It has only the parts that the pane uses.
class Node {
  children = [];
  attributes = new Map();
  listeners = {};
  dataset = {};
  style = {};
  className = '';
  classes = new Set();
  classList = { toggle: (name, on) => { if (on) this.classes.add(name); else this.classes.delete(name); }, add() {}, remove() {} };
  hidden = false;
  disabled = false;
  value = '';
  title = '';
  clientWidth = 1000;
  constructor(tag = 'div') { this.tag = tag; }
  set textContent(text) { this.text = text; this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children.map(child => typeof child === 'string' ? Object.assign(new Node('#text'), { text: child }) : child)); }
  replaceChildren(...children) { this.text = ''; this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  showModal() {}
  close() {}
  focus() { globalThis.document.activeElement = this; }
}

const ids = ['diff-pane', 'diff-title', 'diff-controls', 'diff-scope', 'diff-scope-id', 'diff-scope-label', 'diff-scope-menu',
  'diff-split', 'diff-unified', 'diff-summary', 'diff-status', 'diff-filter', 'diff-list', 'diff-path', 'diff-counts',
  'diff-toggle', 'diff-source', 'diff-preview', 'preview-dialog', 'preview-title', 'preview-body', 'diff-note', 'diff-editor',
  'diff-refresh', 'diff-close', 'diff-back', 'preview-close', 'diff-menu-box', 'diff-menu-open', 'diff-menu', 'diff-menu-status'];
// The items of the file menu, in menu order.
const menuItems = ['diff-copy-path', 'diff-copy-relative', 'diff-reveal-line', 'diff-reveal', 'diff-open'];
const server = { protocol: 'test', instance: 'test', port: 1234, dataDir: '/fixture' };
const commit = '0123456789abcdef0123456789abcdef01234567';
const settle = () => new Promise(resolve => setImmediate(resolve));
const svgText = '<svg xmlns="http://www.w3.org/2000/svg"/>';

const baselines = {
  head: { kind: 'head', label: 'Uncommitted changes', commit: 'head' },
  commit: { kind: 'commit', label: 'Commit 0123456', commit: 'parent', from: commit, to: commit },
};
const changes = (baseline, extra = {}) => ({ repository: true, baseline, commits: [{ id: commit, subject: 'Fix', files: 1 }],
  files: [{ path: 'a.txt', status: 'M', added: 1, removed: 1 }], truncated: false, ...extra });
const file = baseline => ({ path: 'a.txt', baseline, old: { state: 'text', text: 'a\n', size: 2 }, new: { state: 'text', text: 'b\n', size: 2 } });
const htmlFile = (path, baseline) => ({ path, baseline, old: { state: 'missing', size: 0 }, new: { state: 'text', text: '<p>Hi</p>\n', size: 10 } });

function setup() {
  const nodes = Object.fromEntries(ids.map(id => [id, new Node(id.startsWith('diff-scope') && id !== 'diff-scope-menu' ? 'span' : 'div')]));
  for (const id of menuItems) nodes[id] = new Node(id === 'diff-reveal-line' ? 'div' : 'button');
  nodes['diff-menu'].append(...menuItems.map(id => nodes[id]));
  for (const name of ['HTMLElement', 'HTMLDialogElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLButtonElement']) globalThis[name] = Node;
  globalThis.ResizeObserver = class { observe() {} };
  globalThis.window = { addEventListener() {} };
  globalThis.document = { getElementById: id => nodes[id], createElement: tag => new Node(tag), addEventListener() {}, activeElement: null };
  const pending = [];
  const send = (server, request, signal) => new Promise((resolve, reject) => pending.push({ request, signal, resolve, reject }));
  const shown = [];
  const view = { destroy() {} };
  const editor = {
    showDiff: (parent, path, old, now) => { shown.push(`${path}: ${old}->${now}`); return view; },
    showFile: (parent, path, text) => { shown.push(`${path}: ${text}`); return view; },
    showImages: (parent, sides, layout) => { shown.push(`${layout}: ${sides.map(side => [side.label, side.format || (side.text !== undefined ? `text ${side.text}` : side.note)].filter(Boolean).join(' ')).join(', ')}`); return view; },
  };
  const pane = new DiffPane(() => server, send, editor);
  pane.select('session');
  pane.setShown(true, 'changed');
  return { nodes, pending, shown, pane };
}

// The buttons of the open scope menu.
function menuButtons(nodes) {
  const all = node => [node, ...node.children.flatMap(all)];
  return all(nodes['diff-scope-menu']).filter(node => node.tag === 'button');
}
const dot = (nodes, item) => menuButtons(nodes).find(button => button.className.startsWith('scope-dot') && button.dataset.item === String(item));
const row = (nodes, item) => menuButtons(nodes).find(button => button.className === 'scope-text' && button.dataset.item === String(item));
const rows = nodes => {
  const all = node => [node, ...node.children.flatMap(all)];
  return all(nodes['diff-scope-menu']).filter(node => node.className.startsWith('scope-row'));
};
const key = (nodes, name) => nodes['diff-pane'].listeners.keydown({ key: name, target: { closest: () => null }, preventDefault() {} });

test('a file reply without the selected commit reads the list again, and a failed read stops there', async () => {
  const { nodes, pending, shown } = setup();
  assert.deepEqual(pending[0].request.diff, {});
  pending[0].resolve(changes(baselines.head));
  await settle();
  assert.deepEqual(pending[1].request.diff, { baseline: 'head', path: 'a.txt' });
  pending[1].resolve(file(baselines.head));
  await settle();
  assert.equal(shown.length, 1);
  assert.equal(nodes['diff-scope-label'].textContent, 'Uncommitted changes');

  // Select the commit. Its row closes the menu and gives the focus to the scope button.
  // The list and the file request use the commit.
  nodes['diff-scope'].onclick();
  assert.equal(nodes['diff-scope-menu'].hidden, false);
  row(nodes, 1).onclick();
  assert.equal(nodes['diff-scope-menu'].hidden, true);
  assert.equal(document.activeElement, nodes['diff-scope']);
  assert.deepEqual(pending[2].request.diff, { baseline: 'commit', from: commit, to: commit });
  assert.equal(nodes['diff-scope-id'].textContent, '0123456');
  assert.equal(nodes['diff-scope-label'].textContent, 'Fix');
  pending[2].resolve(changes(baselines.commit));
  await settle();
  assert.deepEqual(pending[3].request.diff, { baseline: 'commit', from: commit, to: commit, path: 'a.txt' });

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
  assert.equal(nodes['diff-scope-label'].textContent, 'Uncommitted changes');
  assert.equal(nodes['diff-scope-id'].textContent, '');
});

test('a late file reply does not change a newer menu choice', async () => {
  const { nodes, pending, shown } = setup();
  const base = { kind: 'base', label: 'Since worktree base', commit: 'base' };
  const withBase = { base: { commit: 'base' } };
  pending[0].resolve(changes(base, withBase));
  await settle();
  assert.equal(nodes['diff-scope-label'].textContent, 'All changes');
  pending[1].resolve(file(base));
  await settle();
  nodes['diff-scope'].onclick();
  row(nodes, 1).onclick();
  pending[2].resolve(changes(baselines.commit, withBase));
  await settle();
  assert.deepEqual(pending[3].request.diff, { baseline: 'commit', from: commit, to: commit, path: 'a.txt' });

  // Select Uncommitted changes while the file request for the commit is pending. A
  // rebase removed the commit, so its reply uses the default baseline. The reply comes
  // after the new choice and does nothing.
  nodes['diff-scope'].onclick();
  row(nodes, 0).onclick();
  assert.deepEqual(pending[4].request.diff, { baseline: 'head' });
  assert.equal(pending[3].signal.aborted, true);
  pending[3].resolve(file(base));
  for (let i = 0; i < 3; i++) await settle();
  assert.equal(pending.length, 5);
  pending[4].resolve(changes(baselines.head, { ...withBase, commits: [] }));
  await settle();
  assert.equal(nodes['diff-scope-label'].textContent, 'Uncommitted changes');
  assert.deepEqual(pending[5].request.diff, { baseline: 'head', path: 'a.txt' });
  pending[5].resolve(file(baselines.head));
  await settle();
  assert.equal(shown.length, 2);
  assert.equal(nodes['diff-note'].hidden, true);
});

test('two dots select a range, the same dot cancels, and the keys step', async () => {
  const { nodes, pending } = setup();
  const commits = ['c', 'b', 'a'].map((letter, index) => ({ id: letter.repeat(40), subject: `Commit ${3 - index}`, files: 1 }));
  const [newest, , oldest] = commits.map(commit => commit.id);
  const withBase = { base: { commit: 'base', branch: 'main' }, commits };
  pending[0].resolve(changes(baselines.head, withBase));
  await settle();
  nodes['diff-scope'].onclick();
  assert.match(nodes['diff-scope-menu'].textContent, /^All changesSince the merge base with main/);
  assert.equal(rows(nodes).length, 4);

  // The first dot selects its row at once. The menu stays open for the second dot.
  dot(nodes, 1).onclick();
  assert.deepEqual(pending[2].request.diff, { baseline: 'commit', from: newest, to: newest });
  assert.equal(nodes['diff-scope-menu'].hidden, false);
  assert.match(rows(nodes)[1].className, /pending/);
  assert.match(nodes['diff-scope-menu'].textContent, /Click a second dot/);
  // The same dot cancels the range and keeps the selection. One selected item has only
  // a highlighted row. Its dot does not fill.
  dot(nodes, 1).onclick();
  assert.equal(pending.length, 3);
  assert.equal(rows(nodes)[1].className, 'scope-row in');

  // Two dots, in either order, select the commits between them.
  dot(nodes, 3).onclick();
  dot(nodes, 1).onclick();
  assert.deepEqual(pending[4].request.diff, { baseline: 'commit', from: oldest, to: newest });
  assert.equal(nodes['diff-scope-label'].textContent, '3 commits, aaaaaaa to ccccccc');
  pending[4].resolve(changes({ kind: 'commit', label: '', commit: 'base', from: oldest, to: newest }, withBase));
  await settle();
  assert.equal(nodes['diff-scope-menu'].hidden, false);
  assert.deepEqual(rows(nodes).map(node => node.className), ['scope-row', 'scope-row in linked', 'scope-row in linked', 'scope-row in linked']);

  // A range of every item stays a range. A merge commit can make it differ from All
  // changes.
  dot(nodes, 0).onclick();
  dot(nodes, 3).onclick();
  assert.deepEqual(pending.at(-1).request.diff, { baseline: 'commit', from: oldest });
  assert.equal(nodes['diff-scope-label'].textContent, '3 commits and uncommitted changes');

  // ] steps from All changes to the newest item, and [ to an older item.
  menuButtons(nodes).find(button => button.className === 'scope-all').onclick();
  assert.deepEqual(pending.at(-1).request.diff, { baseline: 'base' });
  assert.equal(nodes['diff-scope-label'].textContent, 'All changes');
  key(nodes, ']');
  assert.deepEqual(pending.at(-1).request.diff, { baseline: 'head' });
  key(nodes, '[');
  assert.deepEqual(pending.at(-1).request.diff, { baseline: 'commit', from: newest, to: newest });
  // Escape closes the menu.
  key(nodes, 'Escape');
  assert.equal(nodes['diff-scope-menu'].hidden, true);
  assert.equal(nodes['diff-scope'].getAttribute('aria-expanded'), 'false');
});

test('a selection of All changes goes back to the default when the base is gone', async () => {
  const { nodes, pending } = setup();
  const base = { kind: 'base', label: 'Since the merge base with main', commit: 'base' };
  pending[0].resolve(changes(baselines.head, { base: { commit: 'base', branch: 'main' } }));
  await settle();
  nodes['diff-scope'].onclick();
  menuButtons(nodes).find(button => button.className === 'scope-all').onclick();
  assert.deepEqual(pending[2].request.diff, { baseline: 'base' });
  pending[2].resolve(changes(base, { base: { commit: 'base', branch: 'main' } }));
  await settle();
  assert.equal(nodes['diff-scope-label'].textContent, 'All changes');

  // The session changed to the default branch. The server uses the default baseline.
  // The pane then shows it and sends the default request.
  nodes['diff-refresh'].onclick();
  assert.deepEqual(pending.at(-1).request.diff, { baseline: 'base' });
  pending.at(-1).resolve(changes(baselines.head));
  await settle();
  assert.equal(nodes['diff-scope-label'].textContent, 'Uncommitted changes');
  nodes['diff-refresh'].onclick();
  assert.deepEqual(pending.at(-1).request.diff, {});
});

test('the menu shows the notice of omitted commits also with an empty list', async () => {
  const { nodes, pending } = setup();
  pending[0].resolve(changes(baselines.head, { commits: [], moreCommits: true }));
  await settle();
  const button = nodes['diff-scope'];
  assert.equal(button.disabled, false);
  button.onclick();
  assert.equal(rows(nodes).length, 1);
  assert.match(nodes['diff-scope-menu'].textContent, /Older commits are not listed\./);

  // Without omitted commits, one choice leaves the menu off.
  nodes['diff-refresh'].onclick();
  pending[2].resolve(changes(baselines.head, { commits: [] }));
  await settle();
  assert.equal(button.disabled, true);
  assert.equal(nodes['diff-scope-menu'].hidden, true);
});

test('an image diff shows the image view, and Source shows the text of an SVG file', async () => {
  const { nodes, pending, shown } = setup();
  const files = [{ path: 'a.png', status: 'M', added: -1, removed: -1, binary: true }, { path: 'b.svg', status: 'A', added: 1, removed: 0 }];
  pending[0].resolve(changes(baselines.head, { files }));
  await settle();
  const png = { state: 'image', mediaType: 'image/png', data: 'AA==', size: 1 };
  pending[1].resolve({ path: 'a.png', baseline: baselines.head, old: png, new: { ...png, mediaType: 'image/gif' } });
  await settle();
  assert.deepEqual(shown, ['split: Old PNG, New GIF']);
  assert.equal(nodes['diff-source'].hidden, true);
  // Unified puts the sides in one column.
  nodes['diff-unified'].onclick();
  assert.equal(shown.at(-1), 'unified: Old PNG, New GIF');

  // An added SVG file shows its new side as an image. Source shows its text diff, and
  // the next file keeps that choice.
  const list = node => [node, ...node.children.flatMap(list)];
  list(nodes['diff-list']).find(node => node.dataset.file === 'b.svg').onclick();
  pending[2].resolve({ path: 'b.svg', baseline: baselines.head, old: { state: 'missing', size: 0 }, new: { state: 'text', text: svgText, size: 42 } });
  await settle();
  assert.equal(shown.at(-1), 'unified: New SVG');
  assert.equal(nodes['diff-source'].hidden, false);
  assert.equal(nodes['diff-source'].textContent, 'View source');
  nodes['diff-source'].onclick();
  assert.equal(shown.at(-1), `b.svg: ->${svgText}`);
  assert.equal(nodes['diff-source'].textContent, 'View image');
  // View file shows the text too, until Source changes back to the image.
  nodes['diff-toggle'].onclick();
  assert.equal(shown.at(-1), `b.svg: ${svgText}`);
  nodes['diff-source'].onclick();
  assert.equal(shown.at(-1), 'unified: SVG');
});

test('Source shows SVG text next to a raster image, and a rename uses the old path for the old side', async () => {
  const { nodes, pending, shown } = setup();
  const files = [{ path: 'icon.svg', status: 'M', added: -1, removed: -1, binary: true }, { path: 'renamed.txt', oldPath: 'rename-me.svg', status: 'R', added: 0, removed: 0 }];
  pending[0].resolve(changes(baselines.head, { files }));
  await settle();
  // The SVG file became a PNG file.
  const svg = { state: 'text', text: '<svg xmlns="http://www.w3.org/2000/svg"/>', size: 42 };
  pending[1].resolve({ path: 'icon.svg', baseline: baselines.head, old: svg, new: { state: 'image', mediaType: 'image/png', data: 'AA==', size: 1 } });
  await settle();
  assert.equal(shown.at(-1), 'split: Old SVG, New PNG');
  nodes['diff-source'].onclick();
  assert.equal(shown.at(-1), `split: Old text ${svg.text}, New PNG`);
  nodes['diff-source'].onclick();

  // A rename from an SVG path to a text path shows the old image and the new text.
  const list = node => [node, ...node.children.flatMap(list)];
  list(nodes['diff-list']).find(node => node.dataset.file === 'renamed.txt').onclick();
  assert.deepEqual(pending[2].request.diff, { baseline: 'head', path: 'renamed.txt', oldPath: 'rename-me.svg' });
  pending[2].resolve({ path: 'renamed.txt', baseline: baselines.head, old: svg, new: svg });
  await settle();
  assert.equal(shown.at(-1), `split: Old SVG, New text ${svg.text}`);
  assert.equal(nodes['diff-source'].hidden, false);
});

test('Source keeps SVG text in view next to a binary side', async () => {
  const { nodes, pending, shown } = setup();
  pending[0].resolve(changes(baselines.head, { files: [{ path: 'icon.svg', status: 'M', added: -1, removed: -1, binary: true }] }));
  await settle();
  const svg = { state: 'text', text: svgText, size: 42 };
  pending[1].resolve({ path: 'icon.svg', baseline: baselines.head, old: svg, new: { state: 'binary', size: 4 } });
  await settle();
  assert.equal(shown.at(-1), 'split: Old SVG, New Binary file. bbflow does not show its content.');
  nodes['diff-source'].onclick();
  assert.equal(shown.at(-1), `split: Old text ${svgText}, New Binary file. bbflow does not show its content.`);
  assert.equal(nodes['diff-note'].hidden, true);
});

test('Open in browser asks the server to open the selected HTML file', async () => {
  const { nodes, pending } = setup();
  const report = { path: 'reports/coverage.html', status: 'A', added: 1, removed: 0, untracked: true };
  pending[0].resolve(changes(baselines.head, { files: [report] }));
  await settle();
  assert.deepEqual(pending[1].request.diff, { baseline: 'head', path: 'reports/coverage.html' });
  // Before the file reply, the pane does not know that the file is there now.
  assert.equal(nodes['diff-open'].hidden, true);
  pending[1].resolve(htmlFile('reports/coverage.html', baselines.head));
  await settle();
  const item = nodes['diff-open'];
  const status = nodes['diff-menu-status'];
  assert.equal(item.hidden, false);
  assert.equal(nodes['diff-reveal-line'].hidden, false);
  assert.equal(nodes['diff-preview'].hidden, true);

  item.onclick();
  assert.deepEqual(pending[2].request, { operation: 'workspace-open', session: 'session', diff: { path: 'reports/coverage.html' } });
  pending[2].resolve({ opened: true });
  await settle();
  assert.equal(status.textContent, 'Opened in browser');

  // A failure shows the reason of the server.
  item.onclick();
  pending[3].reject(new Error('the file is not in the session workspace now'));
  await settle();
  assert.equal(status.textContent, 'Cannot open the file in the browser: the file is not in the session workspace now');

  // Only the reply of the latest click shows. Show in Finder and Open in browser share
  // this rule.
  item.onclick();
  nodes['diff-reveal'].onclick();
  pending[5].resolve({ revealed: true });
  await settle();
  assert.equal(status.textContent, 'Shown in Finder');
  pending[4].reject(new Error('late failure'));
  await settle();
  assert.equal(status.textContent, 'Shown in Finder');
});

test('Open in browser goes away when Changes selects a scope that ends at a commit', async () => {
  const { nodes, pending } = setup();
  const report = { path: 'report.html', status: 'M', added: 1, removed: 1 };
  pending[0].resolve(changes(baselines.head, { files: [report] }));
  await settle();
  pending[1].resolve(htmlFile('report.html', baselines.head));
  await settle();
  const item = nodes['diff-open'];
  assert.equal(item.hidden, false);

  // The commit row changes the scope at once. The old file reply is still loaded, but it
  // is not the file of the new scope.
  nodes['diff-scope'].onclick();
  row(nodes, 1).onclick();
  assert.equal(pending.length, 3);
  assert.equal(item.hidden, true);
  assert.equal(nodes['diff-reveal-line'].hidden, true);
  item.onclick();
  assert.equal(pending.length, 3, 'a click before the file reply sent a request');

  // The file reply of the commit keeps the item away.
  pending[2].resolve(changes(baselines.commit, { files: [report] }));
  await settle();
  pending[3].resolve(htmlFile('report.html', baselines.commit));
  await settle();
  assert.equal(item.hidden, true);
});

test('a reply for an earlier file does not show for the selected file', async () => {
  const { nodes, pending } = setup();
  const files = [{ path: 'a.html', status: 'M', added: 1, removed: 1 }, { path: 'b.html', status: 'M', added: 1, removed: 1 }];
  pending[0].resolve(changes(baselines.head, { files }));
  await settle();
  pending[1].resolve(htmlFile('a.html', baselines.head));
  await settle();
  const item = nodes['diff-open'];
  const status = nodes['diff-menu-status'];
  item.onclick();
  assert.deepEqual(pending[2].request.diff, { path: 'a.html' });

  const list = node => [node, ...node.children.flatMap(list)];
  list(nodes['diff-list']).find(node => node.dataset.file === 'b.html').onclick();
  pending[3].resolve(htmlFile('b.html', baselines.head));
  await settle();
  pending[2].reject(new Error('cannot open a.html'));
  await settle();
  assert.equal(item.hidden, false);
  assert.equal(status.textContent, '');

  item.onclick();
  pending[4].reject(new Error('cannot open b.html'));
  await settle();
  assert.equal(status.textContent, 'Cannot open the file in the browser: cannot open b.html');
  assert.equal(nodes['diff-menu-open'].dataset.tip, 'Cannot open the file in the browser: cannot open b.html');

  // A result that shows goes away when the selection changes.
  list(nodes['diff-list']).find(node => node.dataset.file === 'a.html').onclick();
  assert.equal(status.textContent, '');
  assert.equal(nodes['diff-menu-open'].dataset.tip, '');
});

test('a result goes away when the view selects another session', async () => {
  const { nodes, pending, pane } = setup();
  pending[0].resolve(changes(baselines.head));
  await settle();
  pending[1].resolve(file(baselines.head));
  await settle();
  nodes['diff-reveal'].onclick();
  pending[2].reject(new Error('exit status 1'));
  await settle();
  assert.equal(nodes['diff-menu-status'].textContent, 'Cannot show the file in Finder: exit status 1');

  // A reply that comes after the change does not show either.
  nodes['diff-reveal'].onclick();
  pane.select('other');
  assert.equal(nodes['diff-menu-status'].textContent, '');
  assert.equal(nodes['diff-menu-open'].hidden, true);
  pending[3].reject(new Error('late failure'));
  await settle();
  assert.equal(nodes['diff-menu-status'].textContent, '');
});

test('a click on a file shows the file view, and Back, Changes or Files, or another session shows the list', async () => {
  const { nodes, pending, pane } = setup();
  const reading = () => nodes['diff-pane'].classes.has('reading');
  const list = node => [node, ...node.children.flatMap(list)];
  const click = () => list(nodes['diff-list']).find(node => node.dataset.file === 'a.txt').onclick();
  pending[0].resolve(changes(baselines.head));
  await settle();
  // The pane selects the first changed file itself. A narrow pane still shows the list.
  assert.equal(reading(), false);
  click();
  assert.equal(reading(), true);
  nodes['diff-back'].onclick();
  assert.equal(reading(), false);
  assert.equal(document.activeElement.dataset.file, 'a.txt', 'the focus goes back to the row of the file');

  click();
  // Session or Terminal hides Changes. A return to Changes shows the same file.
  pane.setShown(false);
  pane.setShown(true);
  assert.equal(reading(), true, 'a return from Session or Terminal keeps the file view');
  pane.setShown(true, 'files');
  assert.equal(reading(), false, 'another view starts with its list');
  pane.setShown(true, 'changed');
  click();
  pane.select('other');
  assert.equal(reading(), false, 'another session starts with its list');
});

// The IDs of the shown items of the file menu.
const shownItems = nodes => menuItems.filter(id => id !== 'diff-reveal-line' && !nodes[id].hidden);

test('the file menu copies the absolute and the relative path of the selected file', async () => {
  const { nodes, pending, pane } = setup();
  const copied = [];
  let failure = null;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => {
    if (failure) throw failure;
    copied.push(text);
  } } } });
  // The menu button shows only for a selected file.
  assert.equal(nodes['diff-menu-open'].hidden, true);
  pending[0].resolve(changes(baselines.head, { files: [{ path: 'docs/a.txt', status: 'M', added: 1, removed: 1 }] }));
  await settle();
  assert.equal(nodes['diff-menu-open'].hidden, false);
  assert.equal(nodes['diff-copy-path'].hidden, false);
  assert.equal(nodes['diff-copy-relative'].hidden, false);

  // Without a known workspace, Copy path copies nothing and tells why.
  nodes['diff-copy-path'].onclick();
  await settle();
  assert.deepEqual(copied, []);
  assert.match(nodes['diff-menu-status'].textContent, /^Cannot copy the path: the session workspace is not known/);

  pane.workspace = session => session === 'session' ? '/Users/me/work tree/' : '';
  nodes['diff-copy-path'].onclick();
  await settle();
  assert.equal(nodes['diff-menu-status'].textContent, 'Path copied');
  nodes['diff-copy-relative'].onclick();
  await settle();
  assert.equal(nodes['diff-menu-status'].textContent, 'Relative path copied');
  assert.deepEqual(copied, ['/Users/me/work tree/docs/a.txt', 'docs/a.txt']);

  failure = new Error('clipboard blocked');
  nodes['diff-copy-relative'].onclick();
  await settle();
  assert.equal(nodes['diff-menu-status'].textContent, 'Cannot copy the path: clipboard blocked');
});

test('Show in Finder asks the server to show the current file', async () => {
  const { nodes, pending } = setup();
  const files = [
    { path: 'a.txt', status: 'M', added: 1, removed: 1 },
    { path: 'gone.txt', status: 'D', added: 0, removed: 1 },
    { path: 'link', status: 'A', added: 1, removed: 0 },
  ];
  pending[0].resolve(changes(baselines.head, { files }));
  await settle();
  // Before the file reply, the pane does not know that the file is there now.
  assert.deepEqual(shownItems(nodes), ['diff-copy-path', 'diff-copy-relative']);
  pending[1].resolve(file(baselines.head));
  await settle();
  assert.equal(nodes['diff-reveal'].hidden, false);
  assert.equal(nodes['diff-reveal-line'].hidden, false);

  nodes['diff-reveal'].onclick();
  assert.deepEqual(pending[2].request, { operation: 'workspace-reveal', session: 'session', diff: { path: 'a.txt' } });
  pending[2].resolve({ revealed: true });
  await settle();
  assert.equal(nodes['diff-menu-status'].textContent, 'Shown in Finder');

  // Only the reply of the latest click shows.
  nodes['diff-reveal'].onclick();
  nodes['diff-reveal'].onclick();
  // The server gives the cause of a failed opener, and the page names the action.
  pending[4].reject(new Error('exit status 1: The file /work/a.txt does not exist.'));
  await settle();
  pending[3].resolve({ revealed: true });
  await settle();
  assert.equal(nodes['diff-menu-status'].textContent, 'Cannot show the file in Finder: exit status 1: The file /work/a.txt does not exist.');

  // A deleted file and a symlink have no Show in Finder. The copy items stay.
  const list = node => [node, ...node.children.flatMap(list)];
  list(nodes['diff-list']).find(node => node.dataset.file === 'gone.txt').onclick();
  pending[5].resolve({ path: 'gone.txt', baseline: baselines.head, old: { state: 'text', text: 'a\n', size: 2 }, new: { state: 'missing', size: 0 } });
  await settle();
  assert.equal(nodes['diff-reveal'].hidden, true);
  assert.equal(nodes['diff-reveal-line'].hidden, true);
  assert.equal(nodes['diff-copy-path'].hidden, false);
  nodes['diff-reveal'].onclick();
  assert.equal(pending.length, 6, 'a hidden item sent a request');
  list(nodes['diff-list']).find(node => node.dataset.file === 'link').onclick();
  pending[6].resolve({ path: 'link', baseline: baselines.head, old: { state: 'missing', size: 0 }, new: { state: 'text', text: 'a.txt', size: 5, symlink: true } });
  await settle();
  assert.equal(nodes['diff-reveal'].hidden, true);
});

test('Show in Finder goes away when Changes selects a scope that ends at a commit', async () => {
  const { nodes, pending } = setup();
  pending[0].resolve(changes(baselines.head));
  await settle();
  pending[1].resolve(file(baselines.head));
  await settle();
  assert.equal(nodes['diff-reveal'].hidden, false);
  nodes['diff-scope'].onclick();
  row(nodes, 1).onclick();
  assert.equal(nodes['diff-reveal'].hidden, true);
  pending[2].resolve(changes(baselines.commit));
  await settle();
  pending[3].resolve(file(baselines.commit));
  await settle();
  assert.equal(nodes['diff-reveal'].hidden, true);
  assert.equal(nodes['diff-copy-path'].hidden, false);
});

test('Show in Finder stays away for a file at a commit after Changes selects Uncommitted changes', async () => {
  const { nodes, pending } = setup();
  pending[0].resolve(changes(baselines.head));
  await settle();
  pending[1].resolve(file(baselines.head));
  await settle();
  nodes['diff-scope'].onclick();
  row(nodes, 1).onclick();
  pending[2].resolve(changes(baselines.commit));
  await settle();
  pending[3].resolve(file(baselines.commit));
  await settle();
  assert.equal(nodes['diff-reveal'].hidden, true);

  // The loaded file is still the file at the commit. Before the replies of the new
  // scope, the item stays away and a click sends nothing.
  nodes['diff-scope'].onclick();
  row(nodes, 0).onclick();
  assert.equal(pending.length, 5);
  assert.equal(nodes['diff-reveal'].hidden, true);
  assert.equal(nodes['diff-reveal-line'].hidden, true);
  nodes['diff-reveal'].onclick();
  assert.equal(pending.length, 5, 'a hidden item sent a request');
  pending[4].resolve(changes(baselines.head));
  await settle();
  pending[5].resolve(file(baselines.head));
  await settle();
  assert.equal(nodes['diff-reveal'].hidden, false);
});

test('absolutePath joins the workspace and the relative path', () => {
  assert.equal(absolutePath('/Users/me/repo', 'web/src/app.ts'), '/Users/me/repo/web/src/app.ts');
  assert.equal(absolutePath('/Users/me/repo/', 'a.txt'), '/Users/me/repo/a.txt');
  assert.equal(absolutePath('/', 'a.txt'), '/a.txt');
});
