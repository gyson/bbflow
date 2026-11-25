import type { Terminal } from '@xterm/xterm';
import type { Size } from './protocol.js';

// The renderer dimensions of xterm.js 6. The fit addon of xterm.js reads the same
// private object. xterm.js 6.1 makes it public as Terminal.dimensions.
type RenderDimensions = { device: { cell: { width: number; height: number } } };

// The default width of the xterm.js scroll bar.
const scrollBarWidth = 14;

// fitCount returns the largest number of cells that fit in the available CSS pixels.
// cell is the unrounded cell size in device pixels. xterm.js draws n cells in
// Math.round(cell * n / dpr) CSS pixels. Thus the drawn size of one cell depends on the
// number of cells. The fit addon divides by that drawn size. It can propose one cell more
// or fewer than the size of the next fit, and for some rows its proposals alternate
// without end. fitCount compares whole pixels, so its result does not depend on the
// current size.
export function fitCount(available: number, cell: number, dpr: number): number {
  if (!(cell > 0) || !(dpr > 0) || !Number.isFinite(available)) return 0;
  const drawn = (count: number) => Math.round(cell * count / dpr);
  let count = Math.max(0, Math.floor(available * dpr / cell));
  while (count > 0 && drawn(count) > available) count--;
  while (drawn(count + 1) <= available) count++;
  return count;
}

// fitSize returns the number of columns and rows that fit the parent element of the
// terminal. It measures the same area as FitAddon.proposeDimensions of
// @xterm/addon-fit 0.11.0. It returns undefined when the terminal or its parent has no
// size yet.
export function fitSize(view: Terminal): Size | undefined {
  const element = view.element;
  const parent = element?.parentElement;
  if (!element || !parent) return undefined;
  const core = (view as unknown as { _core?: { _renderService?: { dimensions?: RenderDimensions } } })._core;
  const cell = core?._renderService?.dimensions?.device.cell;
  const dpr = window.devicePixelRatio;
  if (!cell?.width || !cell.height) return undefined;
  const parentStyle = getComputedStyle(parent);
  const parentWidth = parseInt(parentStyle.getPropertyValue('width'), 10);
  const parentHeight = parseInt(parentStyle.getPropertyValue('height'), 10);
  if (!Number.isFinite(parentWidth) || !Number.isFinite(parentHeight)) return undefined;
  const style = getComputedStyle(element);
  const padding = (name: string) => parseInt(style.getPropertyValue(`padding-${name}`), 10) || 0;
  // The fit keeps room for the scroll bar, or for the overview ruler that replaces it.
  const scrollBar = view.options.scrollback === 0 ? 0 : (view.options.overviewRuler?.width || scrollBarWidth);
  const width = Math.max(0, parentWidth) - padding('left') - padding('right') - scrollBar;
  const height = parentHeight - padding('top') - padding('bottom');
  // xterm.js has at least 2 columns and 1 row.
  return { cols: Math.max(2, fitCount(width, cell.width, dpr)), rows: Math.max(1, fitCount(height, cell.height, dpr)) };
}
