import type { Terminal } from '@xterm/xterm';
import { decodeBytes } from './protocol.js';
import type { ServerMessage } from './protocol.js';
import { scrollbackRows } from './terminal-size.js';

export type Display = Pick<Terminal, 'write' | 'resize' | 'options'>;

const ascii = (text: string) => Uint8Array.from(text, char => char.charCodeAt(0));
// The start of synchronized output (DEC mode 2026), then an erase of the history rows.
const holdAndErase = ascii('\x1b[?2026h\x1b[3J');
// A full reset (RIS).
const reset = ascii('\x1bc');
// The end of synchronized output.
const release = ascii('\x1b[?2026l');

// Frames contain cells rendered by the server. They exclude raw application escape
// sequences. Only one frame is outstanding. Acknowledge it after asynchronous xterm
// parsing finishes.
//
// xterm.js parses each write in a later task, and the browser can paint between tasks.
// A reset empties the rows of the view at once, so the browser must not paint between
// the reset and the parse of the frame data. A frame thus changes the view only in
// xterm.js writes:
//
// 1. A full frame first starts synchronized output and erases the history rows. xterm.js
//    renders no rows until the release, so the view keeps the earlier screen. Without
//    history rows, the resize has no rows to reflow.
// 2. The callback of that write sets the frame size. Then it writes the frame data. For
//    a full frame, the data starts with a reset and ends with the release. xterm.js
//    parses one write in one task, so it renders the rows of the frame after the reset.
//    No write waits during the resize, because a resize can parse the waiting writes
//    first.
export class TerminalStream {
  resizing = false;
  private pending = false;
  private stopped = false;
  private revision = -1;

  constructor(private readonly view: Display, private readonly host: {
    current(): boolean;
    acknowledge(revision: number): void;
    ready(): void;
    fail(message: string): void;
  }) {}

  stop(): void { this.stopped = true; }

  push(message: ServerMessage): void {
    if (message.type !== 'frame' || this.stopped || !this.host.current()) return;
    if (this.pending || message.revision <= this.revision || (this.revision < 0 && !message.full)) {
      this.host.fail('Invalid terminal frame sequence.');
      return;
    }
    this.pending = true;
    try {
      this.view.write(message.full ? holdAndErase : new Uint8Array(), () => this.render(message));
    } catch (error) {
      this.fail(error);
    }
  }

  private render(message: Extract<ServerMessage, { type: 'frame' }>): void {
    if (this.stopped || !this.host.current()) return;
    try {
      // The server sends no more history rows than this limit for the frame width. A new
      // width always gives a full frame.
      if (message.full) this.view.options.scrollback = scrollbackRows(message.size.cols);
      this.resizing = true;
      try {
        this.view.resize(message.size.cols, message.size.rows);
      } finally {
        this.resizing = false;
      }
      const data = decodeBytes(message.data);
      this.view.write(message.full ? concat(reset, data, release) : data, () => {
        if (this.stopped || !this.host.current()) return;
        this.pending = false;
        this.revision = message.revision;
        this.host.acknowledge(message.revision);
        this.host.ready();
      });
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.stopped = true;
    this.host.fail(`Cannot render terminal: ${String(error)}`);
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
