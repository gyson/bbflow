import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpdateNotice, restartWarning, updateDialog, updateLabel } from './dist/update.js';

const offer = { version: '0.0.14', available: '0.0.15', state: 'available' };

test('the sidebar tells a download from a restart and shows progress', () => {
  assert.deepEqual(updateLabel(offer), { text: 'Update available: 0.0.15', enabled: true });
  assert.deepEqual(updateLabel({ ...offer, installed: true }), { text: 'Restart to use 0.0.15', enabled: true });
  // An update in progress cannot start again. A failed update can.
  assert.deepEqual(updateLabel({ ...offer, state: 'updating' }), { text: 'Updating to 0.0.15…', enabled: false });
  assert.deepEqual(updateLabel({ ...offer, state: 'failed', error: 'download failed' }), { text: 'Update to 0.0.15 failed', enabled: true });
});

test('an installed release needs only a restart', () => {
  const download = updateDialog(offer);
  assert.equal(download.title, 'Update bbflow');
  assert.equal(download.submit, 'Update and restart');
  assert.match(download.help, /downloads and verifies 0\.0\.15/);
  assert.equal(download.notes, 'https://github.com/gyson/bbflow/releases/tag/v0.0.15');
  const restart = updateDialog({ ...offer, installed: true });
  assert.equal(restart.title, 'Restart bbflow');
  assert.equal(restart.submit, 'Restart');
  assert.match(restart.help, /downloads nothing/);
});

test('the warning names the live sessions that the restart stops', () => {
  assert.match(restartWarning([], 0), /^No session is live now\./);
  assert.match(restartWarning(['Fix login'], 1), /^The restart stops 1 live session: Fix login\. Its recorded history stays\./);
  assert.match(restartWarning(['A', 'B'], 2), /stops 2 live sessions: A and B\. Their/);
  assert.match(restartWarning(['A', 'B', 'C'], 3), /: A, B, and C\./);
  // Live sessions outside the list and a long list show as a count.
  assert.match(restartWarning(['A'], 3), /stops 3 live sessions: A and 2 more\./);
  assert.match(restartWarning(['A', 'B', 'C', 'D', 'E', 'F', 'G'], 7), /: A, B, C, D, E, and 2 more\./);
});

// A small fake DOM. It has only the parts that the notice uses.
class Node {
  hidden = false;
  disabled = false;
  textContent = '';
  classList = { toggle() {} };
}
class Dialog extends Node {
  open = false;
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function setup() {
  const ids = ['update-open', 'update-form', 'update-title', 'update-versions', 'update-help', 'update-sessions',
    'update-notes', 'update-error', 'update-submit', 'update-cancel', 'update-close'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  nodes['update-dialog'] = new Dialog();
  globalThis.HTMLElement = globalThis.HTMLButtonElement = globalThis.HTMLDialogElement = globalThis.HTMLFormElement = globalThis.HTMLAnchorElement = Node;
  globalThis.document = { getElementById: id => nodes[id] };
  const notice = new UpdateNotice({ start: async () => {} });
  return { nodes, notice, dialog: nodes['update-dialog'], open: () => nodes['update-open'].onclick() };
}

test('the open dialog counts the live sessions of the latest status message', () => {
  const { nodes, notice, dialog, open } = setup();
  notice.show(offer, { names: ['A'], count: 1 });
  open();
  assert.ok(dialog.open);
  assert.match(nodes['update-sessions'].textContent, /stops 1 live session: A\./);
  notice.show(offer, { names: ['A', 'B'], count: 2 });
  assert.match(nodes['update-sessions'].textContent, /stops 2 live sessions: A and B\./);
});

test('a lost status watch hides the offer until the watch sends it again', () => {
  const { nodes, notice, dialog, open } = setup();
  notice.show(offer, { names: ['A'], count: 1 });
  open();
  notice.lost();
  // Without the watch, the dialog cannot tell which sessions the restart stops.
  assert.ok(nodes['update-open'].hidden);
  assert.ok(!dialog.open);
  open();
  assert.ok(!dialog.open);
  notice.show(offer, { names: ['A'], count: 1 });
  assert.ok(!nodes['update-open'].hidden);
  // An update in progress stays, because the server goes away during its restart.
  notice.show({ ...offer, state: 'updating' }, { names: [], count: 0 });
  notice.lost();
  assert.ok(!nodes['update-open'].hidden);
  assert.equal(nodes['update-open'].textContent, 'Updating to 0.0.15…');
  assert.ok(nodes['update-open'].disabled);
});
