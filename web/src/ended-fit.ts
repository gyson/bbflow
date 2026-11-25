import type { IMarker, Terminal } from '@xterm/xterm';

// A terminal without a process gets no more frames. Its view sets its own number of
// rows, so that the rows fill the container. The width stays, because the server
// rendered the rows at that width.
//
// xterm.js resizes from the cursor row. A lower terminal removes the rows below the
// cursor, and a taller terminal shows history rows only for a cursor on the last row.
// Thus a fit first moves the cursor to the last row with text. Then the rows below it
// go, the terminal gets the new number of rows, and the cursor goes back to its row.

type Fit = { rows: number; done: Promise<void> };

// The recorded cursor of an ended terminal. A lower terminal can move the cursor row
// into the scrollback. A later taller terminal puts the cursor on that row again.
type Cursor = { marker: IMarker; column: number };

// The fit in progress of each terminal. A later request changes its rows.
const fits = new WeakMap<Terminal, Fit>();

// The cursor of each terminal after its first fit. An ended terminal gets no more
// frames, so its buffer and this marker stay valid.
const cursors = new WeakMap<Terminal, Cursor>();

const write = (view: Terminal, data: string) => new Promise<void>(resolve => view.write(data, resolve));

// fitEndedRows gives an ended terminal this number of rows. The last row with text, or
// the cursor row when it is lower, stays the last row. A taller terminal shows the
// history rows above it. The first fit applies this rule also when the number of rows
// does not change. current tells that the page still shows this terminal.
export function fitEndedRows(view: Terminal, rows: number, current: () => boolean): Promise<void> {
  const pending = fits.get(view);
  if (pending) {
    pending.rows = rows;
    return pending.done;
  }
  const fit: Fit = { rows, done: Promise.resolve() };
  fits.set(view, fit);
  fit.done = run(view, fit, current).finally(() => fits.delete(view));
  return fit.done;
}

async function run(view: Terminal, fit: Fit, current: () => boolean): Promise<void> {
  let cursor = cursors.get(view);
  while (current() && (!cursor || fit.rows !== view.rows)) {
    // xterm.js disposes a marker when its row leaves the scrollback.
    if (!cursor || cursor.marker.isDisposed) {
      cursor = { marker: view.registerMarker(0), column: view.buffer.active.cursorX };
      cursors.set(view, cursor);
    }
    const last = lastRow(view);
    await write(view, `\x1b[${last + 1};1H`);
    if (!current()) return;
    view.resize(view.cols, last + 1);
    // xterm.js keeps at most the scrollback rows and the screen rows. A lower terminal
    // moves screen rows into the scrollback. Make room for them, so that no history row
    // goes.
    const room = view.buffer.active.length - fit.rows;
    if (room > (view.options.scrollback ?? 0)) view.options.scrollback = room;
    view.resize(view.cols, fit.rows);
    // A lower terminal can move the cursor row into the scrollback.
    const row = Math.max(0, Math.min(view.rows - 1, cursor.marker.line - view.buffer.active.baseY));
    await moveCursor(view, row, cursor.column);
  }
}

// xterm.js moves its input element to the cursor only when output moves the cursor. A
// resize moves the cursor without output. Thus the cursor first leaves a target that it
// is already on. Otherwise the input element stays below the rows and the area scrolls.
async function moveCursor(view: Terminal, row: number, column: number): Promise<void> {
  const buffer = view.buffer.active;
  if (buffer.cursorY === row && buffer.cursorX === column) await write(view, row ? '\x1b[1;1H' : '\x1b[2;1H');
  await write(view, `\x1b[${row + 1};${column + 1}H`);
}

// lastRow returns the last screen row with text, or the cursor row when it is lower. The
// server writes the cells of a background color as spaces, so a row with a background
// color counts as a row with text.
export function lastRow(view: Pick<Terminal, 'rows' | 'buffer'>): number {
  const buffer = view.buffer.active;
  for (let y = view.rows - 1; y > buffer.cursorY; y--) {
    if (buffer.getLine(buffer.baseY + y)?.translateToString(true)) return y;
  }
  return buffer.cursorY;
}
