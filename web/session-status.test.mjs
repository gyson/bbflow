import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endReasonText, exitReason, hasTerminal, listStatus, listStatusLabel, listStatusText, live, statusIcon, statusText, stopMembers, stopShows, stopText, terminalsChanged } from './dist/session-status.js';

test('only running and idle sessions are live', () => {
  for (const status of ['running', 'idle']) assert.equal(live(status), true, status);
  for (const status of ['draft', 'ended', '', undefined]) assert.equal(live(status), false, String(status));
});

test('an ended session shows the reason for its end', () => {
  assert.equal(statusText('running'), 'Running');
  assert.equal(statusText('idle'), 'Idle');
  assert.equal(statusText('ended'), 'Ended');
  assert.equal(statusText('ended', 'exit 3'), 'Ended · exit 3');
  assert.equal(statusText('ended', 'interrupted'), 'Ended · interrupted');
  assert.equal(statusText('idle', 'exited'), 'Idle', 'a live session has no end reason');
});

test('a session that creates its worktree has no terminal to stop', () => {
  assert.equal(hasTerminal({ status: 'running', preparation: { state: 'creating' } }), false);
  assert.equal(hasTerminal({ status: 'running', preparation: { state: 'launched' } }), true);
  assert.equal(hasTerminal({ status: 'idle' }), true);
  for (const session of [{ status: 'ended' }, { status: 'draft', preparation: { state: 'draft' } }, null, undefined]) {
    assert.equal(hasTerminal(session), false, JSON.stringify(session));
  }
});

test('the session list shows a pushed status before its own status', () => {
  assert.equal(listStatus({ id: 'one', status: 'idle' }, { one: 'running' }), 'running');
  assert.equal(listStatus({ id: 'one', status: 'ended' }, { one: 'idle' }), 'idle');
  assert.equal(listStatus({ id: 'one', status: 'ended' }, { two: 'running' }), 'ended');
  assert.equal(listStatus({ id: 'one', status: 'draft' }, {}), 'draft');
});

test('only a started or ended terminal changes the set of live terminals', () => {
  assert.equal(terminalsChanged({}, {}), false);
  assert.equal(terminalsChanged({ one: 'idle' }, { one: 'running' }), false);
  assert.equal(terminalsChanged({}, { one: 'running' }), true);
  assert.equal(terminalsChanged({ one: 'idle' }, {}), true);
  assert.equal(terminalsChanged({ one: 'idle' }, { two: 'idle' }), true);
});

test('an exit shows its code, and other ends show the recorded run status', () => {
  assert.equal(exitReason(0, 'exited'), 'exit 0');
  assert.equal(exitReason(3, 'exited'), 'exit 3');
  assert.equal(exitReason(129, 'stopped'), 'stopped');
  assert.equal(exitReason(1, 'failed'), 'failed');
  assert.equal(exitReason(undefined, undefined), 'exit 0');
});

test('the status line of a listed session shows its status, archive state, and views', () => {
  assert.equal(listStatusText('running', {}), 'Running: a screen change in the last 10 seconds');
  assert.equal(listStatusText('draft', { archived: true }), 'Draft: not started · Archived');
  assert.equal(listStatusText('idle', { viewers: 1 }, 'own worktree'), 'Idle: live, with no screen change in the last 10 seconds · 1 view · own worktree');
  assert.equal(listStatusText('ended', { archived: true, viewers: 2, runStatus: 'stopped' }), 'Ended · stopped · Archived · 2 views');
  assert.equal(listStatusText('ended', {}), 'Ended');
  assert.equal(listStatusLabel('idle', { viewers: 1 }, 'parent workspace'), 'idle, 1 view, parent workspace');
  assert.equal(listStatusLabel('ended', { runStatus: 'interrupted' }), 'ended, interrupted');
  assert.equal(listStatusLabel('ended', { runStatus: 'exited', archived: true }), 'ended, Archived');
  // A failed or interrupted end has its own icon. A stop or an exit does not.
  assert.deepEqual(['exited', 'stopped', 'failed', 'interrupted', ''].map(run => statusIcon('ended', run)), ['ended', 'ended', 'failed', 'failed', 'ended']);
  assert.equal(statusIcon('running', 'failed'), 'running');
});

test('an end reason applies only to the run that it is about', () => {
  const seen = { run: 'run-1', text: 'exit 3' };
  assert.equal(endReasonText(seen, { id: 'run-1', status: 'exited' }), 'exit 3');
  // Another view continued the session and stopped the new terminal.
  assert.equal(endReasonText(seen, { id: 'run-2', status: 'stopped' }), 'stopped');
  assert.equal(endReasonText(null, { id: 'run-2', status: 'interrupted' }), 'interrupted');
  assert.equal(endReasonText(null, undefined), '');
});

test('a terminal that failed before its run started keeps its reason only without a run', () => {
  const seen = { run: '', text: 'exit 1' };
  assert.equal(endReasonText(seen, undefined), 'exit 1');
  assert.equal(endReasonText(seen, { id: 'run-1', status: 'exited' }), 'exited');
});

test('an ended session does not show the status of a run that is not ended', () => {
  for (const status of ['starting', 'running']) {
    assert.equal(endReasonText(null, { id: 'run-1', status }), '', status);
    assert.equal(endReasonText({ run: 'run-1', text: 'exit 3' }, { id: 'run-2', status }), '', status);
  }
});

test('Stop family stops the members with a live terminal and names the members that create their worktree', () => {
  const member = (id, status, extra = {}) => ({ id, title: id, autoTitle: '', status, ...extra });
  const family = [
    member('Parent', 'idle'),
    member('Ended', 'ended'),
    member('Draft', 'draft'),
    member('Tests', 'running'),
    member('Docs', 'running', { preparation: { state: 'creating' } }),
  ];
  const { stop, starting } = stopMembers(family);
  assert.deepEqual(stop.map(item => item.id), ['Parent', 'Tests']);
  assert.deepEqual(starting.map(item => item.id), ['Docs']);
  assert.deepEqual(stopText(family[0], stop, starting, true), {
    title: 'Stop this family?',
    summary: 'This stops 2 sessions of the family “Parent”:',
    lines: ['Parent · Idle', 'Tests · Running'],
    note: '“Docs” creates its worktree and has no terminal yet. It does not stop.',
    submit: 'Stop family',
  });
});

test('the Stop family text counts one session, uses derived titles, and joins several names', () => {
  const root = { title: '', autoTitle: 'Fix links', status: 'ended' };
  const untitled = { title: '', autoTitle: '', status: 'idle' };
  const starting = ['A', 'B', 'C'].map(title => ({ title, status: 'running', preparation: { state: 'creating' } }));
  assert.deepEqual(familyText(root, [untitled], []), { summary: 'This stops 1 session of the family “Fix links”:', lines: ['Untitled session · Idle'], note: '' });
  assert.equal(stopText(root, [untitled], starting.slice(0, 2), true).note, '“A” and “B” create their worktrees and have no terminals yet. They do not stop.');
  assert.equal(stopText(root, [untitled], starting, true).note, '“A”, “B”, and “C” create their worktrees and have no terminals yet. They do not stop.');
});

function familyText(root, stop, starting) {
  const { summary, lines, note } = stopText(root, stop, starting, true);
  return { summary, lines, note };
}

test('Stop session names one session and its status', () => {
  const root = { title: '', autoTitle: 'Build tide chart', status: 'running' };
  assert.deepEqual(stopMembers([root]), { stop: [root], starting: [] });
  assert.deepEqual(stopText(root, [root], [], false), {
    title: 'Stop this session?',
    summary: 'This stops “Build tide chart”. It is running.',
    lines: [],
    note: '',
    submit: 'Stop session',
  });
  // A session that creates its worktree has no terminal yet, so Stop session does not apply.
  assert.deepEqual(stopMembers([{ ...root, preparation: { state: 'creating' } }]).stop, []);
});

test('Stop session shows while its session has a live terminal', () => {
  const session = status => ({ title: 'Review the refactor', status });
  assert.equal(stopShows([session('running')], false), true);
  assert.equal(stopShows([session('idle')], false), true);
  assert.equal(stopShows([session('ended')], false), false);
  assert.equal(stopShows([session('draft')], false), false);
  assert.equal(stopShows([{ ...session('running'), preparation: { state: 'creating' } }], false), false);
});

test('Stop family shows only while a sub-session has a live terminal', () => {
  const member = (title, status, extra = {}) => ({ title, status, ...extra });
  // With only the top-level session live, Stop family would stop what Stop session stops.
  assert.equal(stopShows([member('Parent', 'running'), member('Child', 'ended')], true), false);
  assert.equal(stopShows([member('Parent', 'idle'), member('Child', 'running')], true), true);
  assert.equal(stopShows([member('Parent', 'ended'), member('Child', 'draft'), member('Tests', 'idle')], true), true);
  assert.equal(stopShows([member('Parent', 'running'), member('Docs', 'running', { preparation: { state: 'creating' } })], true), false);
  assert.equal(stopShows([member('Parent', 'ended'), member('Child', 'ended')], true), false);
});
