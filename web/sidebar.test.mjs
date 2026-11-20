import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestRow, sidebarBounds } from './dist/sidebar.js';

test('a wide window allows sidebar widths from 240 to 480 pixels', () => {
  assert.deepEqual(sidebarBounds(1600), { min: 240, max: 480 });
});

test('a narrower window keeps 400 pixels for the main area', () => {
  assert.deepEqual(sidebarBounds(800), { min: 240, max: 400 });
});

test('the maximum width is never less than the minimum width', () => {
  assert.deepEqual(sidebarBounds(600), { min: 240, max: 240 });
});

test('focus goes to the nearest later row after a row leaves the list', () => {
  assert.equal(nearestRow(['a', 'b', 'c'], 'b', ['a', 'c']), 'c');
});

test('focus goes to the nearest earlier row when no later row shows', () => {
  assert.equal(nearestRow(['a', 'b', 'c'], 'c', ['a', 'b']), 'b');
  // A later row that the new list does not show is skipped.
  assert.equal(nearestRow(['a', 'b', 'c', 'd'], 'b', ['a', 'd']), 'd');
  assert.equal(nearestRow(['a', 'b', 'c'], 'b', ['a']), 'a');
});

test('no row gets the focus when the new list shows none of the earlier rows', () => {
  assert.equal(nearestRow(['a'], 'a', []), undefined);
  assert.equal(nearestRow(['a', 'b'], 'a', ['x']), undefined);
});
