import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RowMenus } from './dist/row-menu.js';

// A small element: enough for RowMenus to build a menu and for the list to hold it.
class Element {
  children = [];
  attributes = new Map();
  dataset = {};
  hidden = false;
  className = '';
  textContent = '';
  title = '';
  #classes = new Set();
  constructor(tag) { this.tag = tag; }
  get classList() {
    return { add: name => this.#classes.add(name), remove: name => this.#classes.delete(name), contains: name => this.#classes.has(name) };
  }
  set innerHTML(html) { this.html = html; }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  addEventListener() {}
}

// The page holds the boxes of the shown list. A list refresh replaces them.
function setup() {
  let shown = [];
  globalThis.document = {
    createElement: tag => new Element(tag),
    addEventListener() {},
    querySelectorAll(selector) {
      const buttons = shown.map(box => box.children[0]);
      if (selector === '.row-menu-box > button') return buttons;
      if (selector === '.row-menu-box > .tip-open') return buttons.filter(button => button.classList.contains('tip-open'));
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  const status = new Element('span');
  const menus = new RowMenus(() => {}, status);
  const look = { className: 'project-action', text: '⋯' };
  const actions = [
    { label: 'Edit', run() {} },
    { label: 'Copy folder path', run() {} },
    { label: 'Search this project', run() {} },
    { label: 'Remove project', danger: true, divider: true, run() {} },
  ];
  const render = () => {
    const menu = menus.create('Orbit API', 'project-menu:p1', actions, look);
    const other = menus.create('Tide Web', 'project-menu:p2', actions, look);
    shown = [menu.box, other.box];
    return { menu, other };
  };
  return { menus, status, render };
}

test('a project menu keeps the order of its items and puts the divider above Remove project', () => {
  const { render } = setup();
  const { menu } = render();
  assert.equal(menu.button.className, 'project-action');
  assert.equal(menu.button.textContent, '⋯');
  assert.equal(menu.button.title, 'Actions for Orbit API');
  const list = menu.box.children[1];
  assert.deepEqual(list.children.map(child => child.getAttribute('role') === 'separator' ? '---' : child.textContent),
    ['Edit', 'Copy folder path', 'Search this project', '---', 'Remove project']);
  assert.deepEqual(menu.items.map(item => item.className), ['', '', '', 'danger']);
});

test('a confirmation shows on the button of its key and stays after a list refresh', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { menus, status, render } = setup();
    render();
    menus.confirm('project-menu:p1', 'Folder path copied');
    // A refresh replaced the buttons before the copy ended. The new button shows it.
    const { menu, other } = render();
    assert.equal(menu.button.dataset.tip, 'Folder path copied');
    assert.equal(menu.button.classList.contains('tip-open'), true);
    assert.equal(other.button.dataset.tip, undefined);
    assert.equal(status.textContent, 'Folder path copied');
    mock.timers.tick(1800);
    assert.equal(menu.button.dataset.tip, undefined);
    assert.equal(menu.button.classList.contains('tip-open'), false);
    assert.equal(status.textContent, '');
    // After the confirmation ends, a refresh shows no tooltip.
    assert.equal(render().menu.button.dataset.tip, undefined);
  } finally { mock.timers.reset(); }
});

test('a confirmation marks the button that shows now', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { menus, render } = setup();
    const { menu } = render();
    menus.confirm('project-menu:p1', 'Folder path copied');
    assert.equal(menu.button.dataset.tip, 'Folder path copied');
    // A second confirmation replaces the first one.
    menus.confirm('project-menu:p2', 'Folder path copied');
    assert.equal(menu.button.dataset.tip, undefined);
  } finally { mock.timers.reset(); }
});
