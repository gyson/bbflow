import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeRows, elapsedText, homeGroups, homeText, lastMessage, listedSession, placeLine, since, unlisted, unsent } from './dist/home.js';

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

test('the Home text tells how to add the first project, and then how to start a session', () => {
  assert.equal(homeText(0, 0), 'Click ＋ Project to add a folder. Then click ＋ New session to start a session.');
  assert.equal(homeText(2, 0), 'No session has a live terminal. Click ＋ New session to start one. To continue an earlier session, select it in the sidebar.');
  assert.equal(homeText(2, 1), '');
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
  return { rows, log, answer, take, settled, changes: () => changes, unavailable: () => { available = false; } };
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
  assert.deepEqual(log.slice(2), ['sent:x', 'draft:x', 'terminals:x']);
  await answer('x');
  assert.equal(rows.detail('x').tool, 'Claude Code');
  rows.update([], {});
  rows.load();
  assert.deepEqual(rows.groups(), { running: [], idle: [] });
  assert.equal(rows.session('x'), undefined);
});

test('Home reads nothing while the server is not known', () => {
  const { rows, log, unavailable } = fixture();
  unavailable();
  rows.update([launched('a', 'idle')], { a: 'idle', x: 'running' });
  rows.load();
  assert.deepEqual(log, []);
  assert.deepEqual(rows.groups().idle.map(item => item.id), ['a']);
});
