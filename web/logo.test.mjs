import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const attribute = (svg, name) => svg.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const shape = (svg) => ({ viewBox: attribute(svg, 'viewBox'), path: attribute(svg, 'd'), rule: attribute(svg, 'clip-rule') });
const bands = (svg) => [...svg.matchAll(/<rect\b[^>]*>/g)].map(([rect]) => ({
  y: Number(attribute(rect, 'y')), height: Number(attribute(rect, 'height')), width: Number(attribute(rect, 'width')),
  fill: attribute(rect, 'fill'),
}));
// The style element holds only the dark-appearance band colors.
const darkFills = (svg) => {
  const style = svg.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  assert.match(style, /^\s*@media \(prefers-color-scheme: dark\) \{/);
  return [...style.matchAll(/\.band(\d) \{ fill: (#[0-9a-f]{6}) \}/g)].map(([, n, fill]) => [Number(n), fill]);
};

test('the logo has six rainbow bands on whole pixel rows', async () => {
  const logo = await read('src/bbflow.svg');
  assert.deepEqual(shape(logo).viewBox, '0 0 16 16');
  assert.equal(shape(logo).rule, 'evenodd');
  assert.ok(!logo.includes('currentColor'));
  const rows = bands(logo);
  assert.deepEqual(rows.map(({ y, height, width }) => [y, height, width]), [2, 4, 6, 8, 10, 12].map((y) => [y, 2, 16]));
  assert.deepEqual(darkFills(logo).map(([n]) => n), [1, 2, 3, 4, 5, 6]);
});

// GitHub shows the README logo with <img> and selects a <picture> source from its own
// theme, so the README uses fixed-color copies of the light and dark logo.
test('the README logos keep the shape and colors of the main logo', async () => {
  const logo = await read('src/bbflow.svg');
  const light = bands(logo).map(({ fill }) => fill);
  const dark = darkFills(logo).map(([, fill]) => fill);
  for (const [name, fills] of [['light', light], ['dark', dark]]) {
    const copy = await read(`../docs/images/bbflow-${name}.svg`);
    assert.deepEqual(shape(copy), shape(logo), `docs/images/bbflow-${name}.svg shape`);
    assert.deepEqual(bands(copy).map(({ y, height, width }) => [y, height, width]), bands(logo).map(({ y, height, width }) => [y, height, width]));
    assert.deepEqual(bands(copy).map(({ fill }) => fill), fills, `docs/images/bbflow-${name}.svg colors`);
  }
});
