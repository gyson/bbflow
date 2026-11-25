import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import xterm from '@xterm/xterm';
import { TerminalStream } from './dist/terminal-stream.js';

const write = (view, data) => new Promise(resolve => view.write(data, resolve));
const cells = view => Array.from({ length: view.rows }, (_, y) => {
  const line = view.buffer.active.getLine(view.buffer.active.baseY + y);
  return Array.from({ length: view.cols }, (_, x) => {
    const cell = line.getCell(x);
    return [cell.getChars() || ' ', cell.getWidth(), cell.getFgColor(), cell.getBgColor(), !!cell.isBold(), !!cell.isUnderline()];
  });
});

// A frame sets the input modes of the application. It sets the display modes, such as
// wraparound, for its own drawing.
const inputModes = ({ modes }) => [modes.applicationCursorKeysMode, modes.applicationKeypadMode,
  modes.bracketedPasteMode, modes.sendFocusMode, modes.mouseTrackingMode];

// The public API of xterm.js does not show the mouse encoding. encoding returns the
// replies of the terminal to a mode query (DECRQM) for each mouse encoding.
const encoding = async view => {
  const replies = [];
  const listener = view.onData(data => replies.push(data));
  await write(view, '\x1b[?1006$p\x1b[?1016$p');
  listener.dispose();
  return replies;
};

test('server frames match raw PTY rendering in real xterm.js', async () => {
  const steps = JSON.parse(await readFile(new URL('./testdata/server-frames.json', import.meta.url), 'utf8'));
  const reference = new xterm.Terminal({ cols: 28, rows: 8, scrollback: 10000, allowProposedApi: true });
  const rendered = new xterm.Terminal({ cols: 120, rows: 30, scrollback: 10000, allowProposedApi: true });
  let resolveFrame;
  const stream = new TerminalStream(rendered, {
    current: () => true, acknowledge: () => resolveFrame(), ready() {}, fail: error => assert.fail(error),
  });
  try {
    for (const [index, step] of steps.entries()) {
      if (step.size) reference.resize(step.size.cols, step.size.rows);
      else await write(reference, step.input);
      const done = new Promise(resolve => { resolveFrame = resolve; });
      stream.push(step.frame);
      await done;
      assert.deepEqual(cells(rendered), cells(reference), `step ${index}: ${step.input}`);
      assert.deepEqual([rendered.buffer.active.cursorX, rendered.buffer.active.cursorY],
        [Math.min(reference.cols - 1, reference.buffer.active.cursorX), reference.buffer.active.cursorY], `cursor step ${index}`);
      assert.deepEqual(inputModes(rendered), inputModes(reference), `input modes step ${index}: ${step.input}`);
      // A query must not go into a split escape sequence of the reference terminal.
      if (!/\x1b[[0-9;?]*$/.test(step.input ?? '')) {
        assert.deepEqual(await encoding(rendered), await encoding(reference), `mouse encoding step ${index}: ${step.input}`);
      }
      // Rendering never forwards historical terminal queries to a process.
      const history = terminal => Array.from({ length: terminal.buffer.normal.baseY }, (_, i) => terminal.buffer.normal.getLine(i).translateToString(true).trimEnd());
      assert.deepEqual(history(rendered), history(reference), `scrollback step ${index}`);
    }
  } finally { reference.dispose(); rendered.dispose(); }
});

// A fake view queues each write. parse calls the callbacks in order, as xterm.js does. A
// callback can queue another write.
function fakeView(calls = []) {
  const queued = [];
  const view = {
    options: {},
    // xterm.js 6.1 parses the waiting writes before a resize. Then no write may wait.
    resize(cols, rows) { assert.equal(queued.length, 0, 'a write waits during a resize'); calls.push(`resize ${cols}x${rows}`); },
    write(bytes, callback) { calls.push(`write ${JSON.stringify(new TextDecoder().decode(bytes))}`); queued.push(callback); },
  };
  return { view, queued, parse: () => { while (queued.length) queued.shift()(); } };
}

test('ack waits for parsing and a stale session view cannot acknowledge', () => {
  let current = true;
  const acks = [];
  const { view, queued, parse } = fakeView();
  const stream = new TerminalStream(view, { current: () => current, acknowledge: n => acks.push(n), ready() {}, fail: e => assert.fail(e) });
  stream.push({ type: 'frame', revision: 1, full: true, size: { cols: 80, rows: 24 } });
  assert.deepEqual(acks, []);
  parse();
  assert.deepEqual(acks, [1]);
  stream.push({ type: 'frame', revision: 2, size: { cols: 80, rows: 24 } });
  queued.shift()(); // The view changes and queues the frame data.
  current = false;
  parse();
  assert.deepEqual(acks, [1]);
});

test('a full frame holds the view, sets its size, then resets it in the write of its data', () => {
  const calls = [];
  const { view, parse } = fakeView(calls);
  const stream = new TerminalStream(view, { current: () => true, acknowledge: () => calls.push('ack'), ready() {}, fail: e => assert.fail(e) });
  stream.push({ type: 'frame', revision: 1, full: true, size: { cols: 40, rows: 10 }, data: btoa('hi') });
  // The task that receives the frame only queues a write.
  assert.deepEqual(calls, ['write "\\u001b[?2026h\\u001b[3J"']);
  parse();
  assert.deepEqual(calls, ['write "\\u001b[?2026h\\u001b[3J"', 'resize 40x10', 'write "\\u001bchi\\u001b[?2026l"', 'ack']);
  // A delta frame does not reset or hold the view.
  calls.length = 0;
  stream.push({ type: 'frame', revision: 2, size: { cols: 40, rows: 10 }, data: btoa('hi') });
  parse();
  assert.deepEqual(calls, ['write ""', 'resize 40x10', 'write "hi"', 'ack']);
  // A stream that stops before the parse does not change the view.
  calls.length = 0;
  stream.push({ type: 'frame', revision: 3, size: { cols: 50, rows: 10 }, data: btoa('hi') });
  stream.stop();
  parse();
  assert.deepEqual(calls, ['write ""']);
});

test('a full frame never shows an empty view in real xterm.js', async () => {
  const view = new xterm.Terminal({ cols: 20, rows: 3, allowProposedApi: true });
  const text = () => view.buffer.active.getLine(view.buffer.active.baseY).translateToString(true);
  // xterm.js can end its parse task after a write, and the browser can paint then. At
  // the resize, the view must still have the earlier screen, and synchronized output must
  // hold the rendering.
  const resize = view.resize.bind(view);
  let atResize;
  view.resize = (cols, rows) => { atResize = [text(), view.modes.synchronizedOutputMode]; resize(cols, rows); };
  let parsed;
  const stream = new TerminalStream(view, {
    current: () => true, acknowledge: () => parsed(), ready() {}, fail: error => assert.fail(error),
  });
  const frame = (revision, cols, line) => new Promise(resolve => {
    parsed = resolve;
    stream.push({ type: 'frame', revision, full: true, size: { cols, rows: 3 }, data: btoa(`\x1b[H${line}`) });
  });
  try {
    await frame(1, 20, 'first');
    const second = frame(2, 30, 'second');
    // At the end of the task that receives the frame, the view shows the earlier frame.
    assert.deepEqual([text(), view.cols], ['first', 20]);
    await second;
    assert.deepEqual(atResize, ['first', true]);
    assert.deepEqual([text(), view.cols, view.modes.synchronizedOutputMode], ['second', 30, false]);
  } finally { view.dispose(); }
});

test('a full frame sets the history row limit of its width', () => {
  const view = { options: { scrollback: 1 }, resize() {}, write(bytes, callback) { callback(); } };
  const stream = new TerminalStream(view, { current: () => true, acknowledge() {}, ready() {}, fail: e => assert.fail(e) });
  stream.push({ type: 'frame', revision: 1, full: true, size: { cols: 40, rows: 24 } });
  assert.equal(view.options.scrollback, 25000);
  // A delta frame has the same width, so it keeps the limit.
  view.options.scrollback = 1;
  stream.push({ type: 'frame', revision: 2, size: { cols: 40, rows: 24 } });
  assert.equal(view.options.scrollback, 1);
  stream.push({ type: 'frame', revision: 3, full: true, size: { cols: 120, rows: 24 } });
  assert.equal(view.options.scrollback, 10000);
});

test('reject a delta without a baseline or a second unacknowledged frame', () => {
  for (const full of [false, true]) {
    const errors = [];
    const stream = new TerminalStream({ options: {}, resize() {}, write() {} }, {
      current: () => true, acknowledge() {}, ready() {}, fail: e => errors.push(e),
    });
    stream.push({ type: 'frame', revision: 1, full, size: { cols: 80, rows: 24 } });
    if (full) stream.push({ type: 'frame', revision: 2, size: { cols: 80, rows: 24 } });
    assert.equal(errors.length, 1);
  }
});
