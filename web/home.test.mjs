import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeRows, HomeView, elapsedText, homeGroups, homeText, lastMessage, listedSession, placeLine, since, unlisted, unsent } from './dist/home.js';

const session = (id, extra = {}) => ({ id, projectId: 'repo', parentId: '', title: id, autoTitle: '', workspace: '/work/repo', updated: '', status: 'ended', archived: false, pinned: false, viewers: 0, ...extra });
const ids = groups => ({ running: groups.running.map(item => item.id), idle: groups.idle.map(item => item.id) });

test('Home lists only the sessions with a live terminal, by their pushed status', () => {
  const listed = [
    session('draft', { status: 'draft' }),
    session('ended'),
    session('listed-running', { status: 'running' }),
    session('listed-idle', { status: 'idle' }),
    session('pushed-idle', { status: 'running' }),
    session('pushed-running', { status: 'idle' }),
  ];
  const groups = homeGroups(listed, [], { 'pushed-idle': 'idle', 'pushed-running': 'running' });
  assert.deepEqual(ids(groups), { running: ['listed-running', 'pushed-running'], idle: ['listed-idle', 'pushed-idle'] });
});

test('a session outside the list shows only while the status watch names it', () => {
  const listed = [session('a', { status: 'idle' })];
  const extra = [session('old', { status: 'idle' }), session('gone', { status: 'running' }), session('a', { status: 'running' })];
  assert.deepEqual(unlisted(listed, { a: 'idle', old: 'running' }), ['old']);
  assert.deepEqual(ids(homeGroups(listed, extra, { a: 'idle', old: 'running' })), { running: ['old'], idle: ['a'] });
});

test('Running sorts by title, and Idle shows the latest activity first', () => {
  const listed = [
    session('r2', { status: 'running', title: 'beta', updated: '2026-11-26T10:00:00Z' }),
    session('r1', { status: 'running', title: 'Alpha', updated: '2026-11-26T09:00:00Z' }),
    session('r3', { status: 'running', title: '', autoTitle: 'alpha' }),
    session('i-old', { status: 'idle', updated: '2026-11-26T08:00:00Z' }),
    session('i-new', { status: 'idle', updated: '2026-11-26T09:30:00Z' }),
    session('i-none', { status: 'idle' }),
  ];
  assert.deepEqual(ids(homeGroups(listed, [], {})), { running: ['r1', 'r3', 'r2'], idle: ['i-new', 'i-old', 'i-none'] });
});

test('a saved draft is an unsent message unless it is empty or pending', () => {
  assert.equal(unsent({ text: 'Run the tests.', attachments: [], pending: false }), true);
  assert.equal(unsent({ text: '', attachments: [4], pending: false }), true);
  assert.equal(unsent({ text: ' \n', attachments: [], pending: false }), false);
  assert.equal(unsent({ text: 'Run the tests.', attachments: [], pending: true }), false);
});

test('the latest sent message is the first of the page', () => {
  const message = (text, attachments = []) => ({ revision: 1, created: '2026-11-26T10:00:00Z', text, attachments, confirmed: true });
  assert.equal(lastMessage({ messages: [], more: false }), undefined);
  assert.deepEqual(lastMessage({ messages: [message('  Newest\nline 2 '), message('Older')], more: false }), { text: 'Newest\nline 2', created: '2026-11-26T10:00:00Z' });
  assert.equal(lastMessage({ messages: [message('', [{ id: 1 }])], more: false }).text, '1 attachment');
  assert.equal(lastMessage({ messages: [message('', [{ id: 1 }, { id: 2 }])], more: false }).text, '2 attachments');
  assert.equal(lastMessage({ messages: [message('')], more: false }), undefined);
});

test('a time span shows in one unit', () => {
  const minute = 60000;
  assert.equal(elapsedText(-5000), '<1 min');
  assert.equal(elapsedText(59999), '<1 min');
  assert.equal(elapsedText(minute), '1 min');
  assert.equal(elapsedText(59 * minute), '59 min');
  assert.equal(elapsedText(60 * minute), '1 h');
  assert.equal(elapsedText(23 * 60 * minute + 59 * minute), '23 h');
  assert.equal(elapsedText(49 * 60 * minute), '2 d');
  const now = Date.parse('2026-11-26T10:12:30Z');
  assert.equal(since('2026-11-26T10:00:00Z', now), '12 min');
  assert.equal(since('', now), '');
  assert.equal(since('not a time', now), '');
});

test('the place line names the project, the tool, the worktree, and the parent', () => {
  const projects = [{ id: 'repo', name: 'Orbit API', workspace: '/work/repo' }];
  const preparation = { toolName: 'Codex' };
  const parent = session('parent', { title: 'Refactor orbit' });
  assert.equal(placeLine(session('a', { preparation }), projects, undefined), 'Orbit API · Codex');
  assert.equal(placeLine(session('a', { preparation }), projects, undefined, 'Claude Code'), 'Orbit API · Claude Code', 'the tool of the latest terminal comes first');
  assert.equal(placeLine(session('a', { preparation, worktree: { path: '/w' }, parentId: 'parent' }), projects, parent, 'Codex'), 'Orbit API · Codex · worktree · ↳ Refactor orbit');
  assert.equal(placeLine(session('a', { projectId: '' }), projects, undefined), '/work/repo', 'a session without a saved project shows its workspace');
  assert.equal(placeLine(session('a'), projects, session('parent', { title: '' })), 'Orbit API · ↳ Untitled session');
});

test('Home has a text only without a project and without a live session', () => {
  assert.equal(homeText(0, 0), 'No projects yet.');
  assert.equal(homeText(0, 1), '', 'a session of a removed project stays live');
  assert.equal(homeText(2, 0), '');
});

test('the saved data of a session becomes a list row without an update time', () => {
  const row = listedSession({ archived: false, pinned: true, id: 's', projectId: 'repo', title: 'Title', workspace: '/w', status: 'idle', run: { id: 'r', status: 'running' } });
  assert.deepEqual(row, { archived: false, pinned: true, parentId: '', projectId: 'repo', id: 's', title: 'Title', autoTitle: '', workspace: '/w', updated: '', status: 'idle', viewers: 0, runStatus: 'running' });
});

// The reads of HomeRows, with a log of the requests. answer gives the replies of the
// oldest read of a row that has no reply yet, or fails that read.
function fixture() {
  const log = [], waiting = [];
  let changes = 0, available = true;
  const setAvailable = value => { available = value; };
  const ask = (kind, id) => new Promise((resolve, reject) => { log.push(`${kind}:${id}`); waiting.push({ kind, id, resolve, reject }); });
  const reads = { session: id => ask('session', id), sent: id => ask('sent', id), draft: id => ask('draft', id), terminals: id => ask('terminals', id) };
  const rows = new HomeRows(() => available ? reads : null, () => { changes += 1; });
  const take = (kind, id) => {
    const index = waiting.findIndex(item => item.kind === kind && item.id === id);
    return index < 0 ? undefined : waiting.splice(index, 1)[0];
  };
  const settled = () => new Promise(resolve => setImmediate(resolve));
  const answer = async (id, { tools = ['Codex', 'Claude Code'], text = 'Run the tests.', draft = '', fail = false } = {}) => {
    const sent = take('sent', id), saved = take('draft', id), terminals = take('terminals', id);
    if (fail) sent.reject(new Error('The read failed.'));
    else sent.resolve({ messages: text ? [{ revision: 1, created: '2026-11-26T10:00:00Z', text, attachments: [], confirmed: true }] : [], more: false });
    saved.resolve({ draft: { revision: 2, text: draft, attachments: [], pending: false }, attachments: [] });
    terminals?.resolve(tools.map((tool, index) => ({ number: index + 1, run: `r${index}`, tool, status: 'running', started: '', ended: '' })));
    await settled();
  };
  return { rows, reads, log, waiting, answer, take, settled, changes: () => changes, setAvailable };
}
const launched = (id, status) => session(id, { status, preparation: { toolName: 'Codex' } });

test('the first read of a row gives the tool of the latest terminal, the latest message, and the draft', async () => {
  const { rows, log, answer, changes } = fixture();
  rows.update([launched('a', 'idle')], { a: 'idle' });
  rows.load();
  assert.deepEqual(log, ['sent:a', 'draft:a', 'terminals:a']);
  assert.equal(rows.detail('a'), undefined, 'the row shows the tool of the launch until the reply');
  await answer('a', { draft: 'Also check the logs.' });
  assert.deepEqual(rows.detail('a'), { tool: 'Claude Code', unsent: true, last: { text: 'Run the tests.', created: '2026-11-26T10:00:00Z' } });
  assert.equal(changes(), 1);
  rows.load();
  assert.equal(log.length, 3, 'a row reads again only after a status change');
});

test('a status change reads the message and the draft again, and the terminals only until a reply gives them', async () => {
  const { rows, log, answer } = fixture();
  rows.update([launched('a', 'idle')], { a: 'idle' });
  rows.load();
  await answer('a');
  rows.update([launched('a', 'idle')], { a: 'running' });
  rows.load();
  assert.deepEqual(log.slice(3), ['sent:a', 'draft:a']);
  await answer('a', { text: 'Fix the test.' });
  assert.deepEqual(rows.detail('a'), { tool: 'Claude Code', unsent: false, last: { text: 'Fix the test.', created: '2026-11-26T10:00:00Z' } });
});

test('a row reads its terminals again when a newer read replaces the first reply', async () => {
  const { rows, log, answer } = fixture();
  rows.update([launched('a', 'idle')], { a: 'idle' });
  rows.load();
  rows.update([launched('a', 'idle')], { a: 'running' });
  rows.load();
  assert.deepEqual(log, ['sent:a', 'draft:a', 'terminals:a', 'sent:a', 'draft:a', 'terminals:a']);
  await answer('a', { text: 'The reply of the first read.' });
  assert.equal(rows.detail('a'), undefined, 'the reply of the replaced read does not show');
  await answer('a');
  assert.equal(rows.detail('a').tool, 'Claude Code');
  rows.update([launched('a', 'idle')], { a: 'idle' });
  rows.load();
  assert.deepEqual(log.slice(6), ['sent:a', 'draft:a'], 'the tool is known now');
});

test('a row reads its terminals again after a failed first read', async () => {
  const { rows, log, answer } = fixture();
  rows.update([launched('a', 'idle')], { a: 'idle' });
  rows.load();
  await answer('a', { fail: true });
  assert.equal(rows.detail('a'), undefined);
  rows.load();
  assert.equal(log.length, 3, 'a failed read waits for the next status change');
  rows.update([launched('a', 'idle')], { a: 'running' });
  rows.load();
  assert.deepEqual(log.slice(3), ['sent:a', 'draft:a', 'terminals:a']);
  await answer('a');
  assert.equal(rows.detail('a').tool, 'Claude Code');
});

test('a row keeps its data when a later read fails', async () => {
  const { rows, answer } = fixture();
  rows.update([launched('a', 'idle')], { a: 'idle' });
  rows.load();
  await answer('a');
  rows.update([launched('a', 'idle')], { a: 'running' });
  rows.load();
  await answer('a', { fail: true });
  assert.equal(rows.detail('a').last.text, 'Run the tests.');
});

test('Home reads each row again when it opens, and the rows keep their data until the replies', async () => {
  const { rows, log, answer } = fixture();
  rows.update([launched('a', 'idle')], { a: 'idle' });
  rows.load();
  await answer('a');
  rows.reopen();
  rows.load();
  assert.deepEqual(log.slice(3), ['sent:a', 'draft:a', 'terminals:a']);
  assert.equal(rows.detail('a').tool, 'Claude Code');
  await answer('a', { tools: ['Codex', 'Claude Code', 'Codex'] });
  assert.equal(rows.detail('a').tool, 'Codex');
});

test('a session that ends leaves Home, and a new terminal reads its data again', async () => {
  const { rows, log, answer } = fixture();
  rows.update([launched('a', 'idle')], { a: 'idle' });
  rows.load();
  await answer('a');
  rows.update([launched('a', 'ended')], {});
  rows.load();
  assert.equal(rows.detail('a'), undefined);
  assert.deepEqual(rows.groups(), { running: [], idle: [] });
  rows.update([launched('a', 'ended')], { a: 'running' });
  rows.load();
  assert.deepEqual(log.slice(3), ['sent:a', 'draft:a', 'terminals:a']);
});

test('Home reads a live session outside the list, and then the data of its row', async () => {
  const { rows, log, answer, take, settled } = fixture();
  rows.update([], { x: 'idle' });
  rows.load();
  rows.load();
  assert.deepEqual(log, ['session:x'], 'one read asks for the session');
  take('session', 'x').reject(new Error('The read failed.'));
  await settled();
  rows.load();
  assert.deepEqual(log, ['session:x', 'session:x'], 'the next load asks again after a failed read');
  take('session', 'x').resolve({ archived: false, pinned: false, id: 'x', projectId: 'repo', parentId: 'p', title: 'Older session', workspace: '/w', status: 'idle' });
  await settled();
  assert.deepEqual(rows.groups().idle.map(item => item.id), ['x']);
  assert.equal(rows.session('x').parentId, 'p');
  assert.deepEqual(log.slice(2), ['sent:x', 'draft:x', 'terminals:x', 'session:p'], 'the row data, then the top-level session');
  await answer('x');
  assert.equal(rows.detail('x').tool, 'Claude Code');
  rows.update([], {});
  rows.load();
  assert.deepEqual(rows.groups(), { running: [], idle: [] });
  assert.equal(rows.session('x'), undefined);
});

test('Home reads nothing while the server is not known', () => {
  const { rows, log, setAvailable } = fixture();
  setAvailable(false);
  rows.update([launched('a', 'idle')], { a: 'idle', x: 'running' });
  rows.load();
  assert.deepEqual(log, []);
  assert.deepEqual(rows.groups().idle.map(item => item.id), ['a']);
});

test('a reply that arrives while the reads are not available starts no read', async () => {
  const { rows, log, take, settled, setAvailable } = fixture();
  rows.update([], { x: 'idle' });
  rows.load();
  setAvailable(false);
  take('session', 'x').resolve({ archived: false, pinned: false, id: 'x', projectId: 'repo', title: 'Older session', workspace: '/w', status: 'idle' });
  await settled();
  assert.deepEqual(log, ['session:x'], 'the row of the session reads nothing');
  setAvailable(true);
  rows.reopen();
  rows.load();
  assert.deepEqual(log.slice(1), ['session:x', 'sent:x', 'draft:x', 'terminals:x']);
});

test('Home reads the top-level session of a row when no list holds it', async () => {
  const { rows, log, answer, take, settled, changes } = fixture();
  const parent = { archived: false, pinned: false, id: 'p', projectId: 'repo', title: 'Refactor orbit', workspace: '/w', status: 'ended' };
  rows.update([session('c', { status: 'idle', parentId: 'p' })], { c: 'idle' });
  rows.load();
  rows.load();
  assert.deepEqual(log, ['sent:c', 'draft:c', 'terminals:c', 'session:p'], 'one read asks for the top-level session');
  assert.equal(rows.session('p'), undefined);
  take('session', 'p').resolve(parent);
  await settled();
  assert.equal(rows.session('p').title, 'Refactor orbit');
  assert.equal(changes(), 1);
  assert.deepEqual(rows.groups().idle.map(item => item.id), ['c'], 'the ended session is not a row');
  await answer('c');
  rows.update([session('p'), session('c', { status: 'idle', parentId: 'p' })], { c: 'idle' });
  rows.load();
  assert.equal(log.length, 4, 'a listed top-level session needs no read');
  rows.update([session('c', { status: 'idle', parentId: 'live' })], { c: 'idle', live: 'running' });
  rows.load();
  assert.deepEqual(log.slice(4), ['session:live'], 'a live top-level session comes with the sessions outside the list');
  rows.update([], {});
  rows.load();
  assert.equal(rows.session('p'), undefined, 'Home forgets the top-level session of a row that left');
});

// A small page for HomeView: the elements that it reads, with their children.
class Node {
  constructor(tag = 'div') { this.tagName = tag; }
  hidden = false;
  disabled = false;
  className = '';
  textContent = '';
  title = '';
  dataset = {};
  attributes = {};
  children = [];
  names = new Set();
  classList = { toggle: (name, on) => { if (on) this.names.add(name); else this.names.delete(name); } };
  append(...nodes) { for (const node of nodes) if (node instanceof Node) this.children.push(node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener() {}
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : node.tagName === selector;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  focus() {}
  get text() { return [this.textContent, ...this.children.map(child => child.text)].filter(Boolean).join(' | '); }
}

function page() {
  const nodes = new Map();
  globalThis.HTMLElement = globalThis.HTMLButtonElement = Node;
  globalThis.document = {
    activeElement: null,
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); },
    createElement: tag => new Node(tag),
    addEventListener() {},
  };
  // HomeView starts a timer for the times of the rows. A test must not keep it.
  const timer = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  const { reads, log, take, settled, setAvailable } = fixture();
  let available = true;
  const opened = [];
  const view = new HomeView({ reads: () => available ? reads : null, open: item => opened.push(item.id), draft() {}, addProject() {} });
  globalThis.setInterval = timer;
  const $ = id => document.getElementById(id);
  return { view, $, log, take, settled, opened, rows: () => $('home-groups').querySelectorAll('.home-row'), setAvailable, noServer: () => { available = false; } };
}
const repo = [{ id: 'repo', name: 'Orbit API', workspace: '/work/repo' }];

test('Home shows the live sessions of a removed project, with Project in place of New session', () => {
  const { view, $, rows, noServer } = page();
  noServer();
  view.update([], [session('a', { status: 'idle', projectId: '' })], { a: 'idle' });
  assert.equal($('home-groups').hidden, false);
  assert.equal($('home-text').hidden, true);
  assert.equal($('home-add-project').hidden, false);
  assert.equal($('home-new-open').hidden, true);
  assert.deepEqual(rows().map(row => row.text), ['a | /work/repo']);
  view.update([], [session('a')], {});
  assert.equal($('home-groups').hidden, true, 'without a project and a live session, the text replaces the groups');
  assert.equal($('home-text').textContent, 'No projects yet.');
  assert.equal($('home-text').hidden, false);
  assert.equal($('home-add-project').hidden, false);
  view.update(repo, [session('a')], {});
  assert.equal($('home-groups').hidden, false);
  assert.equal($('home-groups').text, 'Running | 0 | Idle | 0', 'a group without a session shows only its heading');
  assert.equal($('home-text').hidden, true);
  assert.equal($('home-add-project').hidden, true);
  assert.equal($('home-new-open').hidden, false);
});

test('a hidden Home starts no read when a reply arrives', async () => {
  const { view, log, take, settled } = page();
  view.update(repo, [], { x: 'idle' });
  assert.deepEqual(log, ['session:x']);
  view.show(false);
  take('session', 'x').resolve({ archived: false, pinned: false, id: 'x', projectId: 'repo', title: 'Older session', workspace: '/w', status: 'idle' });
  await settled();
  assert.deepEqual(log, ['session:x']);
  view.show(true);
  assert.deepEqual(log.slice(1), ['session:x', 'sent:x', 'draft:x', 'terminals:x']);
});

test('the buttons of Home are off while an action runs, also on new rows', () => {
  const { view, $, rows, opened, noServer } = page();
  noServer();
  view.update(repo, [session('a', { status: 'idle' })], { a: 'idle' });
  rows()[0].onclick();
  assert.deepEqual(opened, ['a']);
  view.controls(true);
  assert.deepEqual([$('home-add-project').disabled, $('home-new-open').disabled, rows()[0].disabled], [true, true, true]);
  view.update(repo, [session('a', { status: 'idle' }), session('b', { status: 'running' })], { a: 'idle', b: 'running' });
  assert.deepEqual(rows().map(row => row.disabled), [true, true]);
  view.controls(false);
  assert.deepEqual([$('home-add-project').disabled, $('home-new-open').disabled, ...rows().map(row => row.disabled)], [false, false, false, false]);
});

test('Home shows why the page cannot read the session list, also before the first list', () => {
  const { view, $ } = page();
  view.problem('Cannot connect to the bbflow server.');
  assert.equal($('home-problem').textContent, 'Cannot connect to the bbflow server.');
  assert.equal($('home-problem').hidden, false);
  assert.equal($('home-groups').children.length, 0, 'Home shows no groups before the first list');
  view.update(repo, [session('a', { status: 'idle' })], { a: 'idle' });
  assert.equal($('home').names.has('stale'), true, 'the rows can be out of date');
  view.problem('');
  assert.equal($('home-problem').hidden, true);
  assert.equal($('home').names.has('stale'), false);
});
