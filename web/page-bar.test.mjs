import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageBar } from './dist/page-bar.js';
import { restartedMessage } from './dist/restart.js';

const offer = { revision: 1, version: '0.0.14', available: '0.0.15', state: 'available' };

test('the page bar shows an update only while the status watch reports it', () => {
  const hidden = { kind: '', text: '', reload: false };
  assert.deepEqual(pageBar(false, undefined), hidden);
  assert.deepEqual(pageBar(false, offer), hidden);
  assert.deepEqual(pageBar(false, { ...offer, state: 'failed', error: 'download failed' }), hidden);
  assert.deepEqual(pageBar(false, { ...offer, state: 'updating' }), {
    kind: 'info', text: 'bbflow updates to 0.0.15. This page reloads when the new server starts.', reload: false,
  });
});

test('a restart replaces the update bar and offers a reload', () => {
  const restart = { kind: 'warning', text: restartedMessage, reload: true };
  assert.deepEqual(pageBar(true, undefined), restart);
  assert.deepEqual(pageBar(true, { ...offer, state: 'updating' }), restart);
});
