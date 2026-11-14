import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundledPackages } from './licenses.mjs';

test('bundled packages include scoped and nested packages', () => {
  const metafile = { inputs: {
    'src/app.ts': {},
    'node_modules/@codemirror/view/dist/index.js': {},
    'node_modules/@codemirror/view/dist/other.js': {},
    'node_modules/crelt/index.js': {},
    'node_modules/outer/node_modules/@scope/inner/lib/a.js': {},
  } };
  assert.deepEqual(bundledPackages(metafile, '/web'), [
    { name: '@codemirror/view', directory: '/web/node_modules/@codemirror/view' },
    { name: 'crelt', directory: '/web/node_modules/crelt' },
    { name: '@scope/inner', directory: '/web/node_modules/outer/node_modules/@scope/inner' },
  ]);
});
