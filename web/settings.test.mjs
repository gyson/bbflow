import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeToolEdit, parsePort, PortField, portStatus, portText, sameSettings, SettingsSaves, titleControls } from './dist/settings-model.js';

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

test('a running title test or title tool change keeps the title controls disabled', () => {
  const tools = [{ id: 'claude', name: 'Claude', command: 'claude -p' }];
  assert.deepEqual(titleControls(tools, 'claude', 'claude', false), { command: 'claude -p', custom: false, customize: true, test: true, select: true });
  // A save of another setting renders again during the test. The controls stay disabled.
  assert.deepEqual(titleControls(tools, 'claude', 'claude', true), { command: 'claude -p', custom: false, customize: false, test: false, select: false });
  assert.deepEqual(titleControls(tools, 'none', 'none', false), { command: '', custom: false, customize: false, test: false, select: true });
});

test('Custom shows its command field, and Test runs only the saved tool', () => {
  const tools = [{ id: 'claude', name: 'Claude', command: 'claude -p' }];
  // Custom has no built-in command. Its field shows, also before it saves.
  assert.deepEqual(titleControls(tools, 'custom', 'none', false), { command: '', custom: true, customize: false, test: false, select: true });
  assert.deepEqual(titleControls(tools, 'custom', 'custom', false), { command: '', custom: true, customize: false, test: true, select: true });
  // During a change, the list shows the new tool. Test waits for the save.
  assert.equal(titleControls(tools, 'claude', 'none', true).test, false);
  assert.equal(titleControls(tools, 'claude', 'custom', false).test, false);
});

test('a settings save does not save the title tool or the custom command', () => {
  // The title tool saves alone, after its test. A settings save keeps the saved values.
  const titled = { ...settings, titleTool: 'none', titleCommand: '' };
  assert.ok(sameSettings(titled, { ...titled, titleTool: 'custom', titleCommand: 'my-llm' }));
});

test('settings from a title tool change apply only when they are newer', () => {
  let changes = 0;
  const saves = new SettingsSaves(service(), () => changes++, () => {});
  saves.saved = { ...settings, titleTool: 'none', port: 0 };
  saves.update({ ...saves.saved, revision: 5, titleTool: 'codex' });
  assert.equal(saves.saved.titleTool, 'codex');
  assert.equal(changes, 1);
  // A late reply of an earlier save does not undo the title tool change.
  saves.update({ ...saves.saved, revision: 5, titleTool: 'none' });
  saves.update({ ...saves.saved, revision: 4, titleTool: 'none' });
  assert.equal(saves.saved.titleTool, 'codex');
  assert.equal(changes, 1);
});

test('a save reply older than a title tool change does not undo it', async () => {
  const server = service();
  const saves = new SettingsSaves(server, () => {}, () => {});
  saves.saved = { ...settings, titleTool: 'none', port: 0 };
  let reply;
  server.save = next => new Promise(resolve => { reply = () => resolve({ ...next, revision: next.revision + 1 }); });
  const saving = saves.saveDefault('appearance', 'dark');
  await new Promise(resolve => setImmediate(resolve));
  // The title tool change commits after the save, but its reply comes first.
  saves.update({ ...saves.saved, appearance: 'dark', revision: 6, titleTool: 'codex' });
  reply();
  await saving;
  assert.equal(saves.saved.revision, 6);
  assert.equal(saves.saved.titleTool, 'codex');
  assert.deepEqual(saves.defaults, {});
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

test('an edit during a port save stays when the save reply comes later', async () => {
  // request() gives the next save request. Its release() sends the reply.
  let asked;
  const request = () => new Promise(resolve => { asked = resolve; });
  const saves = new SettingsSaves({
    save: next => new Promise(resolve => asked(() => resolve({ ...next, revision: next.revision + 1 }))),
    async get() { throw new Error('no conflict in this test'); },
    conflict: () => false,
  }, () => field.render(saves.saved.port), () => {});
  const field = new PortField();
  saves.saved = { ...settings, port: 0 };
  assert.equal(field.render(0), '');
  field.input('50001', 0);
  let token = field.begin();
  let reply = request();
  const saved = saves.savePort(50001);
  // The user clears the field before the reply. The text is the same as the earlier port.
  field.input('', 0);
  (await reply)();
  await saved;
  field.done(token, true);
  assert.equal(saves.saved.port, 50001);
  assert.equal(field.render(saves.saved.port), '');
  assert.ok(field.edited, 'the newer edit was discarded');
  // A save of the newer edit with no later input clears the edit.
  token = field.begin();
  reply = request();
  const automatic = saves.savePort(0);
  (await reply)();
  await automatic;
  field.done(token, true);
  assert.ok(!field.edited);
  assert.equal(field.render(saves.saved.port), '');
  assert.equal(saves.saved.port, 0);
});

test('a Port field with the saved text has no edit, and a failed save keeps the edit', () => {
  const field = new PortField();
  field.input('5', 50001);
  assert.ok(field.edited);
  field.input('50001', 50001);
  assert.ok(!field.edited);
  field.input('6000', 50001);
  const token = field.begin();
  assert.ok(field.done(token, false));
  assert.ok(field.edited);
  assert.equal(field.render(50001), '6000');
  const again = field.begin();
  assert.ok(field.done(again, true));
  assert.equal(field.render(50001), '50001');
});

test('a late port reply does not change the error of a newer edit', () => {
  const field = new PortField();
  field.input('50001', 0);
  const token = field.begin();
  // Invalid text after the save started. Its validation error must stay.
  field.input('abc', 0);
  assert.ok(!field.done(token, true), 'a late success would hide the newer error');
  assert.ok(field.edited);
  assert.equal(field.render(50001), 'abc');
  field.input('50002', 50001);
  const failed = field.begin();
  field.input('xyz', 50001);
  assert.ok(!field.done(failed, false), 'a late failure would replace the newer error');
});
