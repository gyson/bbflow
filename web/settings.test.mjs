import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeToolEdit, sameSettings, titleControls } from './dist/settings-model.js';

const agent = { id: 'a', name: 'Agent', command: 'agent' };
const other = { id: 'b', name: 'Other', command: 'other' };
const settings = { revision: 4, appearance: 'system', defaultTool: 'a', worktree: false, base: 'HEAD', tools: [agent, other] };

test('an unchanged tool or defaults do not need another save', () => {
  assert.ok(sameSettings(settings, { ...structuredClone(settings), revision: 5 }));
  assert.ok(!sameSettings(settings, { ...settings, tools: [other, agent] }));
  assert.ok(!sameSettings(settings, { ...settings, defaultTool: '' }));
});

test('a saved edit applies its changed fields to the latest tool', () => {
  const renamed = { ...agent, name: 'Renamed' };
  const latest = { ...agent, command: 'agent --new' };
  assert.deepEqual(mergeToolEdit([other, latest], renamed, agent), [
    other,
    { id: 'a', name: 'Renamed', command: 'agent --new' },
  ]);
  assert.throws(() => mergeToolEdit([other], renamed, agent), /removed/);
});

test('adding the same tool twice keeps one copy', () => {
  const tools = mergeToolEdit([other], agent);
  assert.deepEqual(tools, [other, agent]);
  assert.deepEqual(mergeToolEdit(tools, agent), tools);
});

test('a running title test keeps Test and the tool list disabled', () => {
  const tools = [{ id: 'claude', name: 'Claude', command: 'claude -p' }];
  assert.deepEqual(titleControls(tools, 'claude', false), { command: 'claude -p', test: true, select: true });
  // A save of another setting renders again during the test. Test stays disabled.
  assert.deepEqual(titleControls(tools, 'claude', true), { command: 'claude -p', test: false, select: false });
  assert.deepEqual(titleControls(tools, 'none', false), { command: '', test: false, select: true });
});

test('a title tool change needs a save', () => {
  const titled = { ...settings, titleTool: 'none' };
  assert.ok(!sameSettings(titled, { ...titled, titleTool: 'codex' }));
});
