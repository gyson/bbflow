import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComposerMenu, summary } from './dist/composer-menu.js';
import { VERSION } from './dist/protocol.js';

const server = { protocol: VERSION, instance: 'fixture', dataDir: '/fixture', port: 1234 };
const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 2)); };

// A small fake DOM and a fake server. Each settings-get reply comes from replies, or
// fails when replies has no entry.
async function fixture(t, replies) {
  class Node {
    hidden = false; disabled = false; textContent = ''; title = ''; className = ''; type = '';
    children = []; parent = null; dataset = {}; attributes = new Map();
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes.set(key, value); }
    addEventListener() {}
    contains(node) { for (; node; node = node.parent) if (node === this) return true; return false; }
    querySelectorAll() { return []; }
    focus() { document.activeElement = this; }
  }
  const ids = ['composer-menu-box', 'composer-menu-open', 'composer-menu', 'composer-menu-status', 'composer-attach', 'composer-prompts', 'composer-prompts-note', 'composer-prompts-manage'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  nodes['composer-menu-box'].append(nodes['composer-menu-open'], nodes['composer-menu']);
  nodes['composer-menu'].append(nodes['composer-attach'], nodes['composer-prompts'], nodes['composer-prompts-note'], nodes['composer-prompts-manage']);
  class Socket {
    readyState = 1;
    bufferedAmount = 0;
    constructor() { queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'server', server }) })); }
    send(text) {
      const { request } = JSON.parse(text);
      if (request?.operation !== 'settings-get') return;
      const prompts = replies.shift();
      queueMicrotask(() => this.onmessage({ data: JSON.stringify(prompts ? { type: 'result', result: { prompts } } : { type: 'error', error: 'database is locked' }) }));
    }
    close() { this.readyState = 3; }
  }
  const globals = { WebSocket: Socket, location: { host: 'localhost:1234' }, HTMLElement: Node, HTMLButtonElement: Node,
    document: { getElementById: id => nodes[id], createElement: () => new Node(), addEventListener() {}, activeElement: null } };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  const host = { blocked: undefined, inserted: [], problems: [], managed: 0 };
  const menu = new ComposerMenu({
    server: () => server,
    blocked: () => host.blocked,
    insert: text => { host.inserted.push(text); return host.blocked; },
    problem: text => host.problems.push(text),
    manage: () => { host.managed++; },
  });
  // open clicks ＋ when the menu is closed, and close clicks it when the menu is open.
  const toggle = () => nodes['composer-menu-open'].onclick();
  const items = () => nodes['composer-prompts'].children.map(item => item.children.map(part => part.textContent));
  return { nodes, menu, host, toggle, items };
}

const review = { id: 'p1', name: 'Review PR', text: 'Use the review-loop skill as the reviewer for PR #' };
const summarize = { id: 'p2', name: 'Summarize the branch', text: 'Summarize the changes on this branch against main.\n\nList the risks.' };

test('the menu shows the saved prompts of the latest read, and an item inserts the whole text', async t => {
  const { nodes, host, toggle, items } = await fixture(t, [[review], [review, summarize]]);
  toggle();
  assert.equal(nodes['composer-prompts-note'].textContent, 'Loading the saved prompts…');
  await settle();
  assert.deepEqual(items(), [['Review PR', review.text]]);
  assert.ok(nodes['composer-prompts-note'].hidden);
  toggle();
  // Another view added a prompt. The next open shows the last read at once, then the new one.
  toggle();
  assert.deepEqual(items(), [['Review PR', review.text]]);
  await settle();
  assert.deepEqual(items(), [['Review PR', review.text], ['Summarize the branch', 'Summarize the changes on this branch against main. List the risks.']]);
  nodes['composer-prompts'].children[1].onclick();
  assert.deepEqual(host.inserted, [summarize.text]);
  nodes['composer-prompts-manage'].onclick();
  assert.equal(host.managed, 1);
});

test('the items wait while text cannot go into the editor, and the note tells why', async t => {
  const { nodes, host, toggle, items } = await fixture(t, [[review], []]);
  host.blocked = 'A send may have reached the terminal. Check the terminal and unlock the draft first.';
  toggle();
  await settle();
  assert.deepEqual(items(), [['Review PR', review.text]]);
  assert.ok(nodes['composer-prompts'].children[0].disabled);
  assert.equal(nodes['composer-prompts-note'].textContent, host.blocked);
  // An insert that the editor refuses at the click shows the problem in the editor.
  nodes['composer-prompts'].children[0].onclick();
  assert.deepEqual(host.problems, [host.blocked]);
  toggle();
  host.blocked = undefined;
  toggle();
  await settle();
  assert.deepEqual(items(), []);
  assert.equal(nodes['composer-prompts-note'].textContent, 'No saved prompts yet. Add one with Manage prompts.');
});

test('a failed first read tells that the prompts are not available, and a later failure keeps the list', async t => {
  const { nodes, toggle, items } = await fixture(t, []);
  toggle();
  await settle();
  assert.match(nodes['composer-prompts-note'].textContent, /Cannot read the saved prompts/);
  toggle();
  const second = await fixture(t, [[review]]);
  second.toggle();
  await settle();
  second.toggle();
  second.toggle();
  await settle();
  assert.deepEqual(second.items(), [['Review PR', review.text]]);
  assert.ok(second.nodes['composer-prompts-note'].hidden);
  assert.deepEqual(items(), []);
});

test('an open menu follows the lock of the draft, also with an empty list', async t => {
  const { nodes, menu, host, toggle } = await fixture(t, [[review, summarize], []]);
  toggle();
  await settle();
  const prompts = nodes['composer-prompts'].children;
  prompts[1].focus();
  // Another view sends the draft. The editor reports its controls, and the items go off.
  host.blocked = 'A send may have reached the terminal. Check the terminal and unlock the draft first.';
  menu.update();
  assert.ok(prompts.every(item => item.disabled));
  assert.equal(nodes['composer-prompts-note'].textContent, host.blocked);
  assert.ok(!nodes['composer-prompts-note'].hidden);
  assert.equal(document.activeElement, nodes['composer-prompts-manage'], 'the focus stays in the menu');
  // The user unlocks the draft. The items come back on, and the note goes.
  host.blocked = undefined;
  menu.update();
  assert.ok(prompts.every(item => !item.disabled));
  assert.ok(nodes['composer-prompts-note'].hidden);
  // Without prompts, the note tells why Attach files is off, then that no prompt is saved.
  toggle();
  toggle();
  await settle();
  host.blocked = 'Wait for the current action to finish.';
  menu.update();
  assert.equal(nodes['composer-prompts-note'].textContent, 'Wait for the current action to finish.');
  host.blocked = undefined;
  menu.update();
  assert.equal(nodes['composer-prompts-note'].textContent, 'No saved prompts yet. Add one with Manage prompts.');
});

test('the lock keeps the focus in the menu when it turns off Attach files', async t => {
  const { nodes, menu, host, toggle } = await fixture(t, [[review]]);
  toggle();
  await settle();
  // The menu opens with the focus on Attach files, its first item.
  nodes['composer-attach'].focus();
  // A send from another view locks the draft. The editor turns off Attach files first,
  // then it reports its controls.
  nodes['composer-attach'].disabled = true;
  host.blocked = 'A send may have reached the terminal. Check the terminal and unlock the draft first.';
  menu.update();
  assert.equal(document.activeElement, nodes['composer-prompts-manage'], 'Escape still reaches the menu');
  // The host turns off Handoff prompt during an action. Its controls keep the focus too.
  const handoff = new nodes['composer-menu'].constructor();
  nodes['composer-menu'].append(handoff);
  handoff.focus();
  handoff.disabled = true;
  menu.controls();
  assert.equal(document.activeElement, nodes['composer-prompts-manage']);
  // A focus outside the menu stays where it is.
  const editor = new nodes['composer-menu'].constructor();
  editor.focus();
  editor.disabled = true;
  menu.update();
  assert.equal(document.activeElement, editor);
});

test('a read keeps the focus on the same prompt after another view changed the order', async t => {
  const { nodes, toggle } = await fixture(t, [[review, summarize], [summarize, review], [summarize]]);
  toggle();
  await settle();
  toggle();
  // The menu opens with the last read. The user moves to Review PR before the reply.
  toggle();
  nodes['composer-prompts'].children[0].focus();
  assert.equal(document.activeElement.dataset.promptId, 'p1');
  await settle();
  assert.deepEqual(nodes['composer-prompts'].children.map(item => item.dataset.promptId), ['p2', 'p1']);
  assert.equal(document.activeElement.dataset.promptId, 'p1', 'Enter still inserts Review PR');
  toggle();
  // Another view removed the focused prompt. Manage prompts gets the focus.
  toggle();
  nodes['composer-prompts'].children[1].focus();
  await settle();
  assert.equal(document.activeElement, nodes['composer-prompts-manage']);
});

test('a menu item shows the text of a prompt on one line, cut at the limit', () => {
  assert.equal(summary('  one\n\n\ttwo  ', 20), 'one two');
  assert.equal(summary('abcdefghij', 10), 'abcdefghij');
  assert.equal(summary('abcde fghijk', 10), 'abcde fgh…');
  assert.equal(summary('abcd   efghijk', 6), 'abcd…');
});
