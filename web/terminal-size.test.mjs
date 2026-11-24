import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiddenSize, scrollbackRows, smallestSize, terminalSize } from './dist/terminal-size.js';

test('a view asks for a PTY size of at least 20 columns and 5 rows', () => {
  // The size of a terminal that a narrow session column squeezed.
  assert.deepEqual(terminalSize({ rows: 16, cols: 7 }), { rows: 16, cols: 20 });
  assert.deepEqual(terminalSize({ rows: 2, cols: 2 }), { rows: 5, cols: 20 });
  assert.deepEqual(terminalSize({ rows: 5, cols: 20 }), { rows: 5, cols: 20 });
  assert.deepEqual(terminalSize({ rows: 45, cols: 110 }), { rows: 45, cols: 110 });
});

test('a new terminal starts at the smallest size that a view asks for', () => {
  assert.deepEqual(smallestSize, terminalSize({ rows: 1, cols: 1 }));
});

test('a hidden terminal joins with a shown size, or else with 80 columns and 24 rows', () => {
  // The map keeps the latest entry last.
  const shown = new Map([['one', { rows: 30, cols: 100 }], ['two', { rows: 18, cols: 40 }]]);
  assert.deepEqual(hiddenSize(shown, 'one'), { rows: 30, cols: 100 });
  assert.deepEqual(hiddenSize(shown, 'three'), { rows: 18, cols: 40 });
  assert.deepEqual(hiddenSize(shown, ''), { rows: 18, cols: 40 });
  // The first terminal of the tab is hidden. It does not ask for the smallest size.
  assert.deepEqual(hiddenSize(new Map(), 'one'), { rows: 24, cols: 80 });
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
