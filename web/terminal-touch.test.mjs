import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSample, glide, releaseSpeed, rowSteps } from './dist/terminal-touch.js';

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
