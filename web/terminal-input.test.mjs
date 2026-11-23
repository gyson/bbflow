import { test } from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/xterm';
import { noteEvent, onTerminalInput } from './dist/terminal-input.js';

const FOCUS_ON = '\x1b[?1004h';
const MOUSE_ON = '\x1b[?1003h\x1b[?1006h';
// The end of each frame from the server: the input modes, then the cursor position.
const frame = 'text\x1b[?1l\x1b[?66l\x1b[?9l\x1b[?1000l\x1b[?2004h\x1b[?1004h\x1b[?25h\x1b[1;5H';

const write = (view, data) => new Promise(resolve => view.write(data, resolve));
const open = options => {
  const view = new xterm.Terminal({ cols: 20, rows: 5, ...options });
  // Each entry is the text of an input, with a mark for a report.
  const sent = [];
  onTerminalInput(view, input => { sent.push((input.report ? 'report ' : '') + atob(input.data)); return true; });
  return { view, sent };
};
// during runs action while a browser event of this type is in dispatch, as a handler of
// xterm.js runs.
const during = (type, action) => {
  const target = new EventTarget();
  target.addEventListener(type, event => { noteEvent(event); action(); });
  target.dispatchEvent(new Event(type));
};
// emit makes xterm.js send data in a browser event of this type.
const emit = (view, type, data) => during(type, () => view.input(data, type !== 'focus' && type !== 'blur'));

test('real xterm.js reports the focus state each time it parses the focus mode', async () => {
  // This is the behavior of xterm.js that onTerminalInput corrects.
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
    emit(view, 'focus', '\x1b[I');
    emit(view, 'keydown', 'a');
    await write(view, frame);
    emit(view, 'blur', '\x1b[O');
    assert.deepEqual(sent, ['report \x1b[I', 'a', 'report \x1b[O']);
  } finally { view.dispose(); }
});

test('a frame parsed while input is off does not drop a later focus report', async () => {
  const { view, sent } = open({ disableStdin: true });
  try {
    await write(view, frame);
    view.options.disableStdin = false;
    emit(view, 'focus', '\x1b[I');
    assert.deepEqual(sent, ['report \x1b[I']);
  } finally { view.dispose(); }
});

test('other mode sequences do not drop a focus report', async () => {
  const { view, sent } = open();
  try {
    await write(view, FOCUS_ON);
    let parsed;
    const done = new Promise(resolve => { parsed = resolve; });
    // The report follows a sequence that does not set the focus mode, in one step.
    view.write('\x1b[?2004h', () => { emit(view, 'focus', '\x1b[I'); parsed(); });
    await done;
    assert.deepEqual(sent, ['report \x1b[I']);
  } finally { view.dispose(); }
});

test('a paste or a key with the bytes of a report is not a report', async () => {
  const { view, sent } = open();
  try {
    await write(view, FOCUS_ON + MOUSE_ON);
    for (const type of ['paste', 'keydown', 'input', 'compositionend']) {
      emit(view, type, '\x1b[I');
      emit(view, type, '\x1b[<0;3;2M');
    }
    assert.deepEqual(sent, Array(4).fill(['\x1b[I', '\x1b[<0;3;2M']).flat());
  } finally { view.dispose(); }
});

test('data after a report event is not a report', async () => {
  const { view, sent } = open();
  try {
    await write(view, FOCUS_ON + MOUSE_ON);
    // xterm.js sends composed text from a timer. A pointer move can come first.
    during('compositionend', () => {});
    during('mousemove', () => {});
    view.input('\x1b[<0;81;2M');
    during('focus', () => {});
    view.input('\x1b[I', false);
    assert.deepEqual(sent, ['\x1b[<0;81;2M', '\x1b[I']);
  } finally { view.dispose(); }
});

test('a report after an inner event is a report of the outer event', async () => {
  const { view, sent } = open();
  try {
    await write(view, FOCUS_ON + MOUSE_ON);
    // The mouse handler of xterm.js gives the focus to the terminal, then reports.
    during('mousedown', () => {
      emit(view, 'focus', '\x1b[I');
      view.input('\x1b[<0;3;2M', false);
    });
    // A key handler that moves the focus does not make its data a report.
    during('keydown', () => {
      during('blur', () => {});
      view.input('\x1b[<0;3;2M');
    });
    assert.deepEqual(sent, ['report \x1b[I', 'report \x1b[<0;3;2M', '\x1b[<0;3;2M']);
  } finally { view.dispose(); }
});

test('a mouse report is a report in each encoding, and only while its mode is on', async () => {
  const { view, sent } = open();
  try {
    // Without the modes, the same bytes in a mouse event are not a report.
    emit(view, 'mousedown', '\x1b[<0;3;2M');
    emit(view, 'focus', '\x1b[I');
    await write(view, FOCUS_ON + MOUSE_ON);
    emit(view, 'mousedown', '\x1b[<0;3;2M');
    emit(view, 'mouseup', '\x1b[<0;3;2m');
    emit(view, 'mousemove', '\x1b[<35;4;2M');
    emit(view, 'wheel', '\x1b[<64;4;2M');
    // Other data in a mouse event is not a report, such as the arrow keys of a wheel.
    emit(view, 'wheel', '\x1b[A');
    emit(view, 'mousedown', '\x1b[<0;3;2Mx');
    // xterm.js sends a mouse report in the default encoding as binary data. Its public
    // API cannot emit binary data without a browser.
    during('mousedown', () => view._core.coreService.triggerBinaryEvent('\x1b[M\x20\x23\xa2'));
    view._core.coreService.triggerBinaryEvent('\x1b[M\x20\x23\xa2');
    assert.deepEqual(sent, [
      '\x1b[<0;3;2M', '\x1b[I',
      'report \x1b[<0;3;2M', 'report \x1b[<0;3;2m', 'report \x1b[<35;4;2M', 'report \x1b[<64;4;2M',
      '\x1b[A', '\x1b[<0;3;2Mx', 'report \x1b[M\x20\x23\xa2', '\x1b[M\x20\x23\xa2',
    ]);
  } finally { view.dispose(); }
});

test('input stops when a send fails', async () => {
  const view = new xterm.Terminal({ cols: 20, rows: 5 });
  let sends = 0;
  onTerminalInput(view, () => { sends++; return false; });
  try {
    emit(view, 'paste', 'x'.repeat(40000));
    assert.equal(sends, 1);
  } finally { view.dispose(); }
});
