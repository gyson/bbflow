import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultLabels, duplicateName, duplicateNameError, failedTitleChange, mergeToolEdit, parsePort, PortField, portStatus, portText, RemoteChanged, remoteStatus, sameSettings, SettingsSaves, statusText, titleControls, toolEdit, toolRemoval } from './dist/settings-model.js';

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
  assert.deepEqual(titleControls(tools, 'claude', 'claude', false), { command: 'claude -p', custom: false, test: true, testShown: true, select: true });
  // A save of another setting renders again during the test. The controls stay disabled.
  assert.deepEqual(titleControls(tools, 'claude', 'claude', true), { command: 'claude -p', custom: false, test: false, testShown: true, select: false });
  // None has nothing to test, so Test does not show.
  assert.deepEqual(titleControls(tools, 'none', 'none', false), { command: '', custom: false, test: false, testShown: false, select: true });
});

test('Custom shows its command field, and Test runs only the saved tool', () => {
  const tools = [{ id: 'claude', name: 'Claude', command: 'claude -p' }];
  // Custom has no built-in command. Its field shows, also before it saves.
  // Only Save and test shows for a Custom that is not saved.
  assert.deepEqual(titleControls(tools, 'custom', 'none', false), { command: '', custom: true, test: false, testShown: false, select: true });
  assert.deepEqual(titleControls(tools, 'custom', 'custom', false), { command: '', custom: true, test: true, testShown: true, select: true });
  // During a change, the list shows the new tool. Test shows, and it waits for the save.
  assert.equal(titleControls(tools, 'claude', 'none', true).test, false);
  assert.equal(titleControls(tools, 'claude', 'none', true).testShown, true);
  assert.equal(titleControls(tools, 'claude', 'custom', false).test, false);
  // Test runs the saved custom command. An edit in the field must save first, so Test
  // does not show.
  assert.equal(titleControls(tools, 'custom', 'custom', false, true).test, false);
  assert.equal(titleControls(tools, 'custom', 'custom', false, true).testShown, false);
  assert.equal(titleControls(tools, 'custom', 'custom', false, true).select, true);
  assert.equal(titleControls(tools, 'claude', 'claude', false, true).test, true);
});

test('the status names each entry that is not saved', () => {
  assert.equal(statusText(false, []), 'All settings saved');
  assert.equal(statusText(false, ['Port']), 'Not saved: Port');
  assert.equal(statusText(false, [defaultLabels.base, 'New tool']), 'Not saved: Starting branch or commit, New tool');
  // A running save has priority, because its entries are about to save.
  assert.equal(statusText(true, ['Port']), 'Saving…');
});

test('a tool name that another tool has is a duplicate', () => {
  assert.ok(duplicateName([agent, other], 'Other', 'new'));
  assert.ok(duplicateName([agent, other], 'Other', 'a'));
  // The tool of the entry can keep its own name. Names match exactly, as in the CLI.
  assert.ok(!duplicateName([agent, other], 'Other', 'b'));
  assert.ok(!duplicateName([agent, other], 'other', 'new'));
});

// A save service whose first save conflicts. The read then gives latest.
function conflictOnce(latest) {
  const sent = [];
  return {
    sent,
    async save(next) {
      sent.push(next);
      if (sent.length === 1) throw new Error('settings changed');
      return { ...next, revision: next.revision + 1 };
    },
    async get() { return latest; },
    conflict: () => true,
  };
}

test('a tool name from another client stops the add after a revision conflict', async () => {
  // The CLI added a tool with the name New after this view read the settings.
  const latest = { ...settings, revision: 5, tools: [agent, other, { id: 'cli', name: 'New', command: 'new' }], port: 0 };
  const server = conflictOnce(latest);
  const saves = new SettingsSaves(server, () => {}, () => {});
  saves.saved = { ...settings, port: 0 };
  await assert.rejects(saves.save(toolEdit({ id: 'page', name: 'New', command: 'page' })), new RegExp(duplicateNameError));
  assert.equal(server.sent.length, 1, 'the second attempt sent a duplicate name');
  assert.deepEqual(saves.saved.tools.map(tool => tool.name), ['Agent', 'Other', 'New']);
});

test('an edit that keeps its name saves, also when another tool has that name', async () => {
  const copy = { id: 'copy', name: 'Agent', command: 'copy' };
  const server = conflictOnce({ ...settings, revision: 5, tools: [agent, other, copy], port: 0 });
  const saves = new SettingsSaves(server, () => {}, () => {});
  saves.saved = { ...settings, port: 0 };
  await saves.save(toolEdit({ ...agent, command: 'agent --new' }, agent));
  assert.deepEqual(saves.saved.tools[0], { ...agent, command: 'agent --new' });
  // A rename to the name of another tool does not save.
  await assert.rejects(saves.save(toolEdit({ ...other, name: 'Agent' }, other)), new RegExp(duplicateNameError));
});

test('a removal asks again when the tool became the default tool after the warning', async () => {
  // The dialog opened for a tool that was not the default. The CLI then made it the default.
  const server = conflictOnce({ ...settings, revision: 5, defaultTool: 'b', port: 0 });
  const saves = new SettingsSaves(server, () => {}, () => {});
  saves.saved = { ...settings, port: 0 };
  const removal = toolRemoval('b', false);
  await saves.save(removal.change);
  assert.ok(removal.reconfirm());
  assert.equal(server.sent.length, 1, 'the removal saved without the warning');
  assert.equal(saves.saved.defaultTool, 'b');
  assert.equal(saves.saved.tools.length, 2);
  // The user confirms the warning. The removal saves and selects Shell.
  const warned = toolRemoval('b', true);
  await saves.save(warned.change);
  assert.ok(!warned.reconfirm());
  assert.equal(saves.saved.defaultTool, '');
  assert.deepEqual(saves.saved.tools, [agent]);
  // A removal of a tool that is not the default needs no warning.
  const plain = toolRemoval('a', false);
  await saves.save(plain.change);
  assert.ok(!plain.reconfirm());
  assert.deepEqual(saves.saved.tools, []);
});

test('the Settings page has one Clear for the add row and asks before a removal', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  // The add row has no example of a saved tool, and Clear shows only with text.
  assert.match(html, /<input id="add-tool-name"[^>]*placeholder="Name"/);
  assert.match(html, /<button id="add-tool-cancel" type="button" hidden>Clear<\/button>/);
  assert.match(html, /<dialog id="tool-remove-dialog"/);
  // Tools come before the default tool that selects one of them.
  assert.ok(html.indexOf('id="settings-tools"') < html.indexOf('id="settings-tool"'));
  // Test does not show before the first render.
  assert.match(html, /<button id="title-test" type="button" hidden disabled>/);
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

test('a failed title change keeps Custom in the list only when Custom is not saved', () => {
  const none = { titleTool: 'none', titleCommand: '' };
  const custom = { titleTool: 'custom', titleCommand: 'title-pass' };
  // A failed first custom command keeps Custom in the list, so that it can be fixed.
  assert.deepEqual(failedTitleChange('custom', none, none), { customOpen: true, detail: 'Fix the command, then click Save and test again.' });
  // With a saved Custom, the list shows the saved Custom. The failed command is an edit.
  assert.deepEqual(failedTitleChange('custom', custom, custom), { customOpen: false, detail: 'Fix the command, then click Save and test again.' });
  // When the settings read fails, the choice from the start decides.
  assert.equal(failedTitleChange('custom', custom, null).customOpen, false);
  assert.deepEqual(failedTitleChange('codex', none, none), { customOpen: false, detail: 'Fix the problem, then select the tool again.' });
  assert.deepEqual(failedTitleChange('none', none, null), { customOpen: false, detail: '' });
});

test('a title change that another change replaced does not ask for a fix', () => {
  const custom = { titleTool: 'custom', titleCommand: 'title-pass' };
  const none = { titleTool: 'none', titleCommand: 'title-pass' };
  // Another client selected None during a test of Custom. The command has no fault.
  assert.deepEqual(failedTitleChange('custom', custom, none), { customOpen: true, detail: 'Another change of the title tool saved during the test.' });
  assert.equal(failedTitleChange('codex', custom, none).detail, 'Another change of the title tool saved during the test.');
  // A new custom command from another client is also another change.
  assert.equal(failedTitleChange('claude', custom, { ...custom, titleCommand: 'title-slow' }).detail, 'Another change of the title tool saved during the test.');
});

test('a delayed settings read after a conflict does not undo a title tool change', async () => {
  const saves = new SettingsSaves({
    sent: [],
    async save(next) {
      this.sent.push(next);
      throw new Error('settings changed');
    },
    get() {
      // A title tool change saves revision 6 before this read of revision 5 replies.
      saves.update({ ...settings, appearance: 'dark', revision: 6, titleTool: 'codex', port: 0 });
      return Promise.resolve({ ...settings, appearance: 'dark', revision: 5, titleTool: 'none', port: 0 });
    },
    conflict: () => true,
  }, () => {}, () => {});
  saves.saved = { ...settings, titleTool: 'none', port: 0 };
  await saves.saveDefault('appearance', 'dark');
  assert.equal(saves.saved.revision, 6);
  assert.equal(saves.saved.titleTool, 'codex');
  assert.deepEqual(saves.defaults, {});
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

test('a remote access change needs a save, and its status needs both values', () => {
  const off = { ...settings, remoteHost: '', remoteLogin: '' };
  assert.ok(sameSettings(off, { ...off }));
  assert.ok(!sameSettings(off, { ...off, remoteHost: 'my-mac.example.ts.net' }));
  assert.ok(!sameSettings(off, { ...off, remoteLogin: 'user@example.com' }));
  assert.equal(remoteStatus('', ''), 'Remote access is off.');
  assert.match(remoteStatus('my-mac.example.ts.net', ''), /^Remote access is off\. It needs both/);
  assert.match(remoteStatus('', 'user@example.com'), /^Remote access is off\. It needs both/);
  assert.equal(remoteStatus('my-mac.example.ts.net', 'user@example.com'), 'Remote access is on for my-mac.example.ts.net and the Tailscale user user@example.com.');
});

test('a view with earlier values does not restore a login that another view removed', async () => {
  const host = 'my-mac.example.ts.net', login = 'user@example.com';
  // The server keeps one copy of the settings and rejects a save with an earlier revision.
  let stored = { ...settings, revision: 1, port: 0, remoteHost: host, remoteLogin: login };
  const server = {
    async save(next) {
      if (next.revision !== stored.revision) throw new Error('settings changed');
      return stored = { ...next, revision: next.revision + 1 };
    },
    async get() { return stored; },
    conflict: () => true,
  };
  const first = new SettingsSaves(server, () => {}, () => {});
  const second = new SettingsSaves(server, () => {}, () => {});
  first.saved = second.saved = stored;
  // The first view removes the login. The second view still shows revision 1.
  await first.saveRemote({ host, login }, host, '');
  assert.deepEqual([stored.revision, stored.remoteLogin], [2, '']);
  // The second view saves an edit of the host only, with the login that it shows.
  const base = { host, login };
  const failure = await second.saveRemote(base, 'other.example.ts.net', login).then(() => null, error => error);
  assert.ok(failure instanceof RemoteChanged);
  assert.match(failure.message, /^Another view changed remote access\. The saved host name is my-mac\.example\.ts\.net, and the saved login is none\./);
  assert.deepEqual(failure.saved, { host, login: '' });
  assert.deepEqual([stored.revision, stored.remoteHost, stored.remoteLogin], [2, host, '']);
  assert.equal(second.saved.revision, 2);
  // A second save from the values of the other view replaces them.
  await second.saveRemote(failure.saved, 'other.example.ts.net', login);
  assert.deepEqual([stored.revision, stored.remoteHost, stored.remoteLogin], [3, 'other.example.ts.net', login]);
  // A change of another setting meanwhile is no conflict of remote access.
  await first.savePort(50001);
  await second.saveRemote({ host: 'other.example.ts.net', login }, host, login);
  assert.deepEqual([stored.revision, stored.port, stored.remoteHost], [5, 50001, host]);
});

test('the Port field reads a whole number or an empty field', () => {
  assert.equal(parsePort(''), 0);
  assert.equal(parsePort('  '), 0);
  assert.equal(parsePort(' 50001 '), 50001);
  assert.equal(parsePort('0'), 0);
  assert.equal(parsePort('1024'), 1024);
  assert.equal(parsePort('65535'), 65535);
  // A port outside the range gets the message of the page, not a server error.
  for (const text of ['auto', '50 001', '5e4', '-1', '1.5', '123456', '80', '1023', '65536']) assert.equal(parsePort(text), null, text);
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
  assert.deepEqual([...saves.rejected], ['base']);
  await saves.saveDefault('base', 'main');
  assert.equal(saves.saved.base, 'main');
  assert.deepEqual(saves.defaults, {});
  assert.equal(saves.rejected.size, 0);
});

test('a discarded rejected default does not join a later save', async () => {
  const server = service();
  server.save = async next => {
    server.sent.push(next);
    if (next.base === 'bad') throw new Error('invalid default Git base');
    return { ...next, revision: next.revision + 1 };
  };
  const saves = new SettingsSaves(server, () => {}, () => {});
  saves.saved = { ...settings, port: 0 };
  await assert.rejects(saves.saveDefault('base', 'bad'), /invalid/);
  // The user leaves Settings, or presses Escape in the field.
  saves.discardRejected();
  assert.deepEqual(saves.defaults, {});
  assert.equal(saves.rejected.size, 0);
  await saves.saveDefault('appearance', 'dark');
  assert.equal(server.sent.at(-1).base, 'HEAD');
  assert.equal(saves.saved.appearance, 'dark');
});

test('a discard keeps a default whose save waits or runs', async () => {
  const server = service();
  let reply;
  server.save = next => new Promise(resolve => { reply = () => resolve({ ...next, revision: next.revision + 1 }); });
  const saves = new SettingsSaves(server, () => {}, () => {});
  saves.saved = { ...settings, port: 0 };
  const saving = saves.saveDefault('base', 'main');
  // The user leaves Settings before the reply. The save is not a rejected one.
  saves.discardRejected();
  assert.deepEqual(saves.defaults, { base: 'main' });
  await new Promise(resolve => setImmediate(resolve));
  reply();
  await saving;
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

test('a reset of the Port field shows the saved port, and a running save is not current', () => {
  const field = new PortField();
  field.input('6000', 50001);
  field.reset();
  assert.ok(!field.edited);
  assert.equal(field.render(50001), '50001');
  // The user leaves Settings during a port save. The reply does not show an error.
  field.input('50002', 50001);
  const token = field.begin();
  field.reset();
  assert.ok(!field.done(token, false));
  assert.ok(!field.edited);
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
