import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrollbackRows, terminalSize } from './dist/terminal-size.js';

test('a view asks for a PTY size of at least 20 columns and 5 rows', () => {
  // The size of a terminal that a narrow session column squeezed.
  assert.deepEqual(terminalSize({ rows: 16, cols: 7 }), { rows: 16, cols: 20 });
  assert.deepEqual(terminalSize({ rows: 2, cols: 2 }), { rows: 5, cols: 20 });
  assert.deepEqual(terminalSize({ rows: 5, cols: 20 }), { rows: 5, cols: 20 });
  assert.deepEqual(terminalSize({ rows: 45, cols: 110 }), { rows: 45, cols: 110 });
});

test('a view asks for no more than the server limits', () => {
  assert.deepEqual(terminalSize({ rows: 900, cols: 900 }), { rows: 256, cols: 512 });
});

test('a view keeps the history rows of the server limit for its width', () => {
  // Keep these values the same as TestScrollbackRowsByWidth in Go.
  for (const [cols, rows] of [[2, 50000], [20, 50000], [30, 33333], [40, 25000], [80, 12500], [100, 10000], [120, 10000], [512, 10000]]) {
    assert.equal(scrollbackRows(cols), rows, `${cols} columns`);
  }
});
