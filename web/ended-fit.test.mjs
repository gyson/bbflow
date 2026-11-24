import { test } from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/xterm';
import { fitEndedRows } from './dist/ended-fit.js';

const write = (view, data) => new Promise(resolve => view.write(data, resolve));
const shown = view => Array.from({ length: view.rows }, (_, y) =>
  view.buffer.active.getLine(view.buffer.active.baseY + y).translateToString(true));
const cursor = view => [view.buffer.active.cursorX, view.buffer.active.cursorY];
const always = () => true;

// The saved screen of an ended terminal, as a frame leaves it in the view.
async function ended(rows, data) {
  const view = new xterm.Terminal({ cols: 20, rows, scrollback: 100, allowProposedApi: true });
  await write(view, data);
  return view;
}

test('a taller ended terminal shows history rows above the last row', async () => {
  const view = await ended(2, 'h1\r\nh2\r\nh3\r\na\r\nb');
  await fitEndedRows(view, 4, always);
  assert.deepEqual(shown(view), ['h2', 'h3', 'a', 'b']);
  assert.deepEqual(cursor(view), [1, 3]);
  // Blank rows fill the bottom when the history has too few rows.
  await fitEndedRows(view, 7, always);
  assert.deepEqual(shown(view), ['h1', 'h2', 'h3', 'a', 'b', '', '']);
  assert.deepEqual(cursor(view), [1, 4]);
  await fitEndedRows(view, 2, always);
  assert.deepEqual(shown(view), ['a', 'b']);
  assert.deepEqual(cursor(view), [1, 1]);
});

test('blank rows below the last row with text do not hide the history', async () => {
  const view = await ended(4, 'h1\r\nh2\r\nh3\r\nh4\r\na\r\nb\r\n\r\n\x1b[2;2H');
  assert.deepEqual(shown(view), ['a', 'b', '', '']);
  await fitEndedRows(view, 6, always);
  assert.deepEqual(shown(view), ['h1', 'h2', 'h3', 'h4', 'a', 'b']);
  assert.deepEqual(cursor(view), [1, 5]);
});

test('the first fit applies the rule also at the same number of rows', async () => {
  // A prompt on the third row, with blank rows below it and history rows above it.
  const view = await ended(6, 'h1\r\nh2\r\nh3\r\nh4\r\nh5\r\nh6\r\nh7\r\nh8\x1b[3;1H\x1b[Jprompt$ \x1b[3;9H');
  assert.deepEqual(shown(view), ['h3', 'h4', 'prompt$ ', '', '', '']);
  await fitEndedRows(view, 6, always);
  assert.deepEqual(shown(view), ['h1', 'h2', 'h3', 'h4', 'prompt$ ', '']);
  assert.deepEqual(cursor(view), [8, 4]);
  // One more row gives the same layout, with one more blank row at the bottom.
  await fitEndedRows(view, 7, always);
  assert.deepEqual(shown(view), ['h1', 'h2', 'h3', 'h4', 'prompt$ ', '', '']);
  assert.deepEqual(cursor(view), [8, 4]);
});

test('a lower ended terminal keeps the last row with text', async () => {
  const view = await ended(6, 'top\r\nx\r\ny\r\nlast\x1b[1;3H');
  await fitEndedRows(view, 3, always);
  assert.deepEqual(shown(view), ['x', 'y', 'last']);
  assert.equal(view.buffer.active.getLine(0).translateToString(true), 'top');
  // The cursor row is in the scrollback, so the cursor shows on the first row.
  assert.deepEqual(cursor(view), [2, 0]);
});

test('the cursor goes back to its row after a lower and then a taller terminal', async () => {
  // The cursor is in an input row above a status row, as in a full-screen agent.
  const view = await ended(6, 'h1\r\nh2\r\ntop\r\nx\r\ninput\r\nstatus\x1b[3;3H');
  await fitEndedRows(view, 6, always);
  assert.deepEqual(cursor(view), [2, 2]);
  await fitEndedRows(view, 3, always);
  assert.deepEqual(shown(view), ['x', 'input', 'status']);
  assert.deepEqual(cursor(view), [2, 0]);
  await fitEndedRows(view, 6, always);
  assert.deepEqual(shown(view), ['h1', 'h2', 'top', 'x', 'input', 'status']);
  assert.deepEqual(cursor(view), [2, 2]);
});

test('each fit ends with a cursor move, so that xterm.js moves its input element', async () => {
  // The cursor is in the first column of the last row, so each resize leaves it on its
  // target cell.
  const view = await ended(2, 'h1\r\nh2\r\nh3\r\na\r\nb\r');
  let moved = false;
  view.onResize(() => { moved = false; });
  view.onCursorMove(() => { moved = true; });
  for (const rows of [4, 2, 7]) {
    await fitEndedRows(view, rows, always);
    assert.equal(moved, true, `rows ${rows}`);
  }
  assert.deepEqual(cursor(view), [0, 4]);
});

test('requests during a fit end with the rows of the last request', async () => {
  const view = await ended(2, 'h1\r\nh2\r\nh3\r\na\r\nb');
  const first = fitEndedRows(view, 4, always);
  const last = fitEndedRows(view, 3, always);
  assert.equal(first, last);
  await last;
  assert.deepEqual(shown(view), ['h3', 'a', 'b']);
});

test('a terminal that the page no longer shows keeps its rows', async () => {
  const view = await ended(2, 'h1\r\nh2\r\nh3\r\na\r\nb');
  let showing = true;
  const fit = fitEndedRows(view, 4, () => showing);
  showing = false;
  await fit;
  assert.deepEqual(shown(view), ['a', 'b']);
});
