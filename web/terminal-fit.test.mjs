import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitCount } from './dist/terminal-fit.js';

// The cell sizes in device pixels that xterm.js 6.0.0 measured in Chrome on macOS for
// the fonts of the page. The main terminal uses Menlo at 13 px with a line height of
// 1.25. The side terminal uses Menlo at 12 px with a line height of 1.2.
const cells = [
  { dpr: 1, width: 7.82666015625, height: 18 }, { dpr: 1.5, width: 11.739990234375, height: 28 },
  { dpr: 2, width: 15.6533203125, height: 37 }, { dpr: 1, width: 7.224609375, height: 16 },
  { dpr: 1.5, width: 10.8369140625, height: 25 }, { dpr: 2, width: 14.44921875, height: 33 },
];

// xterm.js draws n cells in this many CSS pixels.
const drawn = (cell, n, dpr) => Math.round(cell * n / dpr);

// The proposal of the fit addon of xterm.js, when the terminal has current cells. It
// divides by the drawn size of one cell at the current size.
const addon = (available, cell, dpr, current) => Math.floor(available / (drawn(cell, current, dpr) / current));

test('a fit gives the largest number of cells that xterm.js draws in the area', () => {
  for (const { dpr, width, height } of cells) {
    for (const cell of [width, height]) {
      for (let available = 20; available <= 2600; available++) {
        const count = fitCount(available, cell, dpr);
        assert.ok(drawn(cell, count, dpr) <= available, `${count} cells overflow ${available} px at ${dpr}x`);
        assert.ok(drawn(cell, count + 1, dpr) > available, `${count + 1} cells fit ${available} px at ${dpr}x`);
      }
    }
  }
});

test('a fit does not depend on the current size', () => {
  // A main terminal 2278 px wide at 1x. At 147 columns, the fit addon asks for 290
  // columns. At 290 columns, it asks for 291.
  const { dpr, width } = cells[0];
  assert.deepEqual([addon(2278, width, dpr, 147), addon(2278, width, dpr, 290)], [290, 291]);
  assert.equal(fitCount(2278, width, dpr), 291);
  // A main terminal 130 px high at 2x. The fit addon asks for 7 rows at 6 rows, and for
  // 6 rows at 7 rows, so a live view would resize without end.
  const { height } = cells[2];
  assert.deepEqual([addon(130, height, 2, 6), addon(130, height, 2, 7)], [7, 6]);
  assert.equal(fitCount(130, height, 2), 7);
});

test('a fit without space or without a measured cell has no cells', () => {
  assert.equal(fitCount(0, 15.65, 2), 0);
  assert.equal(fitCount(-14, 15.65, 2), 0);
  assert.equal(fitCount(500, 0, 2), 0);
  assert.equal(fitCount(500, 15.65, 0), 0);
  assert.equal(fitCount(Number.NaN, 15.65, 2), 0);
});
