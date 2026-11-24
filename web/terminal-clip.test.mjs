import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipTop } from './dist/terminal-clip.js';

// A terminal of 30 rows with cells of 20 pixels, in a container of 200 pixels.
const view = { contentHeight: 600, height: 200 };
const row = index => ({ ...view, cursorTop: index * 20, cursorBottom: index * 20 + 20 });

test('a lower container shows the last rows when the cursor is in them', () => {
  assert.equal(clipTop(row(29)), 400);
  assert.equal(clipTop(row(20)), 400);
});

test('a lower container shows the cursor row last when the cursor is above the last rows', () => {
  assert.equal(clipTop(row(19)), 200);
  assert.equal(clipTop(row(12)), 60);
});

test('a lower container shows the first rows when the cursor is in them', () => {
  assert.equal(clipTop(row(0)), 0);
  assert.equal(clipTop(row(9)), 0);
});

test('a container that shows all rows does not scroll', () => {
  assert.equal(clipTop({ contentHeight: 200, height: 200, cursorTop: 180, cursorBottom: 200 }), 0);
  assert.equal(clipTop({ contentHeight: 100, height: 200, cursorTop: 0, cursorBottom: 20 }), 0);
});
