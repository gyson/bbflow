import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continueAction, continueHint, defaultContinueTool } from './dist/continue.js';
import { insertProblem } from './dist/composer.js';

const tools = [
  { id: 'codex', name: 'Codex', command: 'codex', continueCommand: 'codex {prompt}' },
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

test('the form prefers the original tool, then the default tool, then Shell', () => {
  assert.equal(defaultContinueTool(tools, 'plain', 'codex'), 'plain');
  assert.equal(defaultContinueTool(tools, '', 'codex'), '', 'a session that started with Shell');
  assert.equal(defaultContinueTool(tools, 'removed', 'codex'), 'codex');
  assert.equal(defaultContinueTool(tools, undefined, 'removed'), '');
});

test('the hint says when bbflow sends the prompt', () => {
  assert.match(continueHint(tools[0]), /submits “codex \{prompt\}” once/);
  assert.match(continueHint(tools[1]), /submits “plain --interactive” and does not send the prompt/);
  assert.match(continueHint(undefined), /submits no command/);
});

test('the handoff prompt goes only into an empty editor without a pending send', () => {
  const ready = { loaded: true, pending: false, text: ' \n', files: 0 };
  assert.equal(insertProblem(ready), undefined);
  assert.match(insertProblem({ ...ready, loaded: false }), /not ready/);
  assert.match(insertProblem({ ...ready, pending: true }), /unlock the draft/);
  assert.match(insertProblem({ ...ready, text: 'my request' }), /already has a draft/);
  assert.match(insertProblem({ ...ready, files: 1 }), /already has a draft/);
});

test('the hint says where to find the prompt later', () => {
  assert.match(continueHint(tools[1]), /Handoff prompt in the message editor shows it again/);
  assert.match(continueHint(undefined), /Handoff prompt in the message editor shows it again/);
});
