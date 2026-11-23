import { test } from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/xterm';
import { onUserData } from './dist/terminal-input.js';

const FOCUS_ON = '\x1b[?1004h';
// The end of each frame from the server: the input modes, then the cursor position.
const frame = 'text\x1b[?1l\x1b[?66l\x1b[?2004h\x1b[?1004h\x1b[?9l\x1b[?1000l\x1b[?25h\x1b[1;5H';

const write = (view, data) => new Promise(resolve => view.write(data, resolve));
const open = options => {
  const view = new xterm.Terminal({ cols: 20, rows: 5, ...options });
  const sent = [];
  onUserData(view, data => sent.push(data));
  return { view, sent };
};

test('real xterm.js reports the focus state each time it parses the focus mode', async () => {
  // This is the behavior of xterm.js that onUserData corrects.
  const view = new xterm.Terminal({ cols: 20, rows: 5 });
  const sent = [];
  view.onData(data => sent.push(data));
  try {
    await write(view, frame);
    await write(view, frame);
    assert.deepEqual(sent, ['\x1b[O', '\x1b[O']);
  } finally { view.dispose(); }
});

test('a frame that sets the focus mode sends no input', async () => {
  const { view, sent } = open();
  try {
    await write(view, frame);
    await write(view, frame);
    await write(view, '\x1b[?2004;1004h');
    assert.deepEqual(sent, []);
    assert.equal(view.modes.sendFocusMode, true);
    assert.equal(view.modes.bracketedPasteMode, true);
  } finally { view.dispose(); }
});

test('the report of a later focus change and typed data are sent', async () => {
  const { view, sent } = open();
  try {
    await write(view, frame);
    // A focus change of the terminal and a key both emit data outside the parse step.
    view.input('\x1b[I', false);
    view.input('a');
    await write(view, frame);
    view.input('\x1b[O', false);
    assert.deepEqual(sent, ['\x1b[I', 'a', '\x1b[O']);
  } finally { view.dispose(); }
});

test('a frame parsed while input is off does not drop a later focus report', async () => {
  const { view, sent } = open({ disableStdin: true });
  try {
    await write(view, frame);
    view.options.disableStdin = false;
    view.input('\x1b[I', false);
    assert.deepEqual(sent, ['\x1b[I']);
  } finally { view.dispose(); }
});

test('other mode sequences do not drop a focus report', async () => {
  const { view, sent } = open();
  try {
    await write(view, FOCUS_ON);
    let parsed;
    const done = new Promise(resolve => { parsed = resolve; });
    // The report follows a sequence that does not set the focus mode, in one step.
    view.write('\x1b[?2004h', () => { view.input('\x1b[I', false); parsed(); });
    await done;
    assert.deepEqual(sent, ['\x1b[I']);
  } finally { view.dispose(); }
});
