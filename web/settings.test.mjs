import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameSettings, savePayload } from './dist/settings-model.js';

const saved = {
  revision: 4, appearance: 'system', defaultTool: 'a', worktree: false, base: 'HEAD',
  tools: [{ id: 'a', name: 'Agent', command: 'agent' }, { id: 'b', name: 'Other', command: 'other', continueCommand: 'other {prompt}' }],
};
const draft = changes => ({ ...structuredClone(saved), ...changes });

test('an unchanged page does not save', () => {
  assert.ok(sameSettings(savePayload(draft({}), saved), saved));
  // The server trims names, removes a blank continue command, and selects HEAD for an empty base.
  const tools = structuredClone(saved.tools);
  tools[0].name = ' Agent '; tools[0].continueCommand = '  ';
  assert.ok(sameSettings(savePayload(draft({ base: '', tools }), saved), saved));
});

test('a new tool is saved only when it has a name and a command', () => {
  const tools = [...structuredClone(saved.tools), { id: 'c', name: 'New', command: '' }];
  const incomplete = savePayload(draft({ tools, defaultTool: 'c' }), saved);
  assert.deepEqual(incomplete.tools.map(tool => tool.id), ['a', 'b']);
  assert.equal(incomplete.defaultTool, 'a', 'an unsaved default keeps the saved default');
  assert.ok(sameSettings(incomplete, saved));
  tools[2].command = 'new';
  const complete = savePayload(draft({ tools, defaultTool: 'c' }), saved);
  assert.deepEqual(complete.tools.map(tool => tool.id), ['a', 'b', 'c']);
  assert.equal(complete.defaultTool, 'c');
  assert.equal(complete.revision, 4);
});

test('a cleared field keeps the saved tool and its position', () => {
  const tools = structuredClone(saved.tools).reverse();
  tools[1].command = '';
  const payload = savePayload(draft({ tools }), saved);
  assert.deepEqual(payload.tools.map(tool => [tool.id, tool.command]), [['b', 'other'], ['a', 'agent']]);
  assert.equal(payload.defaultTool, 'a');
});

test('removal and other changes save', () => {
  const payload = savePayload(draft({ appearance: 'dark', tools: [saved.tools[1]], defaultTool: '' }), saved);
  assert.equal(payload.appearance, 'dark');
  assert.deepEqual(payload.tools.map(tool => tool.id), ['b']);
  assert.equal(payload.defaultTool, '');
  assert.ok(!sameSettings(payload, saved));
});
