import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeToolEdit, parsePort, portStatus, portText, sameSettings, titleControls } from './dist/settings-model.js';

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

test('an update check change needs a save', () => {
  const checked = { ...settings, updateCheck: true };
  assert.ok(!sameSettings(checked, { ...checked, updateCheck: false }));
});

test('a port change needs a save', () => {
  const automatic = { ...settings, port: 0 };
  assert.ok(sameSettings(automatic, { ...automatic }));
  assert.ok(!sameSettings(automatic, { ...automatic, port: 50001 }));
});

test('the Port field reads a whole number or an empty field', () => {
  assert.equal(parsePort(''), 0);
  assert.equal(parsePort('  '), 0);
  assert.equal(parsePort(' 50001 '), 50001);
  assert.equal(parsePort('0'), 0);
  // The server rejects a port outside the range.
  assert.equal(parsePort('80'), 80);
  for (const text of ['auto', '50 001', '5e4', '-1', '1.5', '123456']) assert.equal(parsePort(text), null, text);
  assert.equal(portText(0), '');
  assert.equal(portText(50001), '50001');
});

test('the port status tells when a saved port applies', () => {
  assert.match(portStatus(0, 50000), /^Automatic\. The server uses port 50000 now\./);
  assert.equal(portStatus(50000, 50000), 'The server uses port 50000.');
  assert.match(portStatus(50001, 50000), /uses port 50000 now\. It uses port 50001 after the next server start/);
});
