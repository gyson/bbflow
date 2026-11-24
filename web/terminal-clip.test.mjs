import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipTop, followCursor, showCursor } from './dist/terminal-clip.js';

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

// A terminal of 30 rows with cells of 20 pixels, in a view of 200 pixels.
function clipped(cursorY) {
  const container = {
    scrollTop: 0, scrollHeight: 600, clientHeight: 200,
    getBoundingClientRect() { return { top: 100 }; },
    querySelector: () => ({ clientHeight: 600, getBoundingClientRect: () => ({ top: 100 - container.scrollTop }) }),
  };
  return { container, view: { rows: 30, buffer: { active: { cursorY } } } };
}

test('a frame and a cursor movement show the cursor row again', () => {
  const { container, view } = clipped(29);
  followCursor(container, view);
  assert.equal(container.scrollTop, 400);
  view.buffer.active.cursorY = 12;
  followCursor(container, view);
  assert.equal(container.scrollTop, 60);
});

test('a frame and a cursor movement keep the part that a drag shows', () => {
  const { container, view } = clipped(29);
  showCursor(container, view);
  assert.equal(container.scrollTop, 400);
  // A drag of the user.
  container.scrollTop = 250;
  followCursor(container, view);
  view.buffer.active.cursorY = 12;
  followCursor(container, view);
  assert.equal(container.scrollTop, 250);
  // Typed input and a change of the view size show the cursor row.
  showCursor(container, view);
  assert.equal(container.scrollTop, 60);
  followCursor(container, view);
  assert.equal(container.scrollTop, 60);
});

test('a drag back to the shown cursor row follows the cursor again', () => {
  const { container, view } = clipped(29);
  showCursor(container, view);
  container.scrollTop = 250;
  followCursor(container, view);
  container.scrollTop = 400;
  view.buffer.active.cursorY = 12;
  followCursor(container, view);
  assert.equal(container.scrollTop, 60);
});
