import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandoffPrompt } from './dist/handoff-prompt.js';

class Node {
  hidden = false; disabled = false; open = false; textContent = ''; value = '';
  classList = { toggle() {} };
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function fixture(t, host) {
  const ids = ['handoff-dialog', 'handoff-folder', 'handoff-text', 'handoff-status', 'handoff-copy', 'handoff-insert', 'handoff-close'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  const globals = { HTMLElement: Node, HTMLButtonElement: Node, HTMLDialogElement: Node, HTMLTextAreaElement: Node,
    document: { getElementById: id => nodes[id] } };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  const prompt = new HandoffPrompt(host);
  prompt.open({ folder: '/fixture/handoff/s1', prompt: 'Continue the work of bbflow session s1.', available: true });
  return nodes;
}

test('Insert in message closes the dialog before the insert, so the editor can take the focus', t => {
  const inserts = [];
  const problems = [];
  let dialog;
  const nodes = fixture(t, {
    blocked: () => undefined,
    insert: text => { inserts.push([text, dialog.open]); return undefined; },
    problem: text => problems.push(text),
  });
  dialog = nodes['handoff-dialog'];
  assert.ok(dialog.open);
  nodes['handoff-insert'].onclick();
  assert.deepEqual(inserts, [['Continue the work of bbflow session s1.', false]]);
  assert.deepEqual(problems, []);
});

test('a locked draft keeps the dialog open with the reason, and inserts nothing', t => {
  const inserts = [];
  const nodes = fixture(t, {
    blocked: () => 'A send may have reached the terminal. Check the terminal and unlock the draft first.',
    insert: text => { inserts.push(text); return undefined; },
    problem() {},
  });
  nodes['handoff-insert'].onclick();
  assert.ok(nodes['handoff-dialog'].open);
  assert.match(nodes['handoff-status'].textContent, /unlock the draft/);
  assert.deepEqual(inserts, []);
});
