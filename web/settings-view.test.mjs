import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsView } from './dist/settings.js';

// A small fake DOM. It has only the parts that the Settings view uses.
class Node {
  hidden = false;
  disabled = false;
  value = '';
  checked = false;
  open = false;
  className = '';
  dataset = {};
  children = [];
  parent = null;
  attributes = new Map();
  text = '';
  constructor(tag = 'div') { this.tag = tag; }
  set textContent(text) { this.text = String(text); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.text = ''; this.children = []; this.append(...nodes); }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  before(...nodes) {
    this.parent.children.splice(this.parent.children.indexOf(this), 0, ...nodes);
    for (const node of nodes) node.parent = this.parent;
  }
  contains(node) {
    for (; node; node = node.parent) if (node === this) return true;
    return false;
  }
  // The view asks only for the tool row of a focused button.
  closest() {
    for (let node = this; node; node = node.parent) if (node.dataset.toolId) return node;
    return null;
  }
  querySelectorAll() { return []; }
  find(id) {
    if (this.id === id) return this;
    for (const child of this.children) {
      const found = child.find(id);
      if (found) return found;
    }
    return null;
  }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  focus() { document.activeElement = this; }
  // A form clears its fields.
  reset() {
    for (const child of this.children) {
      child.value = '';
      child.reset();
    }
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

const ids = ['settings-view', 'settings-form', 'settings-appearance', 'settings-tool', 'settings-worktree', 'settings-base',
  'settings-update-check', 'settings-port-form', 'settings-port', 'settings-port-error', 'settings-port-status',
  'settings-remote-form', 'settings-remote-host', 'settings-remote-login', 'settings-remote-save', 'settings-remote-error',
  'settings-remote-status',
  'settings-error', 'settings-status', 'settings-builtin-tools', 'settings-tools', 'settings-tool-help', 'tool-error', 'tool-add', 'tool-editor-dialog', 'tool-editor', 'tool-close',
  'tool-editor-title', 'tool-name', 'tool-command', 'tool-command-help', 'tool-path-field', 'tool-path', 'tool-path-help', 'tool-builtin-note', 'tool-identity', 'tool-command-field', 'tool-models',
  'tool-model', 'tool-model-other', 'tool-model-help', 'tool-model-refresh', 'tool-effort', 'tool-effort-help',
  'tool-preview', 'tool-submit', 'tool-cancel', 'tool-editor-error', 'tool-remove-dialog', 'tool-remove-form',
  'cancel-tool-remove', 'tool-remove-summary', 'tool-remove-default', 'title-settings', 'title-tool', 'title-spinner',
  'title-builtin', 'title-tool-command', 'title-custom', 'title-custom-command', 'title-custom-save', 'title-test',
  'title-test-result', 'title-test-sample', 'title-test-outcome', 'title-test-detail', 'title-model-save', 'title-models',
  'title-model', 'title-model-other', 'title-model-help', 'title-model-refresh', 'title-effort', 'title-effort-help'];
const agent = { id: 'a', name: 'Agent', command: 'agent', type: 'custom', model: '', effort: '', builtin: false, enabled: true, path: '' };
const other = { id: 'b', name: 'Other', command: 'other', type: 'custom', model: '', effort: '', builtin: false, enabled: true, path: '' };
const saved = { revision: 4, appearance: 'system', defaultTool: '', worktree: false, base: 'HEAD', tools: [agent, other],
  titleTool: 'none', titleCommand: '', titleModel: '', titleEffort: '', updateCheck: true, port: 0, remoteHost: '', remoteLogin: '' };
const server = { protocol: 'test', instance: 'test', port: 50000, dataDir: '/fixture' };
const event = { preventDefault() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));

// setup opens the Settings view with the saved settings. Each server call waits in
// pending until the fixture sends its reply with reply or fail.
async function setup(titleTools = [{ id: 'codex', name: 'Codex', command: 'codex exec' }]) {
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  nodes['tool-editor-error'].hidden = true;
  for (const id of ['tool-editor-error', 'settings-port-error', 'settings-remote-error', 'settings-error', 'tool-error', 'title-test-result']) nodes[id].hidden = true;
  nodes['settings-remote-form'].append(nodes['settings-remote-host'], nodes['settings-remote-login'], nodes['settings-remote-save']);
  nodes['settings-view'].hidden = true;
  for (const [id, node] of Object.entries(nodes)) node.id = id;
  for (const name of ['HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLDialogElement']) globalThis[name] = Node;
  globalThis.Option = class extends Node {
    constructor(text, value) { super('option'); this.text = text; this.value = value; }
  };
  const body = new Node('body');
  globalThis.window = { addEventListener() {} };
  globalThis.document = {
    body,
    activeElement: body,
    documentElement: new Node('html'),
    getElementById: id => nodes[id] ?? nodes['settings-tools'].find(id) ?? nodes['settings-builtin-tools'].find(id),
    createElement: tag => new Node(tag),
  };
  const pending = [];
  const send = (target, request) => new Promise((resolve, reject) => pending.push({ request, resolve, reject }));
  const take = operation => {
    const index = pending.findIndex(call => call.request.operation === operation);
    assert.ok(index >= 0, `no ${operation} request waits`);
    return pending.splice(index, 1)[0];
  };
  // reply sends the result of the oldest waiting request of an operation. For a save, the
  // default result is the sent settings with the next revision.
  const reply = async (operation, result) => {
    const call = take(operation);
    call.resolve(result ?? { ...call.request.settings, revision: call.request.settings.revision + 1 });
    await tick();
    return call.request;
  };
  const fail = async (operation, message) => {
    take(operation).reject(new Error(message));
    await tick();
  };
  const toasts = [];
  const view = new SettingsView(() => server, () => {}, (title, detail) => toasts.push([title, detail]), send);
  const opening = view.open();
  await tick();
  await reply('title-tools', { tools: titleTools, sample: 'Sample' });
  await reply('settings-get', structuredClone(saved));
  await opening;
  await reply('tool-check', { installed: {} });
  // type enters text in a field, as the keyboard does.
  const type = (id, text) => {
    nodes[id].value = text;
    (nodes[id].oninput ?? nodes[id].parent?.oninput)?.(event);
  };
  // reopen opens Settings again after a close.
  const reopen = async () => {
    const opened = view.open();
    await tick();
    if (pending.some(call => call.request.operation === 'settings-get')) await reply('settings-get', structuredClone(view.saves.saved));
    await opened;
    if (pending.some(call => call.request.operation === 'tool-check')) await reply('tool-check', { installed: {} });
  };
  return { nodes, pending, view, toasts, reply, fail, type, reopen };
}

// addTool opens the editor with Add tool and enters a name and a command.
function addTool(nodes, type, name, command) {
  nodes['tool-add'].onclick();
  type('tool-name', name);
  type('tool-command', command);
}

test('a tool save that fails after Done shows a toast that names the action', async () => {
  const { nodes, view, toasts, fail, type, reopen } = await setup();
  addTool(nodes, type, 'Temp', 'temp');
  assert.equal(nodes['settings-status'].textContent, 'Not saved: New tool');
  nodes['tool-editor'].onsubmit(event);
  await tick();
  // The user clicks Done before the reply. The close discards the editor.
  view.close();
  await fail('settings-save', 'database is locked');
  assert.deepEqual(toasts, [['The new tool “Temp” did not save.', 'database is locked']]);
  assert.ok(nodes['tool-editor-error'].hidden, 'the error went to the hidden editor');
  assert.ok(!nodes['tool-editor-dialog'].open);
  assert.ok(!view.unsaved);

  // A removal and a move name their tool too.
  await reopen();
  document.getElementById('tool-remove-a').onclick();
  assert.ok(nodes['tool-remove-dialog'].open);
  nodes['tool-remove-form'].onsubmit(event);
  await tick();
  view.close();
  await fail('settings-save', 'database is locked');
  assert.deepEqual(toasts[1], ['The removal of “Agent” did not save.', 'database is locked']);
  await reopen();
  document.getElementById('tool-move-down-a').onclick();
  await tick();
  view.close();
  await fail('settings-save', 'database is locked');
  assert.deepEqual(toasts[2], ['The move of “Agent” did not save.', 'database is locked']);
  assert.ok(nodes['tool-error'].hidden);

  // A reply after the user opened Settings again also goes to a toast. The row has no
  // entry of that save any more.
  await reopen();
  addTool(nodes, type, 'Temp', 'temp');
  nodes['tool-editor'].onsubmit(event);
  await tick();
  view.close();
  await reopen();
  await fail('settings-save', 'database is locked');
  assert.equal(toasts.length, 4);
  assert.ok(nodes['tool-editor-error'].hidden);
});

test('a tool save that fails in Settings shows its error in the editor', async () => {
  const { nodes, toasts, fail, type } = await setup();
  addTool(nodes, type, 'Temp', 'temp');
  nodes['tool-editor'].onsubmit(event);
  await tick();
  await fail('settings-save', 'database is locked');
  assert.deepEqual(toasts, []);
  assert.ok(!nodes['tool-editor-error'].hidden);
  assert.equal(nodes['tool-editor-error'].textContent, 'database is locked');
  // An error keeps the entered values and the editor.
  assert.equal(nodes['tool-name'].value, 'Temp');
  assert.ok(nodes['tool-editor-dialog'].open);
});

test('Add custom tool adds a Custom tool with a name and a command, in a dialog', async () => {
  const { nodes, pending, reply, type } = await setup();
  addTool(nodes, type, 'Codex search', 'codex --no-alt-screen --search');
  // Add custom tool opens the editor as a dialog. It waits while the dialog is open.
  assert.ok(nodes['tool-editor-dialog'].open);
  assert.equal(nodes['tool-editor-title'].textContent, 'New custom tool');
  assert.ok(nodes['tool-add'].disabled, 'Add custom tool waits while the editor is open');
  // A custom tool has no model fields, also when its command starts an agent.
  assert.ok(nodes['tool-models'].hidden);
  assert.ok(!pending.some(call => call.request.operation === 'tool-models'));
  assert.equal(nodes['tool-preview'].textContent, 'codex --no-alt-screen --search');
  nodes['tool-editor'].onsubmit(event);
  await tick();
  const request = await reply('settings-save');
  const added = request.settings.tools.at(-1);
  assert.deepEqual({ ...added, id: '' }, { id: '', name: 'Codex search', command: 'codex --no-alt-screen --search', type: 'custom', model: '', effort: '', builtin: false, enabled: true, path: '' });
  assert.ok(!nodes['tool-editor-dialog'].open);
  assert.ok(!nodes['tool-add'].disabled);

  // Escape closes the dialog like Cancel.
  addTool(nodes, type, 'Temp', 'temp');
  let prevented = false;
  nodes['tool-editor-dialog'].oncancel({ preventDefault() { prevented = true; } });
  assert.ok(prevented && !nodes['tool-editor-dialog'].open);
  assert.equal(nodes['settings-status'].textContent, 'All settings saved');

  // An edit opens the editor with the saved values.
  document.getElementById(`tool-edit-${added.id}`).onclick();
  assert.equal(nodes['tool-editor-title'].textContent, 'Edit of Codex search');
  assert.equal(nodes['tool-submit'].textContent, 'Save');
  assert.equal(nodes['tool-name'].value, 'Codex search');
});

test('a corrected port that saves after Done gives no toast', async () => {
  const { nodes, view, toasts, reply, type } = await setup();
  type('settings-port', '80');
  nodes['settings-port-form'].onsubmit(event);
  assert.ok(!nodes['settings-port-error'].hidden);
  // The new text hides the error of the earlier text.
  type('settings-port', '45050');
  assert.ok(nodes['settings-port-error'].hidden);
  // The click on Done takes focus from the field, and the field saves.
  nodes['settings-port'].onchange();
  await tick();
  view.close();
  const request = await reply('settings-save');
  assert.equal(request.settings.port, 45050);
  assert.deepEqual(toasts, []);
  assert.equal(nodes['settings-port'].value, '45050');
  assert.ok(!view.unsaved);
});

test('a port that the server rejects gives one toast, before or after Done', async () => {
  const { nodes, view, toasts, fail, type, reopen } = await setup();
  const rejection = 'web browsers do not open port 6000; choose another port';
  // The reply comes between the blur and the click on Done.
  type('settings-port', '6000');
  nodes['settings-port'].onchange();
  await tick();
  await fail('settings-save', rejection);
  assert.ok(!nodes['settings-port-error'].hidden);
  view.close();
  assert.deepEqual(toasts, [['The port did not save.', rejection]]);
  assert.equal(nodes['settings-port'].value, '');
  assert.ok(!view.unsaved);

  // The reply comes after the click on Done.
  await reopen();
  type('settings-port', '6000');
  nodes['settings-port'].onchange();
  await tick();
  view.close();
  assert.equal(toasts.length, 1);
  await fail('settings-save', rejection);
  assert.deepEqual(toasts[1], ['The port did not save.', rejection]);
  assert.equal(toasts.length, 2);
  assert.ok(!view.unsaved);

  // Text that is not a port gets the range message.
  await reopen();
  type('settings-port', '80');
  nodes['settings-port'].onchange();
  view.close();
  assert.match(toasts[2][1], /^Enter a port from 1024 to 65535/);
  assert.equal(toasts.length, 3);
});

test('a default that the server rejects does not stay after Escape or Done', async () => {
  const { nodes, view, toasts, reply, fail, type, reopen } = await setup();
  type('settings-base', 'bad');
  nodes['settings-form'].onsubmit(event);
  await tick();
  await fail('settings-save', 'invalid default Git base');
  assert.equal(nodes['settings-status'].textContent, 'Not saved: Starting branch or commit');
  nodes['settings-base'].onkeydown({ key: 'Escape' });
  assert.equal(nodes['settings-base'].value, 'HEAD');
  assert.equal(nodes['settings-status'].textContent, 'All settings saved');
  assert.ok(nodes['settings-error'].hidden);

  // The reply comes after the click on Done.
  type('settings-base', 'bad');
  nodes['settings-base'].onchange();
  await tick();
  view.close();
  await fail('settings-save', 'invalid default Git base');
  assert.deepEqual(toasts, [['A setting did not save.', 'invalid default Git base']]);
  assert.ok(!view.unsaved);

  // The rejected value does not join a later save.
  await reopen();
  assert.equal(nodes['settings-base'].value, 'HEAD');
  nodes['settings-appearance'].value = 'dark';
  nodes['settings-appearance'].onchange();
  await tick();
  const request = await reply('settings-save');
  assert.equal(request.settings.base, 'HEAD');
  assert.equal(request.settings.appearance, 'dark');
});

test('a custom title command that fails after Done leaves no entry', async () => {
  const { nodes, view, toasts, reply, fail, type } = await setup();
  nodes['title-tool'].value = 'custom';
  nodes['title-tool'].onchange();
  type('title-custom-command', 'my-llm');
  assert.equal(nodes['settings-status'].textContent, 'Not saved: Custom title command');
  // Test does not show for a Custom that is not saved.
  assert.ok(nodes['title-test'].hidden);
  nodes['title-custom'].onsubmit(event);
  await tick();
  view.close();
  await fail('title-tool-set', 'Custom is not configured.');
  await reply('settings-get', structuredClone(saved));
  assert.deepEqual(toasts, [['The title tool did not save.', 'Custom is not configured.']]);
  assert.equal(nodes['title-custom-command'].value, '');
  assert.equal(nodes['title-tool'].value, 'none');
  assert.ok(!view.unsaved);
});

test('a removal asks again when the tool became the default tool in another client', async () => {
  const { nodes, pending, reply, toasts } = await setup();
  document.getElementById('tool-remove-b').onclick();
  assert.ok(nodes['tool-remove-default'].hidden);
  nodes['tool-remove-form'].onsubmit(event);
  await tick();
  // The CLI made the tool the default tool. The save conflicts, and the view reads the
  // latest settings.
  const { ConnectionError } = await import('./dist/protocol.js');
  pending.shift().reject(new ConnectionError('settings changed', false, true));
  await tick();
  await reply('settings-get', { ...structuredClone(saved), revision: 5, defaultTool: 'b' });
  assert.equal(pending.length, 0, 'the removal saved without the warning');
  assert.ok(nodes['tool-remove-dialog'].open);
  assert.ok(!nodes['tool-remove-default'].hidden);
  assert.match(nodes['tool-remove-default'].textContent, /“Other” is the default tool/);
  // The user confirms the warning. The removal saves and selects Shell.
  nodes['tool-remove-form'].onsubmit(event);
  await tick();
  const request = await reply('settings-save');
  assert.equal(request.settings.defaultTool, '');
  assert.deepEqual(request.settings.tools, [agent]);
  assert.deepEqual(toasts, []);
});

test('remote access saves both fields with Save and shows the saved values', async () => {
  const { nodes, pending, view, toasts, reply, type } = await setup();
  assert.equal(nodes['settings-remote-status'].textContent, 'Remote access is off.');
  type('settings-remote-host', ' My-Mac.Example.ts.net ');
  type('settings-remote-login', 'user@example.com');
  assert.equal(nodes['settings-status'].textContent, 'Not saved: Remote access');
  assert.equal(pending.length, 0);
  nodes['settings-remote-form'].onsubmit(event);
  await tick();
  // The fields take no edit during the save.
  assert.ok(nodes['settings-remote-host'].disabled && nodes['settings-remote-login'].disabled && nodes['settings-remote-save'].disabled);
  const sent = pending[0].request.settings;
  assert.deepEqual([sent.remoteHost, sent.remoteLogin], ['My-Mac.Example.ts.net', 'user@example.com']);
  // The server saves the host name in lower case.
  await reply('settings-save', { ...sent, remoteHost: 'my-mac.example.ts.net', revision: sent.revision + 1 });
  assert.equal(nodes['settings-remote-host'].value, 'my-mac.example.ts.net');
  assert.equal(nodes['settings-remote-status'].textContent, 'Remote access is on for my-mac.example.ts.net and the Tailscale user user@example.com.');
  assert.ok(!nodes['settings-remote-host'].disabled && !nodes['settings-remote-save'].disabled);
  assert.ok(!view.unsaved);

  // One empty field turns remote access off.
  type('settings-remote-login', '');
  nodes['settings-remote-form'].onsubmit(event);
  await tick();
  await reply('settings-save');
  assert.equal(nodes['settings-remote-status'].textContent, 'Remote access is off. It needs both the host name and the login.');
  assert.deepEqual(toasts, []);
});

test('a remote access save after a change in another view shows that change and does not replace it', async () => {
  const { nodes, pending, view, reply, type } = await setup();
  const { ConnectionError } = await import('./dist/protocol.js');
  const host = 'my-mac.example.ts.net', login = 'user@example.com';
  type('settings-remote-host', host);
  type('settings-remote-login', login);
  nodes['settings-remote-form'].onsubmit(event);
  await tick();
  await reply('settings-save');
  // Another view removes the login. This view then saves an edit of the host only.
  const latest = { ...view.saves.saved, remoteLogin: '', revision: view.saves.saved.revision + 1 };
  type('settings-remote-host', 'other.example.ts.net');
  nodes['settings-remote-form'].onsubmit(event);
  await tick();
  pending.shift().reject(new ConnectionError('settings changed', false, true));
  await tick();
  await reply('settings-get', structuredClone(latest));
  // No second save goes out. The error and the status show the saved values.
  assert.equal(pending.length, 0);
  assert.ok(!nodes['settings-remote-error'].hidden);
  assert.match(nodes['settings-remote-error'].textContent, /^Another view changed remote access\. The saved host name is my-mac\.example\.ts\.net, and the saved login is none\. Click Save again/);
  assert.equal(nodes['settings-remote-status'].textContent, 'Remote access is off. It needs both the host name and the login.');
  // The text stays as an edit.
  assert.deepEqual([nodes['settings-remote-host'].value, nodes['settings-remote-login'].value], ['other.example.ts.net', login]);
  assert.equal(nodes['settings-status'].textContent, 'Not saved: Remote access');
  assert.ok(!nodes['settings-remote-save'].disabled);
  // A second Save replaces the values of the other view.
  nodes['settings-remote-form'].onsubmit(event);
  await tick();
  const sent = pending[0].request.settings;
  assert.deepEqual([sent.revision, sent.remoteHost, sent.remoteLogin], [latest.revision, 'other.example.ts.net', login]);
  await reply('settings-save');
  assert.ok(nodes['settings-remote-error'].hidden);
  assert.ok(!view.unsaved);
});

test('rejected remote access keeps its text, and Done discards it', async () => {
  const { nodes, view, toasts, fail, type, reopen } = await setup();
  const rejection = 'remote host must be a DNS name such as my-mac.example.ts.net, with an optional port';
  type('settings-remote-host', 'localhost');
  nodes['settings-remote-form'].onsubmit(event);
  await tick();
  await fail('settings-save', rejection);
  assert.ok(!nodes['settings-remote-error'].hidden);
  assert.equal(nodes['settings-remote-error'].textContent, rejection);
  assert.equal(nodes['settings-remote-host'].value, 'localhost');
  assert.ok(!nodes['settings-remote-host'].disabled);
  assert.ok(view.unsaved);
  // The new text hides the error of the earlier text.
  type('settings-remote-host', 'localhos');
  assert.ok(nodes['settings-remote-error'].hidden);
  // An edit does not save without Save.
  view.close();
  assert.equal(nodes['settings-remote-host'].value, '');
  assert.ok(!view.unsaved);
  assert.deepEqual(toasts, []);

  // The reply comes after the click on Done.
  await reopen();
  type('settings-remote-host', 'localhost');
  nodes['settings-remote-form'].onsubmit(event);
  await tick();
  view.close();
  await fail('settings-save', rejection);
  assert.deepEqual(toasts, [['Remote access did not save.', rejection]]);
  assert.equal(nodes['settings-remote-host'].value, '');
  assert.ok(!nodes['settings-remote-host'].disabled);
  assert.ok(!view.unsaved);
});

test('each tool has a switch, a built-in tool has no Remove or move, and turning off the default tool selects Shell', async () => {
  const builtin = { id: 'builtin-codex', name: 'Codex', command: 'codex', type: 'codex', model: '', effort: '', builtin: true, enabled: true, path: '' };
  const { nodes, reply, view } = await setup();
  view.saves.update({ ...view.saves.saved, revision: 9, tools: [builtin, agent], defaultTool: 'builtin-codex' });
  assert.equal(document.getElementById('tool-remove-builtin-codex'), null);
  assert.equal(document.getElementById('tool-move-up-builtin-codex'), null);
  assert.ok(document.getElementById('tool-remove-a'));
  // The built-in tools and the custom tools have a table each, and a tool of the user has
  // a switch too.
  assert.match(nodes['settings-builtin-tools'].textContent, /^OnCodex.*Shell/);
  assert.match(nodes['settings-tools'].textContent, /^OnAgent/);
  // A line divides the built-in tools and the custom tools in the menu.
  assert.deepEqual(nodes['settings-tool'].children.map(child => child.tag), ['option', 'option', 'hr', 'option']);
  assert.equal(document.getElementById('tool-switch-a').getAttribute('aria-checked'), 'true');
  // The only tool of the user cannot move, also not above a built-in tool.
  assert.ok(document.getElementById('tool-move-up-a').disabled);
  assert.ok(document.getElementById('tool-move-down-a').disabled);
  const toggle = document.getElementById('tool-switch-builtin-codex');
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  // The check of the open found no CLI, so a built-in tool tells that its CLI is missing.
  assert.match(nodes['settings-builtin-tools'].textContent, /NOT FOUND/);
  toggle.onclick();
  await tick();
  const request = await reply('settings-save');
  assert.equal(request.settings.tools[0].enabled, false);
  assert.equal(request.settings.defaultTool, '');
  // A tool that is off is not a choice for the default tool.
  assert.deepEqual(nodes['settings-tool'].children.filter(child => child.tag === 'option').map(option => option.value), ['', 'a']);
  // A tool of the user turns off the same way and stays saved.
  document.getElementById('tool-switch-a').onclick();
  await tick();
  const off = await reply('settings-save');
  assert.deepEqual(off.settings.tools.map(tool => tool.enabled), [false, false]);
  assert.deepEqual(nodes['settings-tool'].children.filter(child => child.tag === 'option').map(option => option.value), ['']);
});

test('a title tool of an agent CLI waits for Save and test, with its default model', async () => {
  const codex = { id: 'codex', name: 'Codex', command: 'codex exec --model gpt-6-luna -c model_reasoning_effort=low -', type: 'codex',
    prefix: 'codex exec', suffix: ' -', model: 'gpt-6-luna', effort: 'low' };
  const { nodes, pending, reply, view } = await setup([codex]);
  nodes['title-tool'].value = 'codex';
  nodes['title-tool'].onchange();
  await tick();
  // The selection saves nothing. It shows the default model and Save and test.
  assert.ok(!pending.some(call => call.request.operation === 'title-tool-set'));
  assert.ok(!nodes['title-models'].hidden);
  assert.ok(!nodes['title-model-save'].hidden);
  assert.ok(nodes['title-test'].hidden);
  assert.equal(nodes['title-tool-command'].textContent, codex.command);
  assert.equal(nodes['settings-status'].textContent, 'Not saved: Title tool');

  // A failed test keeps the selection and the model, so another model can be tried.
  nodes['title-model'].value = 'gpt-6-sol';
  nodes['title-model'].onchange();
  nodes['title-model-save'].onclick();
  await tick();
  pending.find(call => call.request.operation === 'title-tool-set').reject(new Error('model not found'));
  pending.splice(pending.findIndex(call => call.request.operation === 'title-tool-set'), 1);
  await tick();
  await reply('settings-get', structuredClone(view.saves.saved));
  assert.equal(nodes['title-tool'].value, 'codex');
  assert.ok(!nodes['title-models'].hidden);
  assert.equal(nodes['title-model'].value, 'gpt-6-sol');
  assert.match(nodes['title-test-outcome'].textContent, /model not found/);
  assert.ok(!nodes['title-test-result'].hidden);

  // Another model saves after its test passes.
  nodes['title-model'].value = 'gpt-6-luna';
  nodes['title-model'].onchange();
  nodes['title-model-save'].onclick();
  await tick();
  const set = await reply('title-tool-set', { settings: { ...view.saves.saved, revision: 5, titleTool: 'codex', titleModel: 'gpt-6-luna', titleEffort: 'low' }, title: 'Fix login' });
  assert.deepEqual(set.settings, { titleTool: 'codex', titleCommand: '', titleModel: 'gpt-6-luna', titleEffort: 'low' });
  assert.equal(nodes['settings-status'].textContent, 'All settings saved');
  assert.ok(nodes['title-model-save'].hidden);

  // A model change of the saved tool waits for Save and test too. Test runs only the
  // saved model.
  nodes['title-model'].value = 'gpt-6-sol';
  nodes['title-model'].onchange();
  assert.equal(nodes['settings-status'].textContent, 'Not saved: Title model');
  assert.ok(!nodes['title-model-save'].hidden);
  assert.ok(nodes['title-test'].disabled);
  assert.equal(nodes['title-tool-command'].textContent, 'codex exec --model gpt-6-sol -c model_reasoning_effort=low -');
  nodes['title-model-save'].onclick();
  await tick();
  const saved = await reply('title-tool-set', { settings: { ...view.saves.saved, revision: 6, titleModel: 'gpt-6-sol' }, title: 'Fix login' });
  assert.equal(saved.settings.titleModel, 'gpt-6-sol');
  assert.equal(nodes['settings-status'].textContent, 'All settings saved');
});

test('a built-in tool shows only its CLI path, model, and effort, and a tool of the user has no path', async () => {
  const builtin = { id: 'builtin-codex', name: 'Codex', command: 'codex --no-alt-screen', type: 'codex', model: '', effort: '', builtin: true, enabled: true, path: '' };
  const { nodes, pending, reply, view, type } = await setup();
  view.saves.update({ ...view.saves.saved, revision: 9, tools: [builtin, agent] });
  document.getElementById('tool-edit-a').onclick();
  assert.ok(nodes['tool-path-field'].hidden);
  assert.ok(!nodes['tool-identity'].hidden && !nodes['tool-command-field'].hidden && nodes['tool-builtin-note'].hidden);
  nodes['tool-cancel'].onclick();
  document.getElementById('tool-edit-builtin-codex').onclick();
  // bbflow keeps the name, the type, and the command.
  assert.ok(nodes['tool-identity'].hidden && nodes['tool-command-field'].hidden && !nodes['tool-builtin-note'].hidden);
  assert.ok(!nodes['tool-path-field'].hidden);
  assert.equal(nodes['tool-path'].placeholder, 'codex');
  type('tool-path', ' /opt/homebrew/bin/codex ');
  assert.equal(nodes['settings-status'].textContent, 'Not saved: Edit of Codex');
  // Sessions run the path, with the fixed arguments of Codex.
  assert.equal(nodes['tool-preview'].textContent, '/opt/homebrew/bin/codex --no-alt-screen');
  nodes['tool-editor'].onsubmit(event);
  await tick();
  const request = await reply('settings-save');
  assert.equal(request.settings.tools[0].path, '/opt/homebrew/bin/codex');
  assert.equal(request.settings.tools[0].name, 'Codex');
  // The page then asks again for the CLI check and the title commands.
  assert.ok(pending.some(call => call.request.operation === 'tool-check'));
  assert.ok(pending.some(call => call.request.operation === 'title-tools'));
});

test('Shell has a switch in the built-in tools, and turning it off removes it from Default tool', async () => {
  const { nodes, reply, view } = await setup();
  view.saves.update({ ...view.saves.saved, revision: 9, defaultTool: '' });
  const toggle = document.getElementById('tool-switch-shell');
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.equal(document.getElementById('tool-edit-'), null, 'Shell has nothing to edit');
  assert.deepEqual(nodes['settings-tool'].children.filter(child => child.tag === 'option').map(option => option.value), ['', 'a', 'b']);
  toggle.onclick();
  await tick();
  const request = await reply('settings-save');
  assert.equal(request.settings.shellOff, true);
  assert.equal(request.settings.defaultTool, 'a');
  assert.deepEqual(nodes['settings-tool'].children.filter(child => child.tag === 'option').map(option => option.value), ['a', 'b']);
  assert.equal(document.getElementById('tool-switch-shell').getAttribute('aria-checked'), 'false');
});

test('Refresh list in one picker reaches the other pickers of the same type', async () => {
  const codex = { id: 'codex', name: 'Codex', command: 'codex exec -', type: 'codex', prefix: 'codex exec', suffix: ' -', model: '', effort: '' };
  const builtin = { id: 'builtin-codex', name: 'Codex', command: 'codex --no-alt-screen', type: 'codex', model: '', effort: '', builtin: true, enabled: true, path: '' };
  const { nodes, pending, reply, view } = await setup([codex]);
  view.saves.update({ ...view.saves.saved, revision: 9, tools: [builtin, agent] });
  const list = id => ({ type: 'codex', source: 'codex debug models', loaded: 'now', efforts: [], models: [{ id, name: id, efforts: [] }] });
  const models = id => nodes[id].children.map(option => option.value);
  nodes['title-tool'].value = 'codex';
  nodes['title-tool'].onchange();
  await reply('tool-models', list('model-a'));
  assert.ok(models('title-model').includes('model-a'));
  // The tool editor refreshes the list of the same type.
  document.getElementById('tool-edit-builtin-codex').onclick();
  await tick();
  assert.ok(!pending.some(call => call.request.operation === 'tool-models'), 'the editor reads the shared list');
  nodes['tool-model-refresh'].onclick();
  const refresh = await reply('tool-models', list('model-b'));
  assert.equal(refresh.refresh, true);
  assert.ok(models('tool-model').includes('model-b'));
  nodes['tool-cancel'].onclick();
  // The title picker reads the refreshed list at its next selection.
  nodes['title-tool'].value = 'codex';
  nodes['title-tool'].onchange();
  await tick();
  assert.ok(models('title-model').includes('model-b'));
  assert.ok(!models('title-model').includes('model-a'));
});
