import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspacePane } from './dist/workspace-pane.js';

// A small fake DOM. It has only the parts that the pane uses.
class Node {
  hidden = false;
  dataset = {};
  style = {};
  attributes = new Map();
  clientWidth = 1200;
  setAttribute(key, value) { this.attributes.set(key, value); }
  getBoundingClientRect() { return { width: 400 }; }
}

const views = ['changes', 'files', 'terminal'];
const ids = ['session-row', 'workspace-pane', 'workspace-divider', 'diff-pane', 'side-terminal', 'side-close',
  ...views.map(view => `pane-${view}`)];

function setup() {
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  globalThis.HTMLElement = globalThis.HTMLButtonElement = Node;
  globalThis.window = { addEventListener() {} };
  globalThis.document = { getElementById: id => nodes[id] };
  const calls = [];
  const changes = {
    select: session => calls.push(`changes select ${session}`),
    setShown: (open, scope) => calls.push(open ? `changes show ${scope}` : 'changes hide'),
  };
  const terminal = {
    select: session => calls.push(`terminal select ${session}`),
    setShown: (shown, click) => calls.push(shown ? `terminal show${click ? ' click' : ''}` : 'terminal hide'),
  };
  const pane = new WorkspacePane(changes, terminal);
  // Return the pressed view, or closed when the pane is hidden.
  const shown = () => {
    if (nodes['workspace-pane'].hidden) return 'closed';
    return views.find(view => nodes[`pane-${view}`].attributes.get('aria-pressed') === 'true');
  };
  const click = view => nodes[`pane-${view}`].onclick();
  return { nodes, pane, changes, calls, shown, click };
}

test('each session shows its own view, and a session not shown yet starts with a closed pane', () => {
  const { pane, changes, shown, click } = setup();
  pane.select('a');
  assert.equal(shown(), 'closed');
  click('terminal');
  assert.equal(shown(), 'terminal');

  pane.select('b');
  assert.equal(shown(), 'closed', 'a new session does not take the view of the previous session');
  click('files');
  assert.equal(shown(), 'files');

  pane.select('a');
  assert.equal(shown(), 'terminal');
  pane.select('b');
  assert.equal(shown(), 'files');
  pane.select('c');
  assert.equal(shown(), 'closed');

  // The button of a file in Files opens Changes only for the selected session.
  pane.select('b');
  changes.openChanges();
  assert.equal(shown(), 'changes');
  pane.select('a');
  assert.equal(shown(), 'terminal');
});

test('a click on the pressed icon or on the close button closes the pane of that session only', () => {
  const { nodes, pane, changes, shown, click } = setup();
  pane.select('a');
  click('terminal');
  pane.select('b');
  click('changes');

  pane.select('a');
  click('terminal');
  assert.equal(shown(), 'closed');
  pane.select('b');
  assert.equal(shown(), 'changes');
  nodes['side-close'].onclick();
  assert.equal(shown(), 'closed');
  click('files');
  changes.close();
  assert.equal(shown(), 'closed');

  pane.select('a');
  assert.equal(shown(), 'closed');
  pane.select('b');
  assert.equal(shown(), 'closed');
});

test('a draft, Settings, or the home page hides the pane and its icons and keeps the state of each session', () => {
  const { nodes, pane, shown, click } = setup();
  pane.select('a');
  click('changes');
  pane.select('');
  assert.equal(shown(), 'closed');
  for (const view of views) assert.equal(nodes[`pane-${view}`].hidden, true, view);
  click('terminal');
  assert.equal(shown(), 'closed', 'an icon click without a session does not open the pane');

  pane.select('a');
  for (const view of views) assert.equal(nodes[`pane-${view}`].hidden, false, view);
  assert.equal(shown(), 'changes');
  assert.equal(nodes['diff-pane'].hidden, false);
  assert.equal(nodes['side-terminal'].hidden, true);
});

test('the views hide before they select the next session', () => {
  const { pane, calls, click } = setup();
  pane.select('a');
  click('terminal');
  assert.deepEqual(calls.slice(-2), ['changes hide', 'terminal show click']);

  // Session b has a closed pane. The terminal view does not join a shell of session b.
  calls.length = 0;
  pane.select('b');
  assert.deepEqual(calls, ['changes hide', 'terminal hide', 'changes select b', 'terminal select b',
    'changes hide', 'terminal hide']);

  calls.length = 0;
  click('files');
  assert.deepEqual(calls, ['changes show files', 'terminal hide']);

  // Session a shows its terminal again. The view joins the shell without a click.
  calls.length = 0;
  pane.select('a');
  assert.deepEqual(calls, ['changes hide', 'terminal hide', 'changes select a', 'terminal select a',
    'changes hide', 'terminal show']);
});
