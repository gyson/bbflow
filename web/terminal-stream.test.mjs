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

// A fake view queues each write. parse handles the writes in order, as xterm.js does: it
// calls the handler of the reset (RIS) for a write with a reset, then the callback.
function fakeView(calls = []) {
  const queued = [];
  let reset;
  const view = {
    options: {},
    parser: { registerEscHandler(id, handler) { assert.deepEqual(id, { final: 'c' }); reset = handler; return { dispose() {} }; } },
    resize(cols, rows) { calls.push(`resize ${cols}x${rows}`); },
    write(bytes, callback) {
      const text = new TextDecoder().decode(bytes);
      calls.push(`write ${JSON.stringify(text)}`);
      queued.push([text, callback]);
    },
  };
  const parse = () => {
    while (queued.length) {
      const [text, callback] = queued.shift();
      if (text.includes('\x1bc')) assert.equal(reset(), false);
      callback();
    }
  };
  return { view, parse };
}

test('ack waits for parsing and a stale session view cannot acknowledge', () => {
  let current = true;
  const acks = [];
  const { view, parse } = fakeView();
  const stream = new TerminalStream(view, { current: () => current, acknowledge: n => acks.push(n), ready() {}, fail: e => assert.fail(e) });
  stream.push({ type: 'frame', revision: 1, full: true, size: { cols: 80, rows: 24 } });
  assert.deepEqual(acks, []);
  parse();
  assert.deepEqual(acks, [1]);
  stream.push({ type: 'frame', revision: 2, size: { cols: 80, rows: 24 } });
  current = false;
  parse();
  assert.deepEqual(acks, [1]);
});

test('a full frame is one write, and the handler of its reset sets its size', () => {
  const calls = [];
  const { view, parse } = fakeView(calls);
  const stream = new TerminalStream(view, { current: () => true, acknowledge: () => calls.push('ack'), ready() {}, fail: e => assert.fail(e) });
  stream.push({ type: 'frame', revision: 1, full: true, size: { cols: 40, rows: 10 }, data: btoa('hi') });
  // The task that receives the frame only queues the write.
  assert.deepEqual(calls, ['write "\\u001b[3J\\u001bchi"']);
  parse();
  assert.deepEqual(calls, ['write "\\u001b[3J\\u001bchi"', 'resize 40x10', 'ack']);
  // A delta frame has the size of the frame before it.
  calls.length = 0;
  stream.push({ type: 'frame', revision: 2, size: { cols: 40, rows: 10 }, data: btoa('hi') });
  parse();
  assert.deepEqual(calls, ['write "hi"', 'ack']);
  // A frame that the stream received reaches the view after a stop, with no ack.
  calls.length = 0;
  stream.push({ type: 'frame', revision: 3, full: true, size: { cols: 50, rows: 10 }, data: btoa('hi') });
  stream.stop();
  parse();
  assert.deepEqual(calls, ['write "\\u001b[3J\\u001bchi"', 'resize 50x10']);
});

test('the streams of one view share the sizes of the waiting full frames', () => {
  const calls = [];
  const { view, parse } = fakeView(calls);
  const host = { current: () => true, acknowledge() {}, ready() {}, fail: e => assert.fail(e) };
  const earlier = new TerminalStream(view, host);
  earlier.push({ type: 'frame', revision: 1, full: true, size: { cols: 40, rows: 10 } });
  // A reconnect starts a new stream before the view parses the earlier frame.
  earlier.stop();
  new TerminalStream(view, host).push({ type: 'frame', revision: 1, full: true, size: { cols: 60, rows: 20 } });
  parse();
  assert.deepEqual(calls.filter(call => call.startsWith('resize')), ['resize 40x10', 'resize 60x20']);
});

// Helpers for a real xterm.js view of 20 columns and 4 rows.
function realView() {
  const view = new xterm.Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  const screen = () => Array.from({ length: view.rows }, (_, y) => view.buffer.active.getLine(view.buffer.active.baseY + y).translateToString(true));
  const history = () => Array.from({ length: view.buffer.active.baseY }, (_, y) => view.buffer.active.getLine(y).translateToString(true));
  const frame = (revision, cols, rows, text) => ({ type: 'frame', revision, full: true, size: { cols, rows }, data: btoa(text) });
  // Ten rows go to the history. Then the screen has text only on one row, and the cursor
  // is at the top.
  const earlier = (row, text) => frame(1, 20, 4, `${Array.from({ length: 10 }, (_, i) => `h${i}\r\n`).join('')}\x1b[2J\x1b[${row};1H${text}\x1b[H`);
  return { view, screen, history, frame, earlier };
}

test('a full frame resizes the view and parses its data in one task in real xterm.js', async () => {
  const { view, screen, history, frame, earlier } = realView();
  // A slow resize makes xterm.js yield between writes, where it can. The browser could
  // paint the resized view then. A task that starts at the resize must find the frame.
  const events = [];
  const resize = view.resize.bind(view);
  view.resize = (cols, rows) => {
    resize(cols, rows);
    events.push('resize');
    setTimeout(() => events.push('next task'));
    const until = Date.now() + 15;
    while (Date.now() < until) { /* A slow layout. */ }
  };
  const acks = [];
  let parsed;
  const stream = new TerminalStream(view, {
    current: () => true, acknowledge: n => { acks.push(n); events.push('parsed'); parsed(); }, ready() {}, fail: error => assert.fail(error),
  });
  const push = message => new Promise(resolve => { parsed = resolve; stream.push(message); });
  const nextTask = () => new Promise(resolve => setTimeout(resolve, 5));
  try {
    await push(earlier(4, 'last'));
    await nextTask();
    assert.deepEqual([screen(), history().length], [['', '', '', 'last'], 7]);
    events.length = 0;
    const later = push(frame(2, 30, 2, `${Array.from({ length: 3 }, (_, i) => `n${i}\r\n`).join('')}second`));
    // At the end of the task that receives the frame, the view shows the earlier frame.
    assert.deepEqual([screen(), history().length, view.cols], [['', '', '', 'last'], 7, 20]);
    await later;
    await nextTask();
    assert.deepEqual(events, ['resize', 'parsed', 'next task']);
    assert.deepEqual([screen(), history(), view.cols], [['n2', 'second'], ['n0', 'n1'], 30]);
    // A later xterm.js could parse a write again in resize(). Each frame has one ack.
    assert.deepEqual(acks, [1, 2]);
  } finally { view.dispose(); }
});

test('a full frame that arrives before a stop reaches the view with its history', async () => {
  const { view, screen, history, frame, earlier } = realView();
  const acks = [];
  let parsed;
  const stream = new TerminalStream(view, {
    current: () => true, acknowledge: n => { acks.push(n); parsed(); }, ready() {}, fail: error => assert.fail(error),
  });
  const flush = () => new Promise(resolve => view.write('', resolve));
  try {
    await new Promise(resolve => { parsed = resolve; stream.push(earlier(4, 'last')); });
    // The connection fails just after the next frame arrives.
    stream.push(frame(2, 20, 4, `${Array.from({ length: 9 }, (_, i) => `n${i}\r\n`).join('')}new`));
    stream.stop();
    await flush();
    await flush();
    assert.deepEqual([screen().at(-1), history()[0], history().length, acks], ['new', 'n0', 6, [1]]);
  } finally { view.dispose(); }
});

test('a full frame sets the history row limit of its width', () => {
  const { view, parse } = fakeView();
  view.options.scrollback = 1;
  const stream = new TerminalStream(view, { current: () => true, acknowledge() {}, ready() {}, fail: e => assert.fail(e) });
  stream.push({ type: 'frame', revision: 1, full: true, size: { cols: 40, rows: 24 } });
  parse();
  assert.equal(view.options.scrollback, 25000);
  // A delta frame has the same width, so it keeps the limit.
  view.options.scrollback = 1;
  stream.push({ type: 'frame', revision: 2, size: { cols: 40, rows: 24 } });
  parse();
  assert.equal(view.options.scrollback, 1);
  stream.push({ type: 'frame', revision: 3, full: true, size: { cols: 120, rows: 24 } });
  parse();
  assert.equal(view.options.scrollback, 10000);
});

test('reject a delta without a baseline or a second unacknowledged frame', () => {
  for (const full of [false, true]) {
    const errors = [];
    const stream = new TerminalStream(fakeView().view, {
      current: () => true, acknowledge() {}, ready() {}, fail: e => errors.push(e),
    });
    stream.push({ type: 'frame', revision: 1, full, size: { cols: 80, rows: 24 } });
    if (full) stream.push({ type: 'frame', revision: 2, size: { cols: 80, rows: 24 } });
    assert.equal(errors.length, 1);
  }
});
