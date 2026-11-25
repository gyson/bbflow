import type { Terminal } from '@xterm/xterm';
import { decodeBytes } from './protocol.js';
import type { ServerMessage } from './protocol.js';
import { scrollbackRows } from './terminal-size.js';

export type Display = Pick<Terminal, 'write' | 'resize' | 'options'>;

const ascii = (text: string) => Uint8Array.from(text, char => char.charCodeAt(0));
// An erase of the history rows, a hidden cursor, and a move of the cursor to the last
// row.
const prepare = ascii('\x1b[3J\x1b[?25l\x1b[999;1H');
// A full reset (RIS).
const reset = ascii('\x1bc');

// Frames contain cells rendered by the server. They exclude raw application escape
// sequences. Only one frame is outstanding. Acknowledge it after asynchronous xterm
// parsing finishes.
//
// xterm.js parses each write in a later task, and the browser can paint between tasks.
// A reset empties the rows of the view at once. Thus a full frame changes the view in
// two writes:
//
// 1. The first write erases the history rows and moves the cursor to the last row. The
//    screen stays. The resize then has no history rows to reflow. A lower view keeps the
//    bottom rows of the screen, as the server crops a lower view.
// 2. The callback of the first write sets the frame size. Then it writes the frame data
//    after a reset. xterm.js parses one write in one task, so the browser paints the
//    rows of the frame after the reset.
//
// No write waits during the resize, because a resize can parse the waiting writes first.
// A frame that push started always reaches the view, also after stop. Thus the view keeps
// a complete frame while it is offline. Only a current stream acknowledges a frame.
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
      this.view.write(message.full ? prepare : new Uint8Array(), () => this.render(message));
    } catch (error) {
      this.fail(error);
    }
  }

  private render(message: Extract<ServerMessage, { type: 'frame' }>): void {
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
      this.view.write(message.full ? concat(reset, data) : data, () => {
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
    if (this.stopped) return;
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
