import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitReason, hasTerminal, listStatus, live, statusText, terminalsChanged } from './dist/session-status.js';

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
