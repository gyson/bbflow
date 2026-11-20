import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeToolEdit, parsePort, portStatus, portText, sameSettings, SettingsSaves, titleControls } from './dist/settings-model.js';

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

test('the Port field gives all of its text to the parser', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const input = html.match(/<input id="settings-port"[^>]*>/)?.[0];
  assert.ok(input, 'the Port field is missing');
  // A maxlength of 5 cuts 123456 to 12345, another valid port, before the parser sees it.
  assert.doesNotMatch(input, /maxlength/);
  assert.equal(parsePort('123456'), null);
});

// A save service that rejects port 80 and records each save.
function service() {
  const sent = [];
  return {
    sent,
    async save(next) {
      sent.push(next);
      if (next.port === 80) throw new Error('port must be from 1024 to 65535');
      return { ...next, revision: next.revision + 1 };
    },
    async get() { throw new Error('no conflict in this test'); },
    conflict: () => false,
  };
}

test('a rejected port does not join a later save of another setting', async () => {
  const server = service();
  const saves = new SettingsSaves(server, () => {}, () => {});
  saves.saved = { ...settings, appearance: 'system', titleTool: 'none', updateCheck: true, port: 0 };
  await assert.rejects(saves.savePort(80), /port must be/);
  await saves.saveDefault('appearance', 'dark');
  assert.equal(server.sent.length, 2);
  assert.equal(server.sent[1].appearance, 'dark');
  assert.equal(server.sent[1].port, 0);
  assert.equal(saves.saved.appearance, 'dark');
  assert.equal(saves.saved.port, 0);
  assert.deepEqual(saves.defaults, {});
  assert.equal(saves.writes, 0);
});

test('a rejected default stays pending and saves with the next default', async () => {
  const server = service();
  server.save = async next => {
    server.sent.push(next);
    if (next.base === 'bad') throw new Error('invalid default Git base');
    return { ...next, revision: next.revision + 1 };
  };
  const saves = new SettingsSaves(server, () => {}, () => {});
  saves.saved = { ...settings, port: 0 };
  await assert.rejects(saves.saveDefault('base', 'bad'), /invalid/);
  assert.deepEqual(saves.defaults, { base: 'bad' });
  await saves.saveDefault('base', 'main');
  assert.equal(saves.saved.base, 'main');
  assert.deepEqual(saves.defaults, {});
});

test('a save after a revision conflict applies the change to the latest settings', async () => {
  const latest = { ...settings, revision: 9, worktree: true, port: 0 };
  let first = true;
  const saves = new SettingsSaves({
    async save(next) {
      if (first) { first = false; throw new Error('settings changed'); }
      return { ...next, revision: next.revision + 1 };
    },
    async get() { return latest; },
    conflict: () => true,
  }, () => {}, () => {});
  saves.saved = { ...settings, port: 0 };
  await saves.savePort(50001);
  assert.equal(saves.saved.revision, 10);
  assert.equal(saves.saved.port, 50001);
  assert.equal(saves.saved.worktree, true);
});
