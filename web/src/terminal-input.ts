import type { Terminal } from '@xterm/xterm';
import { encodeBytes } from './protocol.js';
import type { Control } from './protocol.js';

type View = Pick<Terminal, 'parser' | 'onData' | 'onBinary' | 'modes'>;
type Input = Extract<Control, { type: 'input' }>;

// xterm.js makes a focus report in a focus or blur event of its text area. It makes a
// mouse report in a mouse or wheel event. It sends typed keys, composed text, and a
// paste in other events. reportEvent tells whether the most recent of these events can
// make a report. Thus a paste that has the bytes of a report is not a report.
const reportEvents = ['focus', 'blur', 'mousedown', 'mouseup', 'mousemove', 'wheel'];
const userEvents = ['keydown', 'keypress', 'input', 'compositionend', 'paste', 'drop'];
let reportEvent = false;

// noteEvent records the type of a browser event before xterm.js handles the event.
export function noteEvent(type: string): void {
  reportEvent = reportEvents.includes(type);
}

if (typeof document !== 'undefined') {
  for (const type of [...reportEvents, ...userEvents]) {
    // A capture listener of the document runs before the listeners of xterm.js.
    document.addEventListener(type, () => noteEvent(type), true);
  }
}

// isReport tells whether data is one focus report or one mouse report that the modes of
// the view turn on. xterm.js emits each report alone.
function isReport(data: string, modes: Terminal['modes']): boolean {
  if (data === '\x1b[I' || data === '\x1b[O') return modes.sendFocusMode;
  return modes.mouseTrackingMode !== 'none' && /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data);
}

// onTerminalInput calls send with the `input` messages for the data that xterm.js
// emits. It stops when send returns false.
//
// It marks a focus report and a mouse report with `report`. The server does not make a
// view the size owner for a report, and it gives a mouse report the terminal cell that
// the view shows.
//
// It drops one kind of focus report. xterm.js reports the focus state each time it
// parses the sequence that turns focus reporting on (`CSI ? 1004 h`). Each frame from
// the server contains that sequence while the application uses focus reporting. Such a
// report is not a focus change. As input, it would give the application a false focus
// event after each frame. The report of a real focus change is sent.
export function onTerminalInput(view: View, send: (input: Input) => boolean): void {
  let modeParsed = false;
  view.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => {
    if (params.includes(1004) && !modeParsed) {
      modeParsed = true;
      // xterm.js emits the report in the same synchronous parse step. It emits no
      // report while input is off. Clear the mark after this step, so that the mark
      // cannot drop the report of a later focus change.
      queueMicrotask(() => { modeParsed = false; });
    }
    // The handler of xterm.js must still set the mode.
    return false;
  });
  view.onData(data => {
    const focus = data === '\x1b[I' || data === '\x1b[O';
    if (modeParsed && focus) return;
    const report = reportEvent && isReport(data, view.modes);
    const bytes = new TextEncoder().encode(data);
    for (let start = 0; start < bytes.length; start += 16384) {
      const input: Input = { type: 'input', data: encodeBytes(bytes.subarray(start, start + 16384)) };
      if (report) input.report = true;
      if (!send(input)) break;
    }
  });
  // xterm.js uses binary data only for a mouse report in the default encoding.
  view.onBinary(data => { send({ type: 'input', data: btoa(data), report: true }); });
}
