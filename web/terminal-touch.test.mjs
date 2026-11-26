import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSample, clipDrag, dragAxis, glide, releaseSpeed, rowSteps, touchScroll } from './dist/terminal-touch.js';

test('a drag scrolls by the whole rows that the finger passes', () => {
  // A cell of 21 pixels, as on a phone.
  assert.deepEqual(rowSteps(0, 163, 21), { rows: 7, rest: 16 });
  assert.deepEqual(rowSteps(0, -50, 21), { rows: -2, rest: -8 });
  assert.deepEqual(rowSteps(0, 20, 21), { rows: 0, rest: 20 });
});

test('a drag keeps the rest of a movement for the next movement', () => {
  let rest = 0, rows = 0;
  for (let step = 0; step < 21; step++) {
    const next = rowSteps(rest, 5, 21);
    rows += next.rows;
    rest = next.rest;
  }
  assert.equal(rows, 5);
  assert.equal(rest, 0);
  // A change of the direction uses the rest first.
  assert.deepEqual(rowSteps(16, -20, 21), { rows: 0, rest: -4 });
});

test('a drag does not scroll a terminal without a cell height', () => {
  assert.deepEqual(rowSteps(4, 100, 0), { rows: 0, rest: 0 });
  assert.deepEqual(rowSteps(4, 100, NaN), { rows: 0, rest: 0 });
});

test('the release speed uses the last 100 milliseconds of the drag', () => {
  let samples = [];
  for (const [time, y] of [[0, 0], [50, 10], [200, 100], [250, 200], [300, 300]]) samples = addSample(samples, { time, y });
  assert.deepEqual(samples.map(sample => sample.time), [200, 250, 300]);
  assert.equal(releaseSpeed(samples, 310), 2);
  assert.equal(releaseSpeed(samples.map(sample => ({ time: sample.time, y: -sample.y })), 310), -2);
});

test('a slow finger and a finger that rested start no glide', () => {
  assert.equal(releaseSpeed([{ time: 0, y: 0 }, { time: 100, y: 4 }], 100), 0);
  assert.equal(releaseSpeed([{ time: 0, y: 0 }, { time: 50, y: 100 }], 111), 0);
  assert.equal(releaseSpeed([{ time: 0, y: 0 }], 10), 0);
  assert.equal(releaseSpeed([], 10), 0);
});

test('a glide gets slower and ends', () => {
  const first = glide(2, 16);
  assert.ok(first.distance > 31 && first.distance < 32, `distance ${first.distance}`);
  assert.ok(first.speed > 1.9 && first.speed < 2, `speed ${first.speed}`);
  assert.deepEqual(glide(0.051, 16), { distance: glide(0.051, 16).distance, speed: 0 });
  let speed = -2, distance = 0, frames = 0;
  while (speed) {
    const next = glide(speed, 16);
    distance += next.distance;
    speed = next.speed;
    frames++;
  }
  // The whole distance is near the speed divided by the rate of the loss.
  assert.ok(distance < -950 && distance > -1000, `distance ${distance}`);
  assert.ok(frames > 100 && frames < 130, `frames ${frames}`);
});

test('a drag has no direction before the finger moved 8 pixels', () => {
  assert.equal(dragAxis(0, 0), undefined);
  assert.equal(dragAxis(7, -7), undefined);
  assert.equal(dragAxis(0, 8), 'y');
  assert.equal(dragAxis(0, -8), 'y');
  assert.equal(dragAxis(8, 0), 'x');
});

test('a horizontal swipe with a vertical drift is not a vertical drag', () => {
  // A swipe of 240 pixels sideways and 36 pixels down, in steps.
  for (let step = 1; step <= 24; step++) {
    assert.notEqual(dragAxis(10 * step, 1.5 * step), 'y', `step ${step}`);
  }
  assert.equal(dragAxis(-240, 36), 'x');
  // A drag with the same movement on both axes is not vertical.
  assert.equal(dragAxis(20, 20), 'x');
  assert.equal(dragAxis(12, 30), 'y');
});

test('a drag first moves the shown part of a lower view', () => {
  // The view shows the last rows: position 333 of 333.
  assert.deepEqual(clipDrag(333, 333, 75), { top: 258, distance: 0 });
  assert.deepEqual(clipDrag(100, 333, -50), { top: 150, distance: 0 });
});

test('a movement across the end of the shown part keeps the distance that is left', () => {
  assert.deepEqual(clipDrag(258, 333, 400), { top: 0, distance: 142 });
  assert.deepEqual(clipDrag(300, 333, -50), { top: 333, distance: -17 });
  // Four pixels to the first row, then four history rows of 16 pixels and a rest.
  const down = clipDrag(4, 333, 75);
  assert.deepEqual(down, { top: 0, distance: 71 });
  assert.deepEqual(rowSteps(0, down.distance, 16), { rows: 4, rest: 7 });
  const up = clipDrag(329, 333, -75);
  assert.deepEqual(up, { top: 333, distance: -71 });
  assert.deepEqual(rowSteps(0, up.distance, 16), { rows: -4, rest: -7 });
});

test('a drag scrolls the history when the view is at its end in that direction', () => {
  assert.deepEqual(clipDrag(0, 333, 75), { top: 0, distance: 75 });
  assert.deepEqual(clipDrag(333, 333, -75), { top: 333, distance: -75 });
  // A view that shows all rows has no other position.
  assert.deepEqual(clipDrag(0, 0, 75), { top: 0, distance: 75 });
  assert.deepEqual(clipDrag(0, -12, -75), { top: 0, distance: -75 });
  // The page reads a rounded position.
  assert.deepEqual(clipDrag(333, 333.4, -75), { top: 333, distance: -75 });
  assert.deepEqual(clipDrag(0, 333.4, 0), { top: 0, distance: 0 });
});

// A terminal of 30 rows with cells of 16 pixels, in a view of 147 pixels. The view
// shows a part of the rows, as with an on-screen keyboard.
class FakeElement {
  isConnected = true;
  wheels = [];
  closest(selector) { return selector === '.xterm' ? this : null; }
  dispatchEvent(event) { this.wheels.push(event.deltaY); return true; }
}

function fixture(scrollTop, mode = 'none') {
  const listeners = {};
  const options = {};
  const frames = [];
  globalThis.Element = FakeElement;
  globalThis.WheelEvent = class { static DOM_DELTA_LINE = 1; constructor(type, init) { Object.assign(this, init); } };
  globalThis.requestAnimationFrame = callback => frames.push(callback);
  globalThis.cancelAnimationFrame = id => { frames[id - 1] = null; };
  const target = new FakeElement();
  const container = {
    scrollTop, scrollHeight: 480, clientHeight: 147,
    querySelector: () => ({ clientHeight: 480 }),
    addEventListener: (type, listener, option) => { listeners[type] = listener; options[type] = option; },
  };
  const terminal = { rows: 30, lines: 0, modes: { mouseTrackingMode: mode }, scrollLines(count) { this.lines += count; } };
  const stop = touchScroll(container, () => terminal);
  // The touch events and the frames use one clock, as in a browser.
  let time = 0;
  performance.now = () => time;
  // Send a touch event and return it. A touch cancel cannot be canceled.
  const touch = (type, x, y, wait = 16) => {
    time += wait;
    const point = { identifier: 1, clientX: x, clientY: y };
    const event = {
      type, target, timeStamp: time, touches: type === 'touchend' || type === 'touchcancel' ? [] : [point],
      cancelable: type !== 'touchcancel', defaultPrevented: false,
      preventDefault() { if (this.cancelable) this.defaultPrevented = true; },
    };
    listeners[type](event);
    return event;
  };
  // Run the frame that the glide asked for last. Return false when no frame waits.
  const frame = elapsed => {
    const callback = frames.at(-1);
    if (!callback) return false;
    frames.push(null);
    time += elapsed;
    callback(time);
    return true;
  };
  return { container, terminal, target, stop, touch, frame, options };
}

test('a movement across the first shown row scrolls the history with the distance that is left', () => {
  const { container, terminal, touch } = fixture(4);
  touch('touchstart', 100, 100);
  touch('touchmove', 100, 175);
  assert.equal(container.scrollTop, 0);
  assert.equal(terminal.lines, -4);
  // The rest of 7 pixels and 9 more pixels are one row.
  touch('touchmove', 100, 184);
  assert.equal(terminal.lines, -5);
});

test('a movement across the last shown row scrolls the history with the distance that is left', () => {
  const { container, terminal, touch } = fixture(329);
  touch('touchstart', 100, 200);
  touch('touchmove', 100, 125);
  assert.equal(container.scrollTop, 333);
  assert.equal(terminal.lines, 4);
});

test('a movement across the end of the shown part sends the wheel reports of the distance that is left', () => {
  const { container, terminal, target, touch } = fixture(4, 'vt200');
  touch('touchstart', 100, 100);
  touch('touchmove', 100, 175);
  assert.equal(container.scrollTop, 0);
  assert.equal(terminal.lines, 0);
  assert.deepEqual(target.wheels, [-1, -1, -1, -1]);
});

test('a horizontal swipe with a vertical drift moves nothing', () => {
  const { container, terminal, target, touch, frame } = fixture(200);
  touch('touchstart', 100, 100);
  for (let step = 1; step <= 24; step++) touch('touchmove', 100 + 10 * step, 100 + 1.5 * step);
  // A horizontal drag keeps its browser behavior.
  assert.equal(touch('touchend', 340, 136).defaultPrevented, false);
  assert.equal(frame(16), false);
  assert.equal(container.scrollTop, 200);
  assert.equal(terminal.lines, 0);
  assert.deepEqual(target.wheels, []);
});

test('a fast release glides, and the stop function ends the glide', () => {
  const { container, touch, frame, stop } = fixture(333);
  touch('touchstart', 100, 100);
  touch('touchmove', 100, 130);
  touch('touchmove', 100, 160);
  touch('touchend', 100, 160);
  assert.equal(container.scrollTop, 273);
  assert.equal(frame(16), true);
  const glided = container.scrollTop;
  assert.ok(glided < 273, `position ${glided}`);
  // Typed input shows the cursor row and stops the glide.
  stop();
  container.scrollTop = 333;
  assert.equal(frame(16), false);
  assert.equal(container.scrollTop, 333);
});

test('a touch stops a glide', () => {
  const { container, touch, frame } = fixture(333);
  touch('touchstart', 100, 100);
  touch('touchmove', 100, 160);
  touch('touchend', 100, 160);
  assert.equal(frame(16), true);
  const glided = container.scrollTop;
  touch('touchstart', 100, 100);
  assert.equal(frame(16), false);
  assert.equal(container.scrollTop, glided);
});

// The browser follows a touch that it takes as a tap with a click. A click in xterm.js
// focuses the terminal input, and a phone then shows its keyboard.
test('a vertical drag cancels the end of its touch, so that no click follows', () => {
  const { touch, options } = fixture(333);
  assert.equal(options.touchend.passive, false);
  touch('touchstart', 100, 100);
  // A slow drag of 30 pixels starts no glide.
  touch('touchmove', 100, 115, 100);
  touch('touchmove', 100, 130, 100);
  assert.equal(touch('touchend', 100, 130, 100).defaultPrevented, true);
});

test('a short drag that scrolls no row is not a tap either', () => {
  const { container, terminal, touch } = fixture(0);
  touch('touchstart', 100, 100);
  touch('touchmove', 100, 109);
  assert.equal(touch('touchend', 100, 109).defaultPrevented, true);
  assert.equal(container.scrollTop, 0);
  assert.equal(terminal.lines, 0);
});

test('a tap keeps its click, also with a movement below 8 pixels', () => {
  const { touch } = fixture(333);
  touch('touchstart', 100, 100);
  assert.equal(touch('touchend', 100, 100).defaultPrevented, false);
  touch('touchstart', 100, 100);
  touch('touchmove', 105, 105);
  assert.equal(touch('touchend', 105, 105).defaultPrevented, false);
});

test('a touch that stops a glide is not a tap', () => {
  const { touch, frame } = fixture(333);
  touch('touchstart', 100, 100);
  touch('touchmove', 100, 160);
  touch('touchend', 100, 160);
  assert.equal(frame(16), true);
  touch('touchstart', 100, 300);
  assert.equal(touch('touchend', 100, 300).defaultPrevented, true);
  assert.equal(frame(16), false);
  // The glide is over, so the next tap keeps its click.
  touch('touchstart', 100, 300);
  assert.equal(touch('touchend', 100, 300).defaultPrevented, false);
});

test('a touch that stops a glide is not a tap, also when it moves sideways', () => {
  const { container, touch, frame } = fixture(333);
  touch('touchstart', 100, 100);
  touch('touchmove', 100, 160);
  touch('touchend', 100, 160);
  assert.equal(frame(16), true);
  const glided = container.scrollTop;
  touch('touchstart', 100, 300);
  touch('touchmove', 108, 304);
  assert.equal(touch('touchend', 108, 304).defaultPrevented, true);
  // The horizontal drag does not scroll and starts no glide.
  assert.equal(container.scrollTop, glided);
  assert.equal(frame(16), false);
});

test('a glide ends in the frame that stops its speed, and a tap after it keeps its click', () => {
  const { touch, frame } = fixture(333);
  touch('touchstart', 100, 100);
  touch('touchmove', 100, 160);
  touch('touchend', 100, 160);
  // The release speed is 60 pixels in 16 milliseconds. The glide has one frame for each
  // step until its speed is 0, and no frame after that step.
  let steps = 0;
  for (let speed = 60 / 16; speed; speed = glide(speed, 16).speed) steps++;
  let frames = 0;
  while (frame(16)) frames++;
  assert.equal(frames, steps);
  touch('touchstart', 100, 300);
  assert.equal(touch('touchend', 100, 300).defaultPrevented, false);
});

test('a fast drag with mouse reports has no glide, and a tap after it keeps its click', () => {
  const { container, terminal, target, touch, frame } = fixture(0, 'vt200');
  touch('touchstart', 100, 100);
  touch('touchmove', 100, 160);
  assert.equal(touch('touchend', 100, 160).defaultPrevented, true);
  assert.equal(container.scrollTop, 0);
  assert.equal(terminal.lines, 0);
  assert.deepEqual(target.wheels, [-1, -1, -1]);
  assert.equal(frame(16), false);
  touch('touchstart', 100, 300);
  assert.equal(touch('touchend', 100, 300).defaultPrevented, false);
});

test('the handler does not cancel a touch cancel', () => {
  const { touch } = fixture(333);
  touch('touchstart', 100, 100);
  touch('touchmove', 100, 140);
  assert.equal(touch('touchcancel', 100, 140).defaultPrevented, false);
});
