import type { Size } from './protocol.js';

// The server accepts 2–512 columns and 1–256 rows. A view asks for at least 20 columns
// and 5 rows. A TUI that redraws at a smaller size hard-wraps its output, and the
// recording keeps that output. When the view is smaller, the terminal scrolls in it.
const minCols = 20, maxCols = 512, minRows = 5, maxRows = 256;

// Return the PTY size that a view asks for.
export function terminalSize(value: Size): Size {
  return {
    rows: Math.max(minRows, Math.min(maxRows, value.rows)),
    cols: Math.max(minCols, Math.min(maxCols, value.cols)),
  };
}
