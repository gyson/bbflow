import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const attribute = (svg, name) => svg.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const shape = (svg) => ({ viewBox: attribute(svg, 'viewBox'), path: attribute(svg, 'd'), rule: attribute(svg, 'fill-rule') });

// GitHub shows the README logo with <img>, where currentColor is black. The README uses
// fixed-color copies of the logo for its light and dark themes.
test('the README logos use the shape of the main logo', async () => {
  const logo = await read('src/bbflow.svg');
  assert.equal(attribute(logo, 'fill'), 'currentColor');
  assert.equal(shape(logo).viewBox, '0 0 16 16');
  for (const [name, color] of [['light', '#1f2328'], ['dark', '#f0f6fc']]) {
    const copy = await read(`../docs/images/bbflow-${name}.svg`);
    assert.deepEqual(shape(copy), shape(logo), `docs/images/bbflow-${name}.svg`);
    assert.equal(attribute(copy, 'fill'), color);
  }
});
