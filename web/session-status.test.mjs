import { test } from 'node:test';
import assert from 'node:assert/strict';
import { live, statusText } from './dist/session-status.js';

test('only running and idle sessions have a live terminal', () => {
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
