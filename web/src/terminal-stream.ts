import type { Terminal } from '@xterm/xterm';
import { decodeBytes } from './protocol.js';
import type { ServerMessage, Size } from './protocol.js';
import { scrollbackRows } from './terminal-size.js';

export type Display = Pick<Terminal, 'write' | 'resize' | 'options' | 'parser'>;

// An erase of the history rows, then a full reset (RIS).
const eraseAndReset = Uint8Array.from('\x1b[3J\x1bc', char => char.charCodeAt(0));

// The state of a view for its full frames. sizes holds the size of each full frame that
// the view must still parse, oldest first. A view keeps this state across streams,
// because a reconnect starts a new stream while a frame of the earlier stream can wait.
interface ViewState { sizes: Size[]; resizing: boolean }
const states = new WeakMap<Display, ViewState>();

// The parser handler of the reset sets the row limit and the size of the next full
// frame. Then xterm.js does its reset, at the new size. The server sends no reset of its
// own in a frame, so each reset belongs to a full frame of this file.
function stateOf(view: Display): ViewState {
  let state = states.get(view);
  if (!state) {
    const created: ViewState = state = { sizes: [], resizing: false };
    states.set(view, created);
    view.parser.registerEscHandler({ final: 'c' }, () => {
      const size = created.sizes.shift();
      if (size) {
        view.options.scrollback = scrollbackRows(size.cols);
        created.resizing = true;
        try {
          view.resize(size.cols, size.rows);
        } finally {
          created.resizing = false;
        }
      }
      return false;
    });
  }
  return state;
}

// Frames contain cells rendered by the server. They exclude raw application escape
// sequences. Only one frame is outstanding. Acknowledge it after asynchronous xterm
// parsing finishes.
//
// xterm.js parses each write in a later task, and the browser can paint between tasks.
// A full frame is thus one write: an erase of the history rows, a reset, and the frame
// data. The handler of the reset sets the frame size. xterm.js parses one write in one
// task, so the browser paints no state between the earlier screen and the frame: not an
// empty view, and not the earlier screen at the new size. Without history rows, the
// resize has no rows to reflow. A delta frame has the size of the frame before it.
//
// The handler resizes the view during a parse. xterm.js 6.0.0 allows this. A later
// version can parse the waiting writes in resize() and parse the current write again.
// Each frame must then still get one acknowledgment, which a test checks.
//
// A received frame always reaches the view, also after stop. Thus the view keeps a
// complete frame while it is offline. Only a current stream acknowledges a frame.
export class TerminalStream {
  private pending = false;
  private stopped = false;
  private revision = -1;

  constructor(private readonly view: Display, private readonly host: {
    current(): boolean;
    acknowledge(revision: number): void;
    ready(): void;
    fail(message: string): void;
  }) {}

  // resizing tells that the view applies the size of a frame.
  get resizing(): boolean { return states.get(this.view)?.resizing ?? false; }

  stop(): void { this.stopped = true; }

  push(message: ServerMessage): void {
    if (message.type !== 'frame' || this.stopped || !this.host.current()) return;
    if (this.pending || message.revision <= this.revision || (this.revision < 0 && !message.full)) {
      this.host.fail('Invalid terminal frame sequence.');
      return;
    }
    this.pending = true;
    const sizes = message.full ? stateOf(this.view).sizes : undefined;
    try {
      const data = decodeBytes(message.data);
      sizes?.push(message.size);
      this.view.write(sizes ? concat(eraseAndReset, data) : data, () => {
        if (this.stopped || !this.host.current()) return;
        this.pending = false;
        this.revision = message.revision;
        this.host.acknowledge(message.revision);
        this.host.ready();
      });
    } catch (error) {
      // The write did not start, so its reset does not come.
      if (sizes?.at(-1) === message.size) sizes.pop();
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    this.host.fail(`Cannot render terminal: ${String(error)}`);
  }
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(first.length + second.length);
  bytes.set(first);
  bytes.set(second, first.length);
  return bytes;
}
