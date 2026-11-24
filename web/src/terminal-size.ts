import type { Size } from './protocol.js';

// The server accepts 2–512 columns and 1–256 rows. A view asks for at least 20 columns
// and 5 rows. A TUI that redraws at a smaller size hard-wraps its output, and the
// recording keeps that output. When the view is smaller, the terminal scrolls in it.
const minCols = 20, maxCols = 512, minRows = 5, maxRows = 256;

// The smallest size that a view asks for. A new terminal starts at this size, so that it
// does not overflow its area before its first fit. A scroll bar of the area would make
// that fit smaller.
export const smallestSize: Size = { rows: minRows, cols: minCols };

// Return the PTY size that a view asks for.
export function terminalSize(value: Size): Size {
  return {
    rows: Math.max(minRows, Math.min(maxRows, value.rows)),
    cols: Math.max(minCols, Math.min(maxCols, value.cols)),
  };
}

// A view keeps about 1,000,000 history cells: 10,000–50,000 rows, by width. Keep this
// function the same as ScrollbackRows in internal/terminal/state.go.
const historyCells = 1_000_000, minScrollbackRows = 10_000, maxScrollbackRows = 50_000;

// Return the number of history rows that a view of this width keeps.
export function scrollbackRows(cols: number): number {
  return Math.min(maxScrollbackRows, Math.max(minScrollbackRows, Math.floor(historyCells / cols)));
}
