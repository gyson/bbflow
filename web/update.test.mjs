import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpdateNotice, restartWarning, updateDialog, updateLabel } from './dist/update.js';
import { pageBar } from './dist/page-bar.js';

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
  // A start can wait for the draft save. hold() makes the next start wait until the test
  // settles it. Later starts do not wait.
  let held;
  const notice = new UpdateNotice({
    title: id => titles.get(id),
    start: update => {
      starts.push(update);
      const wait = held?.promise ?? Promise.resolve();
      held = undefined;
      return wait;
    },
  });
  return {
    nodes, notice, titles, starts, dialog: nodes['update-dialog'],
    hold() {
      held = {};
      held.promise = new Promise((resolve, reject) => Object.assign(held, { resolve, reject }));
      return held;
    },
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

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a failed start after a lost status watch allows no other attempt', async () => {
  const { nodes, notice, starts, dialog, open, confirm, hold } = setup();
  notice.show(offer, ['a']);
  open();
  const save = hold();
  confirm();
  // The status watch fails while the drafts save. Then the save fails.
  notice.lost();
  save.reject(new Error('Draft save failed.'));
  await tick();
  assert.ok(dialog.open);
  assert.match(nodes['update-error'].textContent, /^Draft save failed\. The offer or the live sessions changed/);
  assert.ok(nodes['update-submit'].disabled);
  // The dialog keeps its earlier text. It does not fill from data that is not current.
  notice.sessionsChanged();
  assert.match(nodes['update-sessions'].textContent, /stops 1 live session: A\./);
  confirm();
  assert.equal(starts.length, 1);
});

test('a failed start without a change allows another attempt', async () => {
  const { nodes, notice, starts, dialog, open, confirm, hold } = setup();
  notice.show(offer, ['a']);
  open();
  const save = hold();
  confirm();
  // A status change of the same offer during the start keeps the dialog current.
  notice.show(offer, ['a', 'b']);
  save.reject(new Error('Draft save failed.'));
  await tick();
  assert.ok(dialog.open);
  assert.equal(nodes['update-error'].textContent, 'Draft save failed.');
  assert.ok(!nodes['update-submit'].disabled);
  assert.match(nodes['update-sessions'].textContent, /stops 2 live sessions: A and B\./);
  confirm();
  await tick();
  assert.equal(starts.length, 2);
  assert.ok(!dialog.open);
});

test('a start that succeeds after a new offer closes the dialog', async () => {
  const { notice, dialog, open, confirm, hold } = setup();
  notice.show(offer, []);
  open();
  const save = hold();
  confirm();
  notice.show({ ...offer, revision: 2 }, []);
  save.resolve();
  await tick();
  assert.ok(!dialog.open);
});

// The page bar of the view that started the update reads the latest status of the watch.
const shown = notice => pageBar(false, notice.current).text;
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a failed status before or after the start reply leaves no update bar', async () => {
  for (const order of ['status first', 'reply first']) {
    const { notice, open, confirm, hold } = setup();
    notice.show(offer, []);
    open();
    const start = hold();
    confirm();
    const failed = { ...offer, state: 'failed', error: 'download failed' };
    if (order === 'status first') notice.show(failed, []);
    start.resolve();
    await settle();
    if (order === 'reply first') {
      notice.show({ ...offer, state: 'updating' }, []);
      assert.match(shown(notice), /^bbflow updates to 0\.0\.15\./, order);
      notice.show(failed, []);
    }
    assert.equal(shown(notice), '', order);
  }
});

test('a late failed status of an earlier attempt does not hide the bar of a retry', () => {
  const { notice } = setup();
  notice.show({ ...offer, state: 'updating' }, []);
  notice.show({ ...offer, state: 'failed', error: 'download failed' }, []);
  assert.equal(shown(notice), '');
  notice.show({ ...offer, revision: 2, state: 'updating' }, []);
  assert.match(shown(notice), /updates to 0\.0\.15/);
  // The bar stays while the watch is lost, because the server restarts.
  notice.lost();
  assert.match(shown(notice), /updates to 0\.0\.15/);
});
