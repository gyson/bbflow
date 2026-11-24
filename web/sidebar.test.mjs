import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sidebar, nearestRow, sidebarBounds } from './dist/sidebar.js';

test('a wide window allows sidebar widths from 240 to 480 pixels', () => {
  assert.deepEqual(sidebarBounds(1600), { min: 240, max: 480 });
});

test('a narrower window keeps 400 pixels for the main area', () => {
  assert.deepEqual(sidebarBounds(800), { min: 240, max: 400 });
});

test('the maximum width is never less than the minimum width', () => {
  assert.deepEqual(sidebarBounds(600), { min: 240, max: 240 });
});

test('focus goes to the nearest later row after a row leaves the list', () => {
  assert.equal(nearestRow(['a', 'b', 'c'], 'b', ['a', 'c']), 'c');
});

test('focus goes to the nearest earlier row when no later row shows', () => {
  assert.equal(nearestRow(['a', 'b', 'c'], 'c', ['a', 'b']), 'b');
  // A later row that the new list does not show is skipped.
  assert.equal(nearestRow(['a', 'b', 'c', 'd'], 'b', ['a', 'd']), 'd');
  assert.equal(nearestRow(['a', 'b', 'c'], 'b', ['a']), 'a');
});

test('no row gets the focus when the new list shows none of the earlier rows', () => {
  assert.equal(nearestRow(['a'], 'a', []), undefined);
  assert.equal(nearestRow(['a', 'b'], 'a', ['x']), undefined);
});

// A small fake DOM. It has only the parts that the sidebar uses. A node takes the focus
// only when it and its ancestors are not hidden and not inert.
class Node {
  hidden = false;
  inert = false;
  tabIndex = 0;
  isConnected = true;
  dataset = {};
  // The style holds the custom properties that the sidebar sets.
  properties = new Map();
  style = { removeProperty: key => this.properties.delete(key), setProperty: (key, value) => this.properties.set(key, value) };
  attributes = new Map();
  parent = null;
  children = [];
  // The node that querySelector finds: the row of the selected session.
  found = null;
  add(child) { child.parent = this; this.children.push(child); return child; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getBoundingClientRect() { return { width: 300 }; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelector() { return this.found; }
  focus() {
    for (let node = this; node; node = node.parent) if (node.hidden || node.inert) return;
    document.activeElement = this;
  }
}

function setup({ narrow = true, home = false } = {}) {
  const nodes = Object.fromEntries(['sidebar', 'sidebar-scrim', 'sidebar-divider', 'sidebar-toggle'].map(id => [id, new Node()]));
  const main = new Node();
  main.add(nodes['sidebar-toggle']);
  const terminal = main.add(new Node());
  const row = nodes.sidebar.add(new Node());
  nodes.sidebar.found = row;
  const listeners = { window: [], document: [] };
  globalThis.HTMLElement = globalThis.HTMLButtonElement = Node;
  globalThis.window = { addEventListener(type, listener) { listeners.window.push([type, listener]); } };
  globalThis.document = {
    activeElement: null,
    body: { classList: { add() {}, remove() {} } },
    documentElement: { clientWidth: narrow ? 390 : 1400, dataset: { sidebarWidth: 'normal' } },
    getElementById: id => nodes[id],
    querySelector: selector => selector === 'main' ? main : null,
    addEventListener(type, listener) { listeners.document.push([type, listener]); },
  };
  globalThis.matchMedia = () => ({ matches: narrow, addEventListener() {} });
  const sidebar = new Sidebar(() => home);
  // Send a keydown event to the listeners of the window or the document.
  const key = (target, init) => {
    const event = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, defaultPrevented: false, ...init };
    event.preventDefault = () => { event.defaultPrevented = true; };
    for (const [type, listener] of listeners[target]) if (type === 'keydown') listener(event);
  };
  const commandB = () => key('window', { metaKey: true, key: 'b' });
  return { nodes, main, terminal, row, key, commandB, sidebar };
}

test('the open drawer takes the focus, and the main area under it takes no input', () => {
  const { nodes, main, terminal, row, key, commandB } = setup();
  assert.equal(nodes.sidebar.hidden, true, 'the drawer starts closed outside the welcome view');
  terminal.focus();

  commandB();
  assert.equal(nodes.sidebar.hidden, false);
  assert.equal(main.inert, true);
  assert.equal(document.activeElement, row, 'the row of the selected session gets the focus');
  terminal.focus();
  assert.equal(document.activeElement, row, 'the terminal under the drawer cannot take the focus');

  key('document', { key: 'Escape' });
  assert.equal(nodes.sidebar.hidden, true);
  assert.equal(main.inert, false);
  assert.equal(document.activeElement, terminal, 'the focus goes back to the terminal');
});

test('a click outside the drawer gives the focus back, and a removed control gives it to the toolbar button', () => {
  const { nodes, terminal, commandB } = setup();
  terminal.focus();
  commandB();
  // A click on the scrim moves the focus to the page body.
  document.activeElement = document.body;
  nodes['sidebar-scrim'].onclick();
  assert.equal(document.activeElement, terminal);

  commandB();
  terminal.isConnected = false;
  commandB();
  assert.equal(document.activeElement, nodes['sidebar-toggle']);
});

test('the drawer itself gets the focus when no row is selected', () => {
  const { nodes, terminal, commandB } = setup();
  nodes.sidebar.found = null;
  terminal.focus();
  commandB();
  assert.equal(document.activeElement, nodes.sidebar);
  assert.equal(nodes.sidebar.tabIndex, -1);
});

test('the sidebar of the regular layout leaves the main area available', () => {
  const { nodes, main, row, commandB } = setup({ narrow: false });
  assert.equal(nodes.sidebar.hidden, false);
  assert.equal(main.inert, false);
  row.focus();
  commandB();
  assert.equal(nodes.sidebar.hidden, true);
  assert.equal(main.inert, false);
  assert.equal(document.activeElement, nodes['sidebar-toggle'], 'the focus goes to the toolbar button');
});

test('a new preset replaces the width of a drag, and the same preset keeps it', () => {
  const { nodes, sidebar } = setup({ narrow: false });
  const end = { key: 'End', preventDefault() {} };
  nodes['sidebar-divider'].onkeydown(end);
  assert.equal(nodes.sidebar.properties.get('--sidebar-width'), '480px');
  sidebar.setPreset('normal');
  assert.equal(nodes.sidebar.properties.get('--sidebar-width'), '480px', 'the saved preset did not change');
  sidebar.setPreset('wide');
  assert.equal(document.documentElement.dataset.sidebarWidth, 'wide');
  assert.ok(!nodes.sidebar.properties.has('--sidebar-width'), 'the sidebar uses the width of the preset');
});
