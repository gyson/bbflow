import type { Terminal } from '@xterm/xterm';

// xterm.js scrolls on a wheel event and on a drag of its scroll bar. It does not scroll
// on a finger drag. touchScroll makes a vertical finger drag scroll the terminal by the
// rows that the finger passes, and continue with a glide after a fast release.

// A finger must move this distance before its drag has a direction, in CSS pixels.
const slop = 8;

// Return the direction of a drag from its movement since the touch started: 'y' for a
// vertical drag and 'x' for a horizontal drag. A movement shorter than the slop has no
// direction yet. A drag keeps its first direction.
export function dragAxis(dx: number, dy: number): 'x' | 'y' | undefined {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < slop) return undefined;
  return Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
}

// A view can be lower than its terminal and show a part of the rows. Return the scroll
// position of such a view after a finger movement, and the distance that the view did
// not use. top is the position now, and max is the last position. A finger that moves
// down shows earlier rows. At the end of the view in that direction, the position stays
// and the drag scrolls the history with the distance that is left.
export function clipDrag(top: number, max: number, distance: number): { top: number; distance: number } {
  const next = Math.max(0, Math.min(max, top - distance));
  // The browser can round the position that the page reads.
  if (Math.abs(next - top) < 1) return { top, distance };
  return { top: next, distance: distance - (top - next) };
}

// A sample of a finger position: the time in milliseconds and the vertical position in
// CSS pixels.
export interface Sample { time: number; y: number; }

// The speed of a glide becomes this part of its value in each millisecond. This is the
// rate of a regular scroll view on iOS.
const decay = 0.998;
// A glide starts and continues above this speed, in pixels for each millisecond.
const minSpeed = 0.05;
// The release speed uses the samples of this time before the release, in milliseconds.
const sampleTime = 100;
// A finger that rested for this time before the release starts no glide.
const restTime = 60;

// Return the samples that the release speed can use, with the new sample last.
export function addSample(samples: Sample[], sample: Sample): Sample[] {
  return [...samples.filter(item => sample.time - item.time <= sampleTime), sample];
}

// Return the speed of the finger at its release, in pixels for each millisecond. A
// positive speed moves down. A slow or rested finger gives 0.
export function releaseSpeed(samples: Sample[], time: number): number {
  const recent = samples.filter(item => time - item.time <= sampleTime);
  const first = recent[0], last = recent.at(-1);
  if (!first || !last || last.time === first.time || time - last.time > restTime) return 0;
  const speed = (last.y - first.y) / (last.time - first.time);
  return Math.abs(speed) < minSpeed ? 0 : speed;
}

// Return the distance of a glide in the elapsed milliseconds, and its speed after
// them. The speed is 0 when the glide ends.
export function glide(speed: number, elapsed: number): { distance: number; speed: number } {
  const factor = Math.pow(decay, elapsed);
  const next = speed * factor;
  return { distance: speed * (factor - 1) / Math.log(decay), speed: Math.abs(next) < minSpeed ? 0 : next };
}

// Return the whole rows in a drag distance, and the rest of the distance for the next
// movement. rest is the rest of the earlier movements. All distances are in CSS pixels.
// A positive distance moves down.
export function rowSteps(rest: number, distance: number, cell: number): { rows: number; rest: number } {
  if (!(cell > 0)) return { rows: 0, rest: 0 };
  const total = rest + distance;
  // Give 0 and not -0 for a small upward movement.
  const rows = Math.trunc(total / cell) || 0;
  return { rows, rest: total - rows * cell };
}

// touchScroll makes a one-finger vertical drag in container scroll the terminal in it.
// view returns the terminal that the container shows. The container keeps its place
// across terminals, so one call is sufficient. The style sheet stops the vertical pan of
// the browser in the terminal. A horizontal drag does nothing here. The returned
// function stops a glide. Call it when typed input shows the cursor row, so that the
// glide does not move the view again.
//
// A container that is lower than its terminal shows a part of the rows. A drag first
// moves that part. At its end, the drag continues with the distance that is left, as
// follows.
//
// A drag scrolls the history rows of the view. The frames of the server draw an
// alternate screen on the screen rows of the normal buffer, so a view always has its
// history. When the terminal application asked for mouse reports, a drag has the
// effect of a mouse wheel in xterm.js. xterm.js then sends one wheel report for each
// row. Such a drag has no glide, so that the application gets reports only for the
// rows that the finger passes.
export function touchScroll(container: HTMLElement, view: () => Terminal | null): () => void {
  let drag: { id: number; target: Element; x: number; y: number; vertical: boolean; rest: number; samples: Sample[] } | null = null;
  let frame = 0;

  // The mouse wheel of a terminal scrolls its history when no mouse reports are on.
  const scrollsHistory = (terminal: Terminal) => terminal.modes.mouseTrackingMode === 'none';

  // Scroll by a finger movement. A finger that moves down shows earlier rows. Return
  // the rest of the distance.
  const scroll = (target: Element, x: number, y: number, rest: number, distance: number): number => {
    const terminal = view();
    const screen = container.querySelector('.xterm-screen');
    if (!terminal || !screen) return 0;
    const shown = clipDrag(container.scrollTop, container.scrollHeight - container.clientHeight, distance);
    if (shown.top !== container.scrollTop) container.scrollTop = shown.top;
    const step = rowSteps(rest, shown.distance, screen.clientHeight / terminal.rows);
    if (!step.rows) return step.rest;
    if (scrollsHistory(terminal)) {
      terminal.scrollLines(-step.rows);
    } else {
      // xterm.js handles each wheel event of one line as one row.
      const deltaY = step.rows > 0 ? -1 : 1;
      for (let row = 0; row < Math.abs(step.rows); row++) {
        target.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode: WheelEvent.DOM_DELTA_LINE, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      }
    }
    return step.rest;
  };
  const stopGlide = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const find = (touches: TouchList) => [...touches].find(touch => touch.identifier === drag?.id);

  container.addEventListener('touchstart', event => {
    stopGlide();
    const touch = event.touches[0];
    const target = event.target;
    // The scroll bar of xterm.js handles its own drag. A second finger is a pinch.
    if (event.touches.length !== 1 || !touch || !(target instanceof Element) || !target.closest('.xterm') || target.closest('.scrollbar')) {
      drag = null;
      return;
    }
    drag = { id: touch.identifier, target, x: touch.clientX, y: touch.clientY, vertical: false, rest: 0, samples: [{ time: event.timeStamp, y: touch.clientY }] };
  }, { passive: true });

  container.addEventListener('touchmove', event => {
    const touch = find(event.touches);
    if (!drag || !touch || event.touches.length !== 1) return;
    if (!drag.vertical) {
      // The first movement of the drag follows when the drag has its direction.
      const axis = dragAxis(touch.clientX - drag.x, touch.clientY - drag.y);
      if (axis === 'x') drag = null;
      if (axis !== 'y' || !drag) return;
      drag.vertical = true;
    }
    drag.rest = scroll(drag.target, drag.x, touch.clientY, drag.rest, touch.clientY - drag.y);
    drag.y = touch.clientY;
    drag.samples = addSample(drag.samples, { time: event.timeStamp, y: touch.clientY });
  }, { passive: true });

  const end = (event: TouchEvent) => {
    const current = drag;
    if (!current || find(event.touches)) return;
    drag = null;
    if (!current.vertical) return;
    let speed = event.type === 'touchend' ? releaseSpeed(current.samples, event.timeStamp) : 0;
    let time = performance.now();
    let rest = current.rest;
    const step = (now: number) => {
      // The terminal can go away during a glide, when the page shows another session.
      const terminal = view();
      if (!speed || !terminal || !scrollsHistory(terminal) || !current.target.isConnected) { frame = 0; return; }
      const next = glide(speed, now - time);
      rest = scroll(current.target, current.x, current.y, rest, next.distance);
      speed = next.speed;
      time = now;
      frame = requestAnimationFrame(step);
    };
    if (speed) frame = requestAnimationFrame(step);
  };
  container.addEventListener('touchend', end, { passive: true });
  container.addEventListener('touchcancel', end, { passive: true });
  return stopGlide;
}
