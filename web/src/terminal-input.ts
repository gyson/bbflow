import type { Terminal } from '@xterm/xterm';

type View = Pick<Terminal, 'parser' | 'onData'>;

// xterm.js reports the focus state each time it parses the sequence that turns focus
// reporting on (`CSI ? 1004 h`). Each frame from the server contains that sequence
// while the application uses focus reporting. Such a report is not a focus change. As
// input, it would make this view the size owner after each frame.
//
// onUserData calls send with the data that xterm.js emits, except for the focus report
// of a parsed mode sequence. The report of a real focus change still reaches send.
export function onUserData(view: View, send: (data: string) => void): void {
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
    if (modeParsed && (data === '\x1b[I' || data === '\x1b[O')) return;
    send(data);
  });
}
