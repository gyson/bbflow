import type { Terminal } from '@xterm/xterm';

// While the on-screen keyboard shows, a terminal keeps its PTY size. A new size at each
// change of the keyboard would make the terminal application draw its screen again,
// and the recording keeps that output. Thus the container is lower than the terminal
// and shows a part of its rows.

// Return the scroll position of a container that is lower than its terminal. All
// values are in CSS pixels from the top of the container content. The container shows
// the last rows. When the cursor is above them, the cursor row is the last shown row.
export function clipTop(value: { cursorTop: number; cursorBottom: number; contentHeight: number; height: number }): number {
  const last = Math.max(0, value.contentHeight - value.height);
  return value.cursorTop >= last ? last : Math.max(0, Math.round(value.cursorBottom - value.height));
}

// The scroll position that showCursor gave to each container. Another position comes
// from a drag of the user.
const positions = new WeakMap<HTMLElement, number>();

// showCursor scrolls a container that is lower than its terminal to the part with the
// cursor row. It has no effect on a container that shows all rows.
export function showCursor(container: HTMLElement, view: Terminal): void {
  const screen = container.querySelector('.xterm-screen');
  if (!screen || container.scrollHeight <= container.clientHeight) return;
  const cell = screen.clientHeight / view.rows;
  const top = screen.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
  const cursorTop = top + view.buffer.active.cursorY * cell;
  container.scrollTop = clipTop({ cursorTop, cursorBottom: cursorTop + cell, contentHeight: container.scrollHeight, height: container.clientHeight });
  positions.set(container, container.scrollTop);
}

// followCursor does the work of showCursor after the cursor moved. It keeps the part
// that a drag of the user shows. Many terminal applications move the cursor all the
// time, and the user could not read other rows.
export function followCursor(container: HTMLElement, view: Terminal): void {
  const position = positions.get(container);
  if (position === undefined || Math.abs(container.scrollTop - position) < 1) showCursor(container, view);
}
