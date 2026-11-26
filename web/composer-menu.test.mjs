import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComposerMenu, matches, summary } from './dist/composer-menu.js';
import { VERSION } from './dist/protocol.js';

const server = { protocol: VERSION, instance: 'fixture', dataDir: '/fixture', port: 1234 };
const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 2)); };

// A small fake DOM and a fake server. Each settings-get reply comes from replies, or
// fails when replies has no entry. A reply is a list of prompts, or the prompts and the
// groups. room gives the menu the room for a flyout at its right.
async function fixture(t, replies, room = false) {
  class Node {
    hidden = false; disabled = false; textContent = ''; title = ''; className = ''; type = ''; value = '';
    children = []; parent = null; dataset = {}; attributes = new Map(); listeners = {}; style = {}; offsetHeight = 0; scrollTop = 0;
    classList = { toggle: (name, on) => { this.className = on ? `${this.className} ${name}`.trim() : this.className.replace(name, '').trim(); }, remove: name => this.classList.toggle(name, false) };
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    contains(node) { for (; node; node = node.parent) if (node === this) return true; return false; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { top: 100, right: 400, height: 300 }; }
    focus() { document.activeElement = this; }
    closest() { return this; }
    click() { this.onclick?.({ detail: 1, stopPropagation() {} }); }
  }
  const ids = ['composer-menu-box', 'composer-menu-open', 'composer-menu', 'composer-menu-status', 'composer-prompt-filter-box', 'composer-prompt-filter',
    'composer-menu-actions', 'composer-attach', 'composer-prompts-label', 'composer-prompts', 'composer-prompts-note', 'composer-prompts-manage', 'composer-flyout'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  nodes['composer-menu-box'].append(nodes['composer-menu-open'], nodes['composer-menu']);
  nodes['composer-prompt-filter-box'].hidden = nodes['composer-flyout'].hidden = true;
  nodes['composer-prompt-filter-box'].append(nodes['composer-prompt-filter']);
  nodes['composer-menu-actions'].append(nodes['composer-attach']);
  nodes['composer-menu'].append(nodes['composer-prompt-filter-box'], nodes['composer-menu-actions'], nodes['composer-prompts-label'], nodes['composer-prompts'],
    nodes['composer-prompts-note'], nodes['composer-prompts-manage'], nodes['composer-flyout']);
  class Socket {
    readyState = 1;
    bufferedAmount = 0;
    constructor() { queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'server', server }) })); }
    send(text) {
      const { request } = JSON.parse(text);
      if (request?.operation !== 'settings-get') return;
      const entry = replies.shift();
      const result = Array.isArray(entry) ? { prompts: entry, promptGroups: [] } : entry;
      queueMicrotask(() => this.onmessage({ data: JSON.stringify(result ? { type: 'result', result } : { type: 'error', error: 'database is locked' }) }));
    }
    close() { this.readyState = 3; }
  }
  const globals = { WebSocket: Socket, location: { host: 'localhost:1234' }, HTMLElement: Node, HTMLButtonElement: Node,
    HTMLInputElement: Node, Element: Node,
    document: { getElementById: id => nodes[id], createElement: () => new Node(), addEventListener() {}, activeElement: null, documentElement: { clientWidth: room ? 1200 : 500 } } };
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
  const items = (parent = 'composer-prompts') => nodes[parent].children.map(item => item.children.length ? item.children.map(part => part.textContent) : item.textContent);
  // key sends a key to the menu, as a keydown on the focused element.
  const key = name => {
    const event = { key: name, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    for (const listener of nodes['composer-menu'].listeners.keydown) listener(event);
    return event.prevented;
  };
  // point sends a mouse pointerover on item to the menu, and leave sends a pointerleave.
  const point = item => { for (const listener of nodes['composer-menu'].listeners.pointerover) listener({ pointerType: 'mouse', target: item }); };
  const leave = () => { for (const listener of nodes['composer-menu'].listeners.pointerleave) listener({}); };
  return { nodes, menu, host, toggle, items, key, point, leave };
}

const review = { id: 'p1', name: 'Review PR', text: 'Use the review-loop skill as the reviewer for PR #', group: '' };
const summarize = { id: 'p2', name: 'Summarize the branch', text: 'Summarize the changes on this branch against main.\n\nList the risks.', group: '' };

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

// Settings with a prompt at the top level and two groups. A group without prompts does
// not show in the menu.
const git = { id: 'g', name: 'Git and PRs' };
const tests = { id: 't', name: 'Tests' };
const empty = { id: 'e', name: 'Empty' };
const commit = { id: 'c', name: 'Commit', text: 'Commit the work with a clear message.', group: 'g' };
const race = { id: 'r', name: 'Race', text: 'Run the race detector on the tests.', group: 't' };
const pr = { id: 'd', name: 'Write the PR description', text: 'Describe why, what, and how.', group: 'g' };
const grouped = { prompts: [review, commit, race, pr], promptGroups: [git, empty, tests] };

test('the menu shows the prompts without a group, then one item for each group with prompts', async t => {
  const { nodes, toggle, items } = await fixture(t, [grouped]);
  toggle();
  await settle();
  assert.deepEqual(items(), [['Review PR', review.text], ['Git and PRs', '›'], ['Tests', '›']]);
  assert.ok(!nodes['composer-prompts-label'].hidden);
  assert.ok(!nodes['composer-prompt-filter-box'].hidden);
  assert.equal(nodes['composer-prompts'].children[1].getAttribute('aria-haspopup'), 'menu');
});

test('without room for a flyout, a group replaces the items, and Back or Escape returns to the group', async t => {
  const { nodes, host, toggle, items, key } = await fixture(t, [grouped]);
  toggle();
  await settle();
  nodes['composer-prompts'].children[1].click();
  assert.deepEqual(items(), ['‹ Git and PRs', ['Commit', commit.text], ['Write the PR description', pr.text]]);
  assert.ok(nodes['composer-menu-actions'].hidden && nodes['composer-prompts-label'].hidden);
  assert.ok(nodes['composer-flyout'].hidden);
  assert.equal(document.activeElement.dataset.promptId, 'c', 'the first prompt of the group has the focus');
  document.activeElement.click();
  assert.deepEqual(host.inserted, [commit.text]);
  // Back returns to the items of the menu, with the focus on the group.
  nodes['composer-prompts'].children[0].click();
  assert.equal(items().length, 3);
  assert.ok(!nodes['composer-menu-actions'].hidden);
  assert.equal(document.activeElement.dataset.groupId, 'g');
  // The Right key opens the group. Left and Escape return.
  assert.ok(key('ArrowRight'));
  assert.equal(document.activeElement.dataset.promptId, 'c');
  assert.ok(key('Escape'));
  assert.equal(document.activeElement.dataset.groupId, 'g');
  assert.ok(!key('Escape'), 'a second Escape reaches the action menu, which closes the menu');
});

test('with room, a group opens a flyout at the right, and Left or Escape closes it', async t => {
  const { nodes, host, toggle, items, key } = await fixture(t, [grouped], true);
  toggle();
  await settle();
  const row = nodes['composer-prompts'].children[2];
  // A click opens the flyout and keeps the focus on the group.
  row.click();
  assert.ok(!nodes['composer-flyout'].hidden);
  assert.deepEqual(items('composer-flyout'), [['Race', race.text]]);
  assert.equal(nodes['composer-flyout'].getAttribute('aria-label'), 'Tests');
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, row);
  assert.equal(items().length, 3, 'the items of the menu stay');
  // Down closes the flyout and moves to the next item. Right opens a group with the
  // focus on its first prompt.
  nodes['composer-prompts'].children[1].focus();
  assert.ok(key('ArrowRight'));
  assert.deepEqual(items('composer-flyout'), [['Commit', commit.text], ['Write the PR description', pr.text]]);
  assert.equal(document.activeElement.dataset.promptId, 'c');
  assert.ok(key('ArrowDown'));
  assert.equal(document.activeElement.dataset.promptId, 'd');
  assert.ok(key('ArrowDown'));
  assert.equal(document.activeElement.dataset.promptId, 'c', 'Down stays in the flyout');
  assert.ok(key('ArrowLeft'));
  assert.ok(nodes['composer-flyout'].hidden);
  assert.equal(document.activeElement.dataset.groupId, 'g');
  assert.ok(key('ArrowRight'));
  assert.ok(key('Escape'));
  assert.ok(nodes['composer-flyout'].hidden);
  assert.equal(document.activeElement.dataset.groupId, 'g');
  // A prompt of the flyout goes in at the cursor.
  key('ArrowRight');
  nodes['composer-flyout'].children[1].click();
  assert.deepEqual(host.inserted, [pr.text]);
});

test('the filter searches every group, and Enter inserts the first match', async t => {
  const { nodes, host, toggle, items, key } = await fixture(t, [grouped]);
  toggle();
  await settle();
  const filter = nodes['composer-prompt-filter'];
  filter.focus();
  filter.value = 'the';
  filter.oninput();
  // A word in a name ranks before a word in the text. The others keep the menu order.
  assert.ok(nodes['composer-prompts-label'].hidden && nodes['composer-menu-actions'].hidden);
  assert.deepEqual(items(), [['Write the PR description', pr.text], ['Review PR', review.text], ['Commit', commit.text], ['Race', race.text]]);
  filter.value = 'pr desc';
  filter.oninput();
  assert.deepEqual(items(), [['Write the PR description', pr.text]]);
  assert.match(nodes['composer-prompts'].children[0].className, /first/);
  assert.ok(key('Enter'));
  assert.deepEqual(host.inserted, [pr.text]);
  // A filter without a match tells how to clear it. Escape clears it first.
  filter.value = 'nothing';
  filter.oninput();
  assert.deepEqual(items(), []);
  assert.equal(nodes['composer-prompts-note'].textContent, 'No matches.');
  assert.ok(key('Escape'));
  assert.equal(filter.value, '');
  assert.equal(items().length, 3);
  assert.ok(nodes['composer-prompts-note'].hidden);
  // A letter on an item moves the focus to the filter, so the user can type at once.
  nodes['composer-prompts'].children[0].focus();
  assert.ok(!key('r'));
  assert.equal(document.activeElement, filter);
});

test('a filter match ranks words in the name before the group and the text', () => {
  const ranked = matches(grouped.prompts, grouped.promptGroups, 'test');
  assert.deepEqual(ranked.map(prompt => prompt.id), ['r']);
  assert.deepEqual(matches(grouped.prompts, grouped.promptGroups, 'git').map(prompt => prompt.id), ['c', 'd'], 'a group name matches its prompts');
  assert.deepEqual(matches(grouped.prompts, grouped.promptGroups, 'COMMIT clear').map(prompt => prompt.id), ['c']);
  assert.deepEqual(matches(grouped.prompts, grouped.promptGroups, 'review').map(prompt => prompt.id), ['p1']);
});

test('Enter in an empty filter inserts nothing', async t => {
  const { nodes, host, toggle, key } = await fixture(t, [grouped]);
  toggle();
  await settle();
  nodes['composer-prompt-filter'].focus();
  assert.ok(key('Enter'));
  assert.deepEqual(host.inserted, []);
});

test('a filter closes an open group, so a clear of the filter returns to the items of the menu', async t => {
  const { nodes, toggle, items, key } = await fixture(t, [grouped]);
  toggle();
  await settle();
  nodes['composer-prompts'].children[1].click();
  assert.equal(items()[0], '‹ Git and PRs');
  const filter = nodes['composer-prompt-filter'];
  filter.focus();
  filter.value = 'race';
  filter.oninput();
  assert.deepEqual(items(), [['Race', race.text]]);
  assert.ok(key('Escape'));
  assert.deepEqual(items(), [['Review PR', review.text], ['Git and PRs', '›'], ['Tests', '›']]);
  assert.ok(!nodes['composer-menu-actions'].hidden);
});

test('a pointer on any item without a group closes the flyout, and a pointer that leaves cancels an open', async t => {
  const { nodes, toggle, point, leave } = await fixture(t, [grouped], true);
  toggle();
  await settle();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  point(nodes['composer-prompts'].children[1]);
  await wait(120);
  assert.ok(!nodes['composer-flyout'].hidden);
  // A pointer in the flyout keeps it open.
  point(nodes['composer-flyout'].children[0]);
  await wait(260);
  assert.ok(!nodes['composer-flyout'].hidden);
  // Manage prompts is outside the list of prompts, and it closes the flyout too.
  point(nodes['composer-prompts-manage']);
  await wait(260);
  assert.ok(nodes['composer-flyout'].hidden);
  // A pointer that passes over a group and leaves the menu opens nothing.
  point(nodes['composer-prompts'].children[2]);
  leave();
  await wait(120);
  assert.ok(nodes['composer-flyout'].hidden);
  // A pending open does nothing after the menu closes.
  point(nodes['composer-prompts'].children[2]);
  toggle();
  await wait(120);
  assert.ok(nodes['composer-flyout'].hidden);
});

test('the focus goes to Manage prompts when another view removes the last prompt while the filter has it', async t => {
  const { nodes, menu, toggle } = await fixture(t, [[review], []]);
  toggle();
  await settle();
  nodes['composer-prompt-filter'].focus();
  await menu.refresh();
  assert.ok(nodes['composer-prompt-filter-box'].hidden);
  assert.equal(document.activeElement, nodes['composer-prompts-manage']);
});
