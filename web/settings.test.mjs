import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fallbackTool, toolSwitch, defaultLabels, duplicateGroupError, duplicateName, duplicateNameError, duplicatePromptError, groupEdit, groupMove, groupProblem, groupRemoval, maxPromptGroups, failedTitleChange, maxPrompts, mergeToolEdit, parsePort, FieldEdit, portStatus, portText, promptEdit, promptMove, promptProblem, promptRemoval, RemoteChanged, remoteStatus, remoteValue, sameSettings, SettingsSaves, statusText, titleControls, toolEdit, toolRemoval } from './dist/settings-model.js';

const agent = { id: 'a', name: 'Agent', command: 'agent', type: 'custom', model: '', effort: '', permission: '', path: '', builtin: false, enabled: true };
const other = { id: 'b', name: 'Other', command: 'other', type: 'custom', model: '', effort: '', permission: '', path: '', builtin: false, enabled: true };
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
    { id: 'a', name: 'Renamed', command: 'agent --new', type: 'custom', model: '', effort: '', permission: '', path: '', builtin: false, enabled: true },
  ]);
  assert.throws(() => mergeToolEdit([other], renamed, agent), /removed/);
});

test('an edit of the type, the model, or the effort saves all three from the edit', () => {
  const codex = { ...agent, type: 'codex', model: 'gpt-6-luna', effort: 'medium' };
  const latest = { ...codex, name: 'Codex', effort: 'high' };
  const edited = { ...codex, model: 'gpt-6-sol' };
  assert.deepEqual(mergeToolEdit([latest], edited, codex), [{ ...latest, model: 'gpt-6-sol', effort: 'medium' }]);
  const renamed = { ...codex, name: 'Renamed' };
  assert.deepEqual(mergeToolEdit([latest], renamed, codex), [{ ...latest, name: 'Renamed' }]);
  assert.ok(!sameSettings(settings, { ...settings, tools: [{ ...agent, model: 'x' }, other] }));
});

test('an edit of the permission mode saves only that mode, and another edit keeps the latest mode', () => {
  const codex = { ...agent, type: 'codex', model: 'gpt-6-luna', effort: 'medium', permission: '' };
  const latest = { ...codex, effort: 'high', permission: 'read-only' };
  assert.deepEqual(mergeToolEdit([latest], { ...codex, permission: 'approve-for-me' }, codex), [{ ...latest, permission: 'approve-for-me' }]);
  assert.deepEqual(mergeToolEdit([latest], { ...codex, path: '/opt/codex' }, codex), [{ ...latest, path: '/opt/codex' }]);
  assert.ok(!sameSettings(settings, { ...settings, tools: [{ ...agent, permission: 'yolo' }, other] }));
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

test('the Settings page has a tool table, one editor dialog, and asks before a removal', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  // The built-in tools and the custom tools have a table each. The editor dialog opens from
  // Add custom tool or Edit.
  assert.match(html, /<tbody id="settings-builtin-tools">/);
  assert.match(html, /<th scope="col">On<\/th><th scope="col">Name<\/th><th scope="col">Command<\/th><th scope="col">Default model<\/th>/);
  // The custom tools have no type and no default model.
  assert.match(html, /<th scope="col">On<\/th><th scope="col">Name<\/th><th scope="col">Command<\/th><th scope="col"><span class="sr-only">Actions/);
  assert.doesNotMatch(html, /<th scope="col">Type<\/th>/);
  assert.match(html, /<button id="tool-add" type="button" class="tool-add">＋ Add custom tool<\/button>/);
  assert.match(html, /<dialog id="tool-editor-dialog" class="tool-editor-dialog" aria-labelledby="tool-editor-title">\s*<form id="tool-editor" class="tool-editor">/);
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

test('a remote access change needs a save, and its status needs the switch and both values', () => {
  const host = 'my-mac.example.ts.net', login = 'user@example.com';
  const off = { ...settings, remoteOn: false, remoteHost: '', remoteLogin: '' };
  assert.ok(sameSettings(off, { ...off }));
  assert.ok(!sameSettings(off, { ...off, remoteOn: true }));
  assert.ok(!sameSettings(off, { ...off, remoteHost: host }));
  assert.ok(!sameSettings(off, { ...off, remoteLogin: login }));
  assert.equal(remoteStatus(false, '', ''), '');
  // The switch keeps remote access off, also with both values.
  assert.equal(remoteStatus(false, host, login), '');
  assert.equal(remoteStatus(true, '', ''), 'The switch is on, but remote access needs both the host name and the login.');
  assert.match(remoteStatus(true, host, ''), /^The switch is on, but remote access needs both/);
  assert.match(remoteStatus(true, '', login), /^The switch is on, but remote access needs both/);
  assert.equal(remoteStatus(true, host, login), 'Remote access is on for my-mac.example.ts.net and the Tailscale user user@example.com.');
  // A field shows the value that the server saves for its text.
  assert.equal(remoteValue('remoteHost', ' My-Mac.Example.ts.net '), host);
  assert.equal(remoteValue('remoteLogin', ' User@Example.com '), 'User@Example.com');
});

// remoteServer keeps one copy of the settings and rejects a save with an earlier revision.
function remoteServer(stored) {
  return {
    get stored() { return stored; },
    async save(next) {
      if (next.revision !== stored.revision) throw new Error('settings changed');
      return stored = { ...next, revision: next.revision + 1 };
    },
    async get() { return stored; },
    conflict: () => true,
  };
}

test('the remote switch keeps the values, and turns on only for the values that the view showed', async () => {
  const host = 'my-mac.example.ts.net', other = 'other.example.ts.net', login = 'user@example.com';
  const server = remoteServer({ ...settings, revision: 1, remoteOn: false, remoteHost: host, remoteLogin: login });
  const first = new SettingsSaves(server, () => {}, () => {});
  const second = new SettingsSaves(server, () => {}, () => {});
  first.saved = second.saved = server.stored;
  const state = () => [server.stored.revision, server.stored.remoteOn, server.stored.remoteHost, server.stored.remoteLogin];
  // The switch turns on and off. The values stay.
  await first.saveRemoteSwitch(true, { remoteHost: host, remoteLogin: login });
  assert.deepEqual(state(), [2, true, host, login]);
  await first.saveRemoteSwitch(false, { remoteHost: host, remoteLogin: login });
  assert.deepEqual(state(), [3, false, host, login]);
  // The first view saves another host. The second view still shows the first host, and
  // it does not turn remote access on for a host that it did not show.
  await first.saveRemoteValue('remoteHost', other);
  const failure = await second.saveRemoteSwitch(true, { remoteHost: host, remoteLogin: login }).then(() => null, error => error);
  assert.ok(failure instanceof RemoteChanged);
  assert.equal(failure.message, 'Another view changed remote access. The saved host name is other.example.ts.net, and the saved login is user@example.com. Turn the switch on again to use them.');
  assert.deepEqual(state(), [4, false, other, login]);
  // The failed save read the values of the other view. A second click from them turns it on.
  assert.equal(second.saved.remoteHost, other);
  await second.saveRemoteSwitch(true, { remoteHost: other, remoteLogin: login });
  assert.deepEqual(state(), [5, true, other, login]);
  // An own save of a field before the switch is no conflict, when the view showed its value.
  await second.saveRemoteSwitch(false, { remoteHost: other, remoteLogin: login });
  const field = second.saveRemoteValue('remoteHost', host);
  await second.saveRemoteSwitch(true, { remoteHost: host, remoteLogin: login });
  await field;
  assert.deepEqual(state(), [8, true, host, login]);
  // A field save that took another value of the other field does not turn the switch on.
  await second.saveRemoteSwitch(false, { remoteHost: host, remoteLogin: login });
  first.update(server.stored);
  await first.saveRemoteValue('remoteLogin', 'other@example.com');
  const field2 = second.saveRemoteValue('remoteHost', other);
  const changed = await second.saveRemoteSwitch(true, { remoteHost: other, remoteLogin: login }).then(() => null, error => error);
  await field2;
  assert.ok(changed instanceof RemoteChanged);
  assert.deepEqual(state(), [11, false, other, 'other@example.com']);
  // Turning the switch off needs no check, also when the view showed other values.
  await second.saveRemoteSwitch(true, { remoteHost: other, remoteLogin: 'other@example.com' });
  first.update(server.stored);
  await second.saveRemoteValue('remoteLogin', login);
  await first.saveRemoteSwitch(false, { remoteHost: host, remoteLogin: 'stale@example.com' });
  assert.deepEqual(state(), [14, false, other, login]);
});

test('a view with earlier values does not restore a login that another view removed', async () => {
  const host = 'my-mac.example.ts.net', other = 'other.example.ts.net', login = 'user@example.com';
  const server = remoteServer({ ...settings, revision: 1, port: 0, remoteHost: host, remoteLogin: login });
  const first = new SettingsSaves(server, () => {}, () => {});
  const second = new SettingsSaves(server, () => {}, () => {});
  first.saved = second.saved = server.stored;
  // The first view removes the login. The second view still shows revision 1.
  await first.saveRemoteValue('remoteLogin', '');
  assert.deepEqual([server.stored.revision, server.stored.remoteLogin], [2, '']);
  // The second view saves the host only. The save applies to the latest settings, so the
  // login stays removed.
  await second.saveRemoteValue('remoteHost', other);
  assert.deepEqual([server.stored.revision, server.stored.remoteHost, server.stored.remoteLogin], [3, other, '']);
  assert.equal(second.saved.revision, 3);
  // A change of another setting meanwhile is no conflict of remote access.
  await first.savePort(50001);
  await second.saveRemoteValue('remoteHost', host);
  assert.deepEqual([server.stored.revision, server.stored.port, server.stored.remoteHost, server.stored.remoteLogin], [5, 50001, host, '']);
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
  const field = new FieldEdit(portText);
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
  const field = new FieldEdit(portText);
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
  const field = new FieldEdit(portText);
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
  const field = new FieldEdit(portText);
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

test('turning off the default tool or Shell selects Shell or the first other tool that is on', () => {
  const on = { ...settings, defaultTool: 'a', shellOff: false, tools: [agent, other] };
  assert.equal(toolSwitch('a', false)(on).defaultTool, '');
  // Shell is off, so the first other tool that is on takes its place.
  const shellOff = { ...on, shellOff: true };
  assert.equal(toolSwitch('a', false)(shellOff).defaultTool, 'b');
  assert.equal(fallbackTool(shellOff, 'a'), 'b');
  // Shell turns off as a tool with the empty ID.
  const shellDefault = { ...on, defaultTool: '' };
  const off = toolSwitch('', false)(shellDefault);
  assert.equal(off.shellOff, true);
  assert.equal(off.defaultTool, 'a');
  assert.equal(toolSwitch('', true)(off).shellOff, false);
  // The last tool that is on cannot turn off while it is the default tool.
  const last = { ...shellOff, tools: [agent, { ...other, enabled: false }] };
  assert.throws(() => toolSwitch('a', false)(last), /only tool that is on/);
  assert.throws(() => toolRemoval('a', true).change(last), /only tool that is on/);
  assert.equal(fallbackTool(last, 'a'), null);
});

const review = { id: 'p1', name: 'Review PR', text: 'Review PR #', group: '' };
const checks = { id: 'p2', name: 'Run checks', text: 'Run make test.', group: '' };
const prompted = { ...settings, prompts: [review, checks], promptGroups: [] };

test('a prompt change needs a save, and the order counts', () => {
  assert.ok(sameSettings(prompted, structuredClone(prompted)));
  assert.ok(!sameSettings(prompted, { ...prompted, prompts: [checks, review] }));
  assert.ok(!sameSettings(prompted, { ...prompted, prompts: [review, { ...checks, text: 'Run make check.' }] }));
  assert.ok(!sameSettings(prompted, { ...prompted, prompts: [review] }));
  assert.ok(!sameSettings(prompted, { ...prompted, prompts: [review, { ...checks, group: 'g' }], promptGroups: [{ id: 'g', name: 'Tests' }] }));
  assert.ok(!sameSettings(prompted, { ...prompted, promptGroups: [{ id: 'g', name: 'Tests' }] }));
});

test('a prompt edit applies only its changed fields to the latest prompt', () => {
  // Another view renamed the prompt. This edit changed only the text.
  const latest = { ...prompted, prompts: [{ ...review, name: 'Review' }, checks] };
  const edited = promptEdit({ ...review, text: 'Review pull request #' }, review)(latest);
  assert.deepEqual(edited.prompts, [{ id: 'p1', name: 'Review', text: 'Review pull request #', group: '' }, checks]);
  // A new prompt goes at the end. A retry of the same add after a lost reply changes
  // nothing, so the save ends at once.
  const added = promptEdit({ id: 'p3', name: 'Summary', text: 'Summarize.', group: '' })(prompted);
  assert.deepEqual(added.prompts.map(prompt => prompt.id), ['p1', 'p2', 'p3']);
  assert.ok(sameSettings(promptEdit({ id: 'p3', name: 'Summary', text: 'Summarize.', group: '' })(added), added));
  // A retry with a changed entry saves the change, in the place of the earlier attempt.
  const retried = promptEdit({ id: 'p3', name: 'Summary', text: 'Summarize the branch.', group: '' })(added);
  assert.deepEqual(retried.prompts, [review, checks, { id: 'p3', name: 'Summary', text: 'Summarize the branch.', group: '' }]);
  assert.ok(!sameSettings(retried, added));
  // A name that another view saved first stops the save. The case does not count.
  assert.throws(() => promptEdit({ id: 'p3', name: 'run CHECKS', text: 'x', group: '' })(prompted), { message: duplicatePromptError });
  assert.throws(() => promptEdit({ ...checks, name: 'Review PR' }, checks)(prompted), { message: duplicatePromptError });
  // An edit of a prompt that another view removed stops too.
  assert.throws(() => promptEdit({ ...checks, text: 'x' }, checks)({ ...prompted, prompts: [review] }), /removed in another view/);
});

test('a prompt moves within the list and a removal keeps the order of the others', () => {
  assert.deepEqual(promptMove('p1', 1)(prompted).prompts, [checks, review]);
  assert.equal(promptMove('p1', -1)(prompted), prompted, 'the first prompt does not move up');
  assert.equal(promptMove('p2', 1)(prompted), prompted, 'the last prompt does not move down');
  assert.throws(() => promptMove('gone', 1)(prompted), /removed in another view/);
  const third = { id: 'p3', name: 'Summary', text: 'Summarize.', group: '' };
  assert.deepEqual(promptRemoval('p2')({ ...prompted, prompts: [review, checks, third] }).prompts, [review, third]);
});

// Settings with two groups. The list mixes the prompts of the groups, as edits leave it.
const git = { id: 'g', name: 'Git' };
const tests = { id: 't', name: 'Tests' };
const commit = { id: 'c', name: 'Commit', text: 'Commit.', group: 'g' };
const race = { id: 'r', name: 'Race', text: 'Run the race detector.', group: 't' };
const rebase = { id: 'b', name: 'Rebase', text: 'Rebase on main.', group: 'g' };
const grouped = { ...settings, prompts: [review, commit, race, checks, rebase], promptGroups: [git, tests] };
const ids = settings => settings.prompts.map(prompt => `${prompt.id}${prompt.group ? `@${prompt.group}` : ''}`);

test('a prompt moves only inside its group, and the other groups keep their order', () => {
  assert.deepEqual(ids(promptMove('c', 1)(grouped)), ['p1', 'b@g', 'r@t', 'p2', 'c@g']);
  assert.deepEqual(ids(promptMove('p2', -1)(grouped)), ['p2', 'c@g', 'r@t', 'p1', 'b@g']);
  assert.equal(promptMove('b', 1)(grouped), grouped, 'the last prompt of a group does not move down');
  assert.equal(promptMove('r', -1)(grouped), grouped, 'the only prompt of a group does not move');
});

test('a prompt that gets another group goes to the end of that group, and the editor can add the group', () => {
  // The edit changed only the group. A rename from another view stays.
  const latest = { ...grouped, prompts: grouped.prompts.map(prompt => prompt.id === 'p1' ? { ...prompt, name: 'Review' } : prompt) };
  const moved = promptEdit({ ...review, group: 't' }, review)(latest);
  assert.deepEqual(ids(moved), ['c@g', 'r@t', 'p2', 'b@g', 'p1@t']);
  assert.equal(moved.prompts.at(-1).name, 'Review');
  // An edit that keeps the group keeps the place.
  assert.deepEqual(ids(promptEdit({ ...commit, text: 'Commit the work.' }, commit)(grouped)), ids(grouped));
  // A new prompt with a new group adds the group at the end. A retry after a lost reply
  // finds the group and adds it once.
  const docs = { id: 'd', name: 'Docs' };
  const added = promptEdit({ id: 'n', name: 'Update SPEC', text: 'Update SPEC.md.', group: 'd' }, undefined, docs)(grouped);
  assert.deepEqual(added.promptGroups, [git, tests, docs]);
  assert.deepEqual(ids(added).at(-1), 'n@d');
  assert.deepEqual(promptEdit({ id: 'n', name: 'Update SPEC', text: 'Update SPEC.md.', group: 'd' }, undefined, docs)(added).promptGroups, [git, tests, docs]);
  // A group name that another view saved first stops the save, and so does a group that
  // another view removed.
  assert.throws(() => promptEdit({ id: 'n', name: 'New', text: 'x', group: 'x' }, undefined, { id: 'x', name: 'tests' })(grouped), { message: duplicateGroupError });
  assert.throws(() => promptEdit({ ...review, group: 't' }, review)({ ...grouped, promptGroups: [git] }), /group was removed in another view/);
});

test('a group can be added, renamed, and moved, and its prompts keep their group', () => {
  const renamed = groupEdit({ id: 'g', name: 'Git and PRs' }, git)(grouped);
  assert.deepEqual(renamed.promptGroups, [{ id: 'g', name: 'Git and PRs' }, tests]);
  assert.equal(renamed.prompts, grouped.prompts);
  assert.deepEqual(groupEdit({ id: 'd', name: 'Docs' })(grouped).promptGroups.map(group => group.id), ['g', 't', 'd']);
  assert.throws(() => groupEdit({ id: 'd', name: 'GIT' })(grouped), { message: duplicateGroupError });
  assert.throws(() => groupEdit({ id: 'g', name: 'Git' }, git)({ ...grouped, promptGroups: [tests] }), /removed in another view/);
  assert.deepEqual(groupMove('t', -1)(grouped).promptGroups, [tests, git]);
  assert.equal(groupMove('g', -1)(grouped), grouped);
});

test('a group removal keeps its prompts by default, and removes only the prompts that the user confirmed', () => {
  // The prompts go to the end of the top level or of another group, in their order.
  assert.deepEqual(ids(groupRemoval('g', '')(grouped)), ['p1', 'r@t', 'p2', 'c', 'b']);
  const merged = groupRemoval('g', 't')(grouped);
  assert.deepEqual(ids(merged), ['p1', 'r@t', 'p2', 'c@t', 'b@t']);
  assert.deepEqual(merged.promptGroups, [tests]);
  // Another view added a prompt to the group after the confirmation. It stays, at the
  // top level.
  const later = { ...grouped, prompts: [...grouped.prompts, { id: 'l', name: 'Later', text: 'Later.', group: 'g' }] };
  assert.deepEqual(ids(groupRemoval('g', '', ['c', 'b'])(later)), ['p1', 'r@t', 'p2', 'l']);
  // A second attempt after a lost reply changes nothing. A destination that another view
  // removed stops the removal.
  const removed = groupRemoval('g', '')(grouped);
  assert.equal(groupRemoval('g', '')(removed), removed);
  assert.throws(() => groupRemoval('g', 't')({ ...grouped, promptGroups: [git] }), /removed in another view/);
});

test('the group editor names the problem of a group name', () => {
  assert.equal(groupProblem(grouped.promptGroups, 'Docs', 'd'), null);
  assert.equal(groupProblem(grouped.promptGroups, '', 'd'), 'Enter a name.');
  assert.equal(groupProblem(grouped.promptGroups, 'tests', 'd'), duplicateGroupError);
  assert.equal(groupProblem(grouped.promptGroups, 'Tests', 't'), null, 'a rename can keep the name');
  assert.equal(groupProblem(grouped.promptGroups, 'A\tB', 'd'), 'Remove the control characters from the name, such as a tab.');
  const full = Array.from({ length: maxPromptGroups }, (_, index) => ({ id: `g${index}`, name: `Group ${index}` }));
  assert.match(groupProblem(full, 'Docs', 'd'), /at most 50 groups/);
  assert.equal(groupProblem(full, 'Group 0', 'g0'), null);
});

test('the prompt editor names the field of the first problem', () => {
  const problem = (name, text, id = 'new', prompts = prompted.prompts) => promptProblem(prompts, name, text, id);
  assert.equal(problem('Summary', 'Summarize.\n\tList the risks.'), null);
  assert.deepEqual(problem('', 'text'), { field: 'name', message: 'Enter a name.' });
  assert.deepEqual(problem('review pr', 'text'), { field: 'name', message: duplicatePromptError });
  // An edit can keep its own name.
  assert.equal(problem('Review PR', 'Review PR #', 'p1'), null);
  assert.equal(problem('Summary', ' \n').field, 'text');
  assert.match(problem('Summary', 'é'.repeat(8 * 1024 + 1)).message, /16 KiB/);
  assert.equal(problem('Summary', 'é'.repeat(8 * 1024)), null);
  assert.match(problem('Summary', 'one\rtwo').message, /control characters/);
  assert.deepEqual(problem('Summary', 'pasted \x1b[31m red').field, 'text');
  // The server rejects each control character in a name, also a tab, and it counts code
  // points. An emoji is one character, though it has two UTF-16 code units.
  assert.deepEqual(problem('A\tB', 'text'), { field: 'name', message: 'Remove the control characters from the name, such as a tab.' });
  assert.equal(problem('Bell\x07', 'text').field, 'name');
  assert.equal(problem('Next\u0085line', 'text').field, 'name');
  assert.equal(problem('🚀'.repeat(200), 'text'), null);
  assert.deepEqual(problem('🚀'.repeat(201), 'text'), { field: 'name', message: 'Use a name of at most 200 characters.' });
  const full = Array.from({ length: maxPrompts }, (_, index) => ({ id: `p${index}`, name: `Prompt ${index}`, text: 'x', group: '' }));
  assert.match(problem('Summary', 'text', 'new', full).message, /at most 100 prompts/);
  assert.equal(problem('Prompt 0', 'edit', 'p0', full), null, 'an edit saves when the list is full');
});

test('the Settings page has prompt blocks, one editor dialog, a group dialog, and asks before a removal', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="settings-prompt-groups" class="prompt-groups"><\/div>/);
  assert.match(html, /<button id="prompt-group-add" type="button" class="tool-add">＋ Add group<\/button>/);
  assert.match(html, /<select id="prompt-group"><\/select>/);
  assert.match(html, /<dialog id="prompt-group-dialog"/);
  // The removal of a group selects Keep first.
  assert.match(html, /<input id="prompt-group-keep" type="radio" name="prompt-group-fate" value="keep" checked>/);
  assert.match(html, /<dialog id="prompt-editor-dialog" class="tool-editor-dialog" aria-labelledby="prompt-editor-title">\s*<form id="prompt-editor" class="tool-editor" novalidate>/);
  assert.match(html, /<dialog id="prompt-remove-dialog"/);
  // The server counts code points, so the name field has no maxlength in code units.
  assert.match(html, /<input id="prompt-name" placeholder="Review PR" autocomplete="off">/);
  // The ＋ menu of the message editor has the file item, the handoff prompt, the saved
  // prompts, Manage prompts, and the flyout of a group, in this order.
  const menu = html.slice(html.indexOf('<div id="composer-menu"'), html.indexOf('<input id="composer-picker"'));
  const order = ['id="composer-attach"', 'id="handoff-open"', 'id="composer-prompts"', 'id="composer-prompts-note"', 'id="composer-prompts-manage"', 'id="composer-flyout"'].map(id => menu.indexOf(id));
  assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), order.join());
  assert.doesNotMatch(html, /＋ Attach files|Put in message editor|composer-prompt-filter/);
});
