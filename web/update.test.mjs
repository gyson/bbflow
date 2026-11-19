import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpdateNotice, restartWarning, updateDialog, updateLabel } from './dist/update.js';

const offer = { revision: 1, version: '0.0.14', available: '0.0.15', state: 'available' };

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
  // The titles of the session list. A session outside the list has no title.
  const titles = new Map([['a', 'A'], ['b', 'B']]);
  const starts = [];
  const notice = new UpdateNotice({ title: id => titles.get(id), start: async update => { starts.push(update); } });
  return {
    nodes, notice, titles, starts, dialog: nodes['update-dialog'],
    open: () => nodes['update-open'].onclick(),
    confirm: () => nodes['update-form'].onsubmit({ preventDefault() {} }),
  };
}

test('the open dialog counts the live sessions of the latest status message', () => {
  const { nodes, notice, dialog, open } = setup();
  notice.show(offer, ['a']);
  open();
  assert.ok(dialog.open);
  assert.match(nodes['update-sessions'].textContent, /stops 1 live session: A\./);
  notice.show(offer, ['a', 'b', 'c']);
  assert.match(nodes['update-sessions'].textContent, /stops 3 live sessions: A, B, and 1 more\./);
});

test('the open dialog shows the titles of the current session list', () => {
  const { nodes, notice, titles, open } = setup();
  notice.show(offer, ['a']);
  open();
  // A rename reaches the list after the status message of its title change.
  titles.set('a', 'Renamed');
  notice.sessionsChanged();
  assert.match(nodes['update-sessions'].textContent, /stops 1 live session: Renamed\./);
});

test('a confirmation applies only to the offer that the dialog shows', async () => {
  const { notice, starts, dialog, open, confirm } = setup();
  notice.show({ ...offer, installed: true }, []);
  open();
  // A new check offers a download. The dialog of the restart closes.
  notice.show({ ...offer, revision: 2 }, []);
  assert.ok(!dialog.open);
  open();
  confirm();
  // Let the start finish. It closes the dialog.
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!dialog.open);
  assert.deepEqual(starts.map(update => [update.revision, !!update.installed]), [[2, false]]);
  // A failed attempt keeps the revision, so the open dialog stays.
  open();
  notice.show({ ...offer, revision: 2, state: 'failed', error: 'download failed' }, []);
  assert.ok(dialog.open);
});

test('a lost status watch hides the offer until the watch sends it again', () => {
  const { nodes, notice, dialog, open } = setup();
  notice.show(offer, ['a']);
  open();
  notice.lost();
  // Without the watch, the dialog cannot tell which sessions the restart stops.
  assert.ok(nodes['update-open'].hidden);
  assert.ok(!dialog.open);
  open();
  assert.ok(!dialog.open);
  notice.show(offer, ['a']);
  assert.ok(!nodes['update-open'].hidden);
  // An update in progress stays, because the server goes away during its restart.
  notice.show({ ...offer, state: 'updating' }, []);
  notice.lost();
  assert.ok(!nodes['update-open'].hidden);
  assert.equal(nodes['update-open'].textContent, 'Updating to 0.0.15…');
  assert.ok(nodes['update-open'].disabled);
});
