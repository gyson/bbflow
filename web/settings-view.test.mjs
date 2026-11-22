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
  // The view asks only for the rows of the saved tools.
  querySelectorAll() { return this.children.filter(child => child.tag === 'div' && child.className === 'tool-row'); }
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

const editors = ['add-tool', 'edit-tool'];
const ids = ['settings-view', 'settings-form', 'settings-appearance', 'settings-tool', 'settings-worktree', 'settings-base',
  'settings-update-check', 'settings-port-form', 'settings-port', 'settings-port-error', 'settings-port-status',
  'settings-error', 'settings-status', 'settings-tools', 'tool-error', 'tool-remove-dialog', 'tool-remove-form',
  'cancel-tool-remove', 'tool-remove-summary', 'tool-remove-default', 'title-settings', 'title-tool', 'title-spinner',
  'title-builtin', 'title-tool-command', 'title-custom', 'title-custom-command', 'title-custom-save', 'title-test',
  'title-test-result', 'title-test-sample', 'title-test-outcome', 'title-test-detail'];
const agent = { id: 'a', name: 'Agent', command: 'agent' };
const other = { id: 'b', name: 'Other', command: 'other' };
const saved = { revision: 4, appearance: 'system', defaultTool: '', worktree: false, base: 'HEAD', tools: [agent, other],
  titleTool: 'none', titleCommand: '', updateCheck: true, port: 0 };
const server = { protocol: 'test', instance: 'test', port: 50000, dataDir: '/fixture' };
const event = { preventDefault() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));

// setup opens the Settings view with the saved settings. Each server call waits in
// pending until the fixture sends its reply with reply or fail.
async function setup() {
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  for (const prefix of editors) {
    const form = nodes[`${prefix}-editor`] = new Node('form');
    for (const part of ['name', 'command', 'submit', 'cancel', 'error']) {
      const node = nodes[`${prefix}-${part}`] = new Node();
      form.append(node);
    }
    nodes[`${prefix}-error`].hidden = true;
    nodes['settings-tools'].append(form);
  }
  for (const id of ['settings-port-error', 'settings-error', 'tool-error', 'title-test-result']) nodes[id].hidden = true;
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
    getElementById: id => nodes[id] ?? nodes['settings-tools'].find(id),
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
  await reply('title-tools', { tools: [{ id: 'codex', name: 'Codex', command: 'codex exec' }], sample: 'Sample' });
  await reply('settings-get', structuredClone(saved));
  await opening;
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
  };
  return { nodes, pending, view, toasts, reply, fail, type, reopen };
}

test('a tool save that fails after Done shows a toast that names the action', async () => {
  const { nodes, view, toasts, fail, type, reopen } = await setup();
  type('add-tool-name', 'Temp');
  type('add-tool-command', 'temp');
  assert.equal(nodes['settings-status'].textContent, 'Not saved: New tool');
  nodes['add-tool-editor'].onsubmit(event);
  await tick();
  // The user clicks Done before the reply. The close clears the row.
  view.close();
  await fail('settings-save', 'database is locked');
  assert.deepEqual(toasts, [['The new tool “Temp” did not save.', 'database is locked']]);
  assert.ok(nodes['add-tool-error'].hidden, 'the error went to the hidden row');
  assert.equal(nodes['add-tool-name'].value, '');
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
  type('add-tool-name', 'Temp');
  type('add-tool-command', 'temp');
  nodes['add-tool-editor'].onsubmit(event);
  await tick();
  view.close();
  await reopen();
  await fail('settings-save', 'database is locked');
  assert.equal(toasts.length, 4);
  assert.ok(nodes['add-tool-error'].hidden);
});

test('a tool save that fails in Settings shows its error in the row', async () => {
  const { nodes, toasts, fail, type } = await setup();
  type('add-tool-name', 'Temp');
  type('add-tool-command', 'temp');
  nodes['add-tool-editor'].onsubmit(event);
  await tick();
  await fail('settings-save', 'database is locked');
  assert.deepEqual(toasts, []);
  assert.ok(!nodes['add-tool-error'].hidden);
  assert.equal(nodes['add-tool-error'].textContent, 'database is locked');
  // An error keeps the entered values.
  assert.equal(nodes['add-tool-name'].value, 'Temp');
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
