import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebaseDraft, sameSettings, savePayload } from './dist/settings-model.js';

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

test('a held tool keeps its saved version and other changes save', () => {
  const tools = structuredClone(saved.tools);
  tools[1].continueCommand = 'other';
  const payload = savePayload(draft({ appearance: 'dark', tools }), saved, new Set(['b']));
  assert.equal(payload.tools[1].continueCommand, 'other {prompt}');
  assert.equal(payload.appearance, 'dark');
});

test('a rebase keeps page changes and takes other values from the latest settings', () => {
  const tools = [...structuredClone(saved.tools), { id: 'c', name: 'New', command: '' }];
  tools[0].command = 'agent --edited';
  const page = draft({ appearance: 'dark', tools });
  const latest = { ...structuredClone(saved), revision: 5, base: 'main', tools: [...structuredClone(saved.tools), { id: 'd', name: 'Theirs', command: 'theirs' }] };
  latest.tools[1].command = 'other --theirs';
  const result = rebaseDraft(page, saved, latest);
  assert.equal(result.revision, 5);
  assert.equal(result.appearance, 'dark');
  assert.equal(result.base, 'main');
  assert.deepEqual(result.tools.map(tool => [tool.id, tool.command]), [['a', 'agent --edited'], ['b', 'other --theirs'], ['d', 'theirs'], ['c', '']]);
});

test('a rebase keeps page removals, page order, and edits to tools that latest removed', () => {
  const page = draft({ tools: [structuredClone(saved.tools[1]), structuredClone(saved.tools[0])] });
  page.tools[1].command = 'agent --edited';
  const latest = { ...structuredClone(saved), revision: 5, tools: [{ id: 'd', name: 'Theirs', command: 'theirs' }, structuredClone(saved.tools[1])] };
  assert.deepEqual(rebaseDraft(page, saved, latest).tools.map(tool => tool.id), ['d', 'b', 'a']);
  const removed = draft({ tools: [structuredClone(saved.tools[1])], defaultTool: '' });
  const result = rebaseDraft(removed, saved, { ...structuredClone(saved), revision: 5, appearance: 'light' });
  assert.deepEqual(result.tools.map(tool => tool.id), ['b']);
  assert.equal(result.defaultTool, '');
  assert.equal(result.appearance, 'light');
});

test('a rebase applies tool edits field by field', () => {
  const page = draft({});
  page.tools[0].name = 'Renamed';
  const latest = { ...structuredClone(saved), revision: 5 };
  latest.tools[0].command = 'agent --new';
  latest.tools[1].continueCommand = 'other --theirs {prompt}';
  page.tools[1].command = 'other --mine';
  const result = rebaseDraft(page, saved, latest);
  assert.deepEqual(result.tools[0], { id: 'a', name: 'Renamed', command: 'agent --new' });
  assert.deepEqual(result.tools[1], { id: 'b', name: 'Other', command: 'other --mine', continueCommand: 'other --theirs {prompt}' });
});
