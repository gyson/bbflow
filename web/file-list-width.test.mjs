import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileListBounds } from './dist/file-list-width.js';

test('a wide pane allows file list widths from 140 pixels to all but 280 pixels', () => {
  assert.deepEqual(fileListBounds(900), { min: 140, max: 620 });
});

test('the maximum width is never less than the minimum width', () => {
  assert.deepEqual(fileListBounds(300), { min: 140, max: 140 });
});
