import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elapsedText, homeGroups, homeText, lastMessage, listedSession, placeLine, since, unlisted, unsent } from './dist/home.js';

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
