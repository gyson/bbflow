import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspacePane } from './dist/workspace-pane.js';

// A small fake DOM. It has only the parts that the pane uses.
class Node {
  hidden = false;
  dataset = {};
  style = { setProperty(key, value) { this[key] = value; } };
  attributes = new Map();
  // The shown width and the CSS minimum width.
  width = 400;
  minWidth = '0px';
  setAttribute(key, value) { this.attributes.set(key, value); }
  getBoundingClientRect() { return { width: this.width }; }
}

const views = ['changes', 'files', 'terminal'];
const ids = ['session-view', 'workspace-pane', 'workspace-divider', 'diff-pane', 'side-terminal', 'side-close',
  'view-switch', 'view-session', ...views.flatMap(view => [`pane-${view}`, `view-${view}`])];

function setup() {
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  globalThis.HTMLElement = globalThis.HTMLButtonElement = Node;
  globalThis.window = { addEventListener() {} };
  globalThis.document = { getElementById: id => nodes[id] };
  globalThis.getComputedStyle = node => ({ minWidth: node.minWidth });
  // Fake views. Each one keeps its session and its last shown state. A real view that is
  // shown when it selects a session can load data or join a shell for the wrong session.
  // Thus each fake records the sessions that it selected while shown.
  const changes = {
    session: '', shown: false, scope: undefined, selectedWhileShown: [],
    select(session) { if (this.shown) this.selectedWhileShown.push(session); this.session = session; },
    setShown(open, scope) { this.shown = open; if (scope) this.scope = scope; },
  };
  const terminal = {
    session: '', shown: false, click: false, selectedWhileShown: [],
    select(session) { if (this.shown) this.selectedWhileShown.push(session); this.session = session; },
    setShown(shown, click) { this.shown = shown; this.click = shown && click; },
  };
  const pane = new WorkspacePane(changes, terminal);
  // Return the pressed view, or closed when the pane is hidden.
  const shown = () => {
    if (nodes['workspace-pane'].hidden) return 'closed';
    return views.find(view => nodes[`pane-${view}`].attributes.get('aria-pressed') === 'true');
  };
  const click = view => nodes[`pane-${view}`].onclick();
  return { nodes, pane, changes, terminal, shown, click };
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

test('the view switch shows the session or one view, and does not show without a session', () => {
  const { nodes, pane, terminal, shown } = setup();
  // The pressed button of the switch.
  const pressed = () => ['session', ...views].filter(name => nodes[`view-${name}`].attributes.get('aria-pressed') === 'true');
  pane.select('a');
  assert.equal(nodes['view-switch'].hidden, false);
  assert.deepEqual(pressed(), ['session']);

  nodes['view-changes'].onclick();
  assert.equal(shown(), 'changes');
  assert.deepEqual(pressed(), ['changes']);
  nodes['view-changes'].onclick();
  assert.equal(shown(), 'changes', 'a second click keeps the view');
  nodes['view-terminal'].onclick();
  assert.equal(shown(), 'terminal');
  assert.equal(terminal.click, true, 'a click on Terminal can start a shell');
  assert.deepEqual(pressed(), ['terminal']);
  nodes['view-session'].onclick();
  assert.equal(shown(), 'closed');
  assert.deepEqual(pressed(), ['session']);

  // The icons and the switch show the same state.
  nodes['pane-files'].onclick();
  assert.deepEqual(pressed(), ['files']);
  pane.select('');
  assert.equal(nodes['view-switch'].hidden, true);
  pane.select('a');
  assert.deepEqual(pressed(), ['files']);
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

test('the views hide before they select the next session, then show the view of that session', () => {
  const { pane, changes, terminal, click } = setup();
  pane.select('a');
  click('terminal');
  assert.deepEqual([changes.shown, terminal.shown, terminal.click], [false, true, true]);

  // Session b has a closed pane. The terminal view does not join a shell of session b.
  pane.select('b');
  assert.deepEqual([changes.session, terminal.session], ['b', 'b']);
  assert.deepEqual([changes.shown, terminal.shown], [false, false]);

  click('files');
  assert.deepEqual([changes.shown, changes.scope, terminal.shown], [true, 'files', false]);

  // Session a shows its terminal again. The view joins the shell without a click.
  pane.select('a');
  assert.deepEqual([changes.session, terminal.session], ['a', 'a']);
  assert.deepEqual([changes.shown, terminal.shown, terminal.click], [false, true, false]);

  // Session b shows Files again.
  pane.select('b');
  assert.deepEqual([changes.shown, changes.scope, terminal.shown], [true, 'files', false]);

  assert.deepEqual(changes.selectedWhileShown, [], 'the Changes and Files view was shown when it selected a session');
  assert.deepEqual(terminal.selectedWhileShown, [], 'the Terminal view was shown when it selected a session');
});

test('the arrow keys change the preferred width inside the widths that the row can show', () => {
  const { nodes } = setup();
  const pane = nodes['workspace-pane'];
  const session = nodes['session-view'];
  const divider = nodes['workspace-divider'];
  pane.minWidth = '320px';
  session.minWidth = '360px';
  const key = name => {
    let prevented = false;
    divider.onkeydown({ key: name, preventDefault() { prevented = true; } });
    return prevented;
  };

  // The session has 40 px more than its minimum width. The pane can take all of it.
  session.width = 400;
  assert.equal(key('ArrowLeft'), true);
  assert.equal(pane.style['--pane-width'], '420px');
  // The session has only 10 px to spare. The pane stops at 410 px.
  session.width = 370;
  key('ArrowLeft');
  assert.equal(pane.style['--pane-width'], '410px');
  // A step to the right stops at the minimum width of the pane.
  pane.width = 330;
  key('ArrowRight');
  assert.equal(pane.style['--pane-width'], '320px');
  assert.equal(key('Enter'), false, 'other keys keep their default action');
});
