import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionMenu } from './dist/action-menu.js';

// A small fake DOM. A node keeps its event listeners, and the menu lists its buttons.
class Node {
  hidden = false; disabled = false; dataset = {}; children = []; parent = null; listeners = {};
  constructor(name = '') { this.name = name; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  setAttribute() {}
  contains(node) { for (; node; node = node.parent) if (node === this) return true; return false; }
  querySelectorAll() { return this.children; }
  // A disabled button takes no focus, as in a browser.
  focus() { if (!this.disabled) document.activeElement = this; }
}

function fixture(t) {
  const nodes = { 'menu-box': new Node(), 'menu-open': new Node('open'), menu: new Node(), 'menu-status': new Node() };
  nodes['menu-box'].append(nodes['menu-open'], nodes.menu);
  const items = ['Attach', 'Handoff', 'Review', 'Manage'].map(name => new Node(name));
  nodes.menu.append(...items);
  const globals = { HTMLElement: Node, HTMLButtonElement: Node,
    document: { getElementById: id => nodes[id], addEventListener() {}, activeElement: null } };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  const menu = new ActionMenu('menu');
  const key = name => { for (const listener of nodes['menu-box'].listeners.keydown) listener({ key: name, preventDefault() {} }); };
  return { nodes, items, menu, key, focused: () => document.activeElement?.name };
}

test('the arrow keys skip the items that are off', t => {
  const { nodes, items, key, focused } = fixture(t);
  // A pending send turns off Attach and the saved prompt.
  items[0].disabled = items[2].disabled = true;
  nodes['menu-open'].onclick();
  assert.equal(focused(), 'Handoff', 'the menu opens at the first item that is on');
  key('ArrowDown');
  assert.equal(focused(), 'Manage');
  key('ArrowDown');
  assert.equal(focused(), 'Handoff');
  key('ArrowUp');
  assert.equal(focused(), 'Manage');
  key('Escape');
  assert.ok(nodes.menu.hidden);
  assert.equal(focused(), 'open');
});

test('an arrow key from the menu button goes to the first or the last item that is on', t => {
  const { nodes, items, key, focused } = fixture(t);
  items[3].disabled = true;
  nodes['menu-open'].onclick();
  nodes['menu-open'].focus();
  key('ArrowUp');
  assert.equal(focused(), 'Review');
  nodes['menu-open'].focus();
  key('ArrowDown');
  assert.equal(focused(), 'Attach');
});
