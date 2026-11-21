import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continueAction, continueDialogError, continueDialogProblem, defaultContinueTool } from './dist/continue.js';
import { restartedMessage } from './dist/restart.js';
import { insertProblem } from './dist/composer.js';

const tools = [
  { id: 'codex', name: 'Codex', command: 'codex' },
  { id: 'plain', name: 'Plain', command: 'plain --interactive' },
];

test('only an ended, unarchived session without a live view shows Continue', () => {
  const run = { id: 'run-1' };
  assert.deepEqual(continueAction({ status: 'ended', run }, false), { visible: true, problem: '' });
  for (const status of ['running', 'idle', 'draft']) assert.equal(continueAction({ status, run }, false).visible, false, status);
  assert.equal(continueAction({ status: 'ended' }, false).visible, false, 'a session without a run');
  assert.equal(continueAction({ status: 'ended', run, archived: true }, false).visible, false, 'an archived session');
  assert.equal(continueAction({ status: 'ended', run }, true).visible, false, 'a live view');
  assert.equal(continueAction(null, false).visible, false);
});

test('viewing an earlier terminal hides Continue', () => {
  const session = { status: 'ended', run: { id: 'run-2' } };
  assert.equal(continueAction(session, false, 'run-1').visible, false);
  assert.equal(continueAction(session, false, '').visible, true);
});

test('an unavailable managed worktree keeps Continue visible with a reason', () => {
  const session = { status: 'ended', run: { id: 'run-1' } };
  assert.deepEqual(continueAction({ ...session, worktree: { state: 'ready' } }, false), { visible: true, problem: '' });
  assert.deepEqual(continueAction({ ...session, worktree: { state: 'removed' } }, false), {
    visible: true, problem: 'Worktree removed. A new terminal cannot start here.',
  });
  assert.deepEqual(continueAction({ ...session, worktree: { state: 'creating' } }, false), {
    visible: true, problem: 'Worktree unavailable. A new terminal cannot start here.',
  });
});

test('an open Continue dialog gives a reason when its session changes', () => {
  const session = { status: 'ended', run: { id: 'run-1' } };
  const available = continueAction(session, false);
  assert.equal(continueDialogProblem(available, 'run-1', 'run-1'), '');
  assert.match(continueDialogProblem(continueAction({ ...session, status: 'idle' }, false), 'run-1', 'run-1'), /session changed/);
  assert.match(continueDialogProblem(available, 'run-2', 'run-1'), /session changed/);
  const removed = continueAction({ ...session, worktree: { state: 'removed' } }, false);
  assert.match(continueDialogProblem(removed, 'run-1', 'run-1'), /Worktree removed/);
});

test('an open Continue dialog has no reason after the session is available again', () => {
  // Another view archives the session, then restores it. The latest run stays the same.
  const session = { status: 'ended', run: { id: 'run-1' } };
  assert.match(continueDialogProblem(continueAction({ ...session, archived: true }, false), 'run-1', 'run-1'), /session changed/);
  assert.equal(continueDialogProblem(continueAction(session, false), 'run-1', 'run-1'), '');
});

test('an open Continue dialog keeps the restart message and a blocked start', () => {
  const session = { status: 'ended', run: { id: 'run-1' } };
  const changed = continueDialogProblem(continueAction({ ...session, archived: true }, false), 'run-1', 'run-1');
  // Another view archives the session. The dialog shows the reason and blocks the start.
  let state = continueDialogError({ text: '', hidden: true }, '', changed, false);
  assert.deepEqual(state, { error: { text: changed, hidden: false }, shown: changed, blocked: true });
  // The server restarts. The restart message replaces the reason, also after the next
  // refresh, while the session change stays.
  for (let refresh = 0; refresh < 2; refresh++) {
    state = continueDialogError(state.error, state.shown, changed, true);
    assert.deepEqual(state, { error: { text: restartedMessage, hidden: false }, shown: '', blocked: true });
  }
  // A restore does not remove the restart message, because the page must reload first.
  state = continueDialogError(state.error, state.shown, '', true);
  assert.deepEqual(state, { error: { text: restartedMessage, hidden: false }, shown: '', blocked: true });
});

test('an open Continue dialog removes only its own reason when the session is available again', () => {
  const changed = 'This session changed. Open Continue in new terminal again when it is available.';
  // A restore removes the reason and allows the start.
  const shown = continueDialogError({ text: '', hidden: true }, '', changed, false);
  assert.deepEqual(continueDialogError(shown.error, shown.shown, '', false), { error: { text: changed, hidden: true }, shown: '', blocked: false });
  // A failed copy replaced the reason. That error stays.
  const copy = { text: 'Cannot copy the prompt: denied', hidden: false };
  assert.deepEqual(continueDialogError(copy, changed, '', false), { error: copy, shown: '', blocked: false });
  assert.deepEqual(continueDialogError(copy, '', '', false), { error: copy, shown: '', blocked: false });
});

test('the form prefers the original tool, then the default tool, then Shell', () => {
  assert.equal(defaultContinueTool(tools, 'plain', 'codex'), 'plain');
  assert.equal(defaultContinueTool(tools, '', 'codex'), '', 'a session that started with Shell');
  assert.equal(defaultContinueTool(tools, 'removed', 'codex'), 'codex');
  assert.equal(defaultContinueTool(tools, undefined, 'removed'), '');
});

test('the handoff prompt goes only into an empty editor without a pending send', () => {
  const ready = { loaded: true, pending: false, text: ' \n', files: 0 };
  assert.equal(insertProblem(ready), undefined);
  assert.match(insertProblem({ ...ready, loaded: false }), /not ready/);
  assert.match(insertProblem({ ...ready, pending: true }), /unlock the draft/);
  assert.match(insertProblem({ ...ready, text: 'my request' }), /already has a draft/);
  assert.match(insertProblem({ ...ready, files: 1 }), /already has a draft/);
});
