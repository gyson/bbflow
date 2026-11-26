import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpdatePanel, checkedTime, releaseText, restartWarning, updateDialog } from './dist/update.js';
import { pageBar } from './dist/page-bar.js';

const offer = { revision: 1, version: '0.0.14', available: '0.0.15', state: 'available' };
const now = new Date(2026, 10, 25, 15, 0);
const tick = () => new Promise(resolve => setImmediate(resolve));
const at = (day, hour, minute) => new Date(2026, 10, day, hour, minute).toISOString();
// The release check state of a status message, with an offer or without.
// The failure of an update to 0.0.15.
const failed = { available: '0.0.15', error: 'download failed' };
const state = (update, more = {}) => ({ version: '0.0.14', canUpdate: true, checks: 1, checked: at(25, 10, 41), ...(update ? { offer: update } : {}), ...more });

test('a check time names the day of an earlier check', () => {
  assert.equal(checkedTime(at(25, 10, 41), now, 'en-US'), '10:41 AM');
  assert.equal(checkedTime(at(23, 9, 5), now, 'en-US'), 'Mon 9:05 AM');
  assert.equal(checkedTime(at(2, 9, 5), now, 'en-US'), 'Nov 2, 9:05 AM');
  assert.equal(checkedTime('not a time', now, 'en-US'), '');
});

test('the card tells the result of the last check', () => {
  const text = (release) => releaseText(release, now, 'en-US');
  assert.deepEqual(text(undefined), { version: '', status: 'Waiting for the server.', problem: '', action: '' });
  // A development build shows its version, but it cannot check.
  assert.deepEqual(text({ version: 'dev' }), {
    version: 'bbflow dev', status: 'This build cannot check for a new version. Only a release build on macOS can check and update.', problem: '', action: '',
  });
  assert.equal(text({ version: '0.0.14', canUpdate: true }).status, 'No check since the server started.');
  assert.equal(text({ version: '0.0.14', canUpdate: true, checking: true }).status, 'Checking for a new version…');
  assert.deepEqual(text(state()), { version: 'bbflow 0.0.14', status: 'This is the newest version. Last checked 10:41 AM.', problem: '', action: '' });
  // A failed check keeps the offer of the last successful check.
  assert.deepEqual(text(state(undefined, { error: 'GitHub is down' })), { version: 'bbflow 0.0.14', status: '', problem: 'The check at 10:41 AM failed: GitHub is down', action: '' });
  assert.deepEqual(text(state(offer, { error: 'GitHub is down' })), {
    version: 'bbflow 0.0.14', status: 'bbflow 0.0.15 is available.', problem: 'The check at 10:41 AM failed: GitHub is down', action: 'Update…',
  });
});

test('the card tells a download from a restart and shows progress', () => {
  const text = (update) => releaseText(state(update), now, 'en-US');
  assert.deepEqual(text(offer), { version: 'bbflow 0.0.14', status: 'bbflow 0.0.15 is available. Last checked 10:41 AM.', problem: '', action: 'Update…' });
  assert.deepEqual(text({ ...offer, installed: true }), { version: 'bbflow 0.0.14', status: 'bbflow 0.0.15 is installed. A restart starts it. Last checked 10:41 AM.', problem: '', action: 'Restart…' });
  // An update in progress cannot start again. A failed update can.
  assert.deepEqual(text({ ...offer, state: 'updating' }), { version: 'bbflow 0.0.14', status: 'Updating to 0.0.15…', problem: '', action: '' });
  assert.deepEqual(releaseText(state(offer, { failed }), now, 'en-US'), {
    version: 'bbflow 0.0.14', status: 'bbflow 0.0.15 is available. Last checked 10:41 AM.', problem: 'The update to 0.0.15 failed: download failed', action: 'Update…',
  });
});

test('the failure stays with the release of the update when a check changes the offer', () => {
  const newer = { ...offer, revision: 2, available: '0.0.16' };
  assert.deepEqual(releaseText(state(newer, { failed }), now, 'en-US'), {
    version: 'bbflow 0.0.14', status: 'bbflow 0.0.16 is available. Last checked 10:41 AM.', problem: 'The update to 0.0.15 failed: download failed', action: 'Update…',
  });
  assert.deepEqual(releaseText(state(undefined, { failed }), now, 'en-US'), {
    version: 'bbflow 0.0.14', status: 'This is the newest version. Last checked 10:41 AM.', problem: 'The update to 0.0.15 failed: download failed', action: '',
  });
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

// A small fake DOM. It has only the parts that the panel uses.
class Node {
  hidden = false;
  disabled = false;
  textContent = '';
  title = '';
  attributes = new Map();
  classes = new Set();
  classList = {
    toggle: (name, on) => { if (on) this.classes.add(name); else this.classes.delete(name); },
    contains: name => this.classes.has(name),
  };
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
}
class Dialog extends Node {
  open = false;
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function setup() {
  const ids = ['settings-updates', 'settings-updates-title', 'release-version', 'release-status', 'release-problem',
    'release-check', 'release-notes', 'settings-open', 'update-open', 'update-form', 'update-title', 'update-versions',
    'update-help', 'update-sessions', 'update-notes', 'update-error', 'update-submit', 'update-cancel', 'update-close'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  nodes['update-dialog'] = new Dialog();
  globalThis.HTMLElement = globalThis.HTMLButtonElement = globalThis.HTMLDialogElement = globalThis.HTMLFormElement = globalThis.HTMLAnchorElement = Node;
  globalThis.document = { getElementById: id => nodes[id] };
  // The titles of the session list. A session outside the list has no title.
  const titles = new Map([['a', 'A'], ['b', 'B']]);
  const starts = [];
  const checks = [];
  // A start can wait for the draft save. hold() makes the next start wait until the test
  // settles it. Later starts do not wait.
  let held;
  // checkFail makes the next check request fail.
  let checkFail;
  const panel = new UpdatePanel({
    title: id => titles.get(id),
    start: update => {
      starts.push(update);
      const wait = held?.promise ?? Promise.resolve();
      held = undefined;
      return wait;
    },
    check: () => {
      checks.push(true);
      const fail = checkFail;
      checkFail = undefined;
      return fail ? Promise.reject(fail) : Promise.resolve();
    },
  });
  // The tests below send offers. The panel gets them in a release check state. more
  // adds other fields of the state, such as a failure.
  const notice = {
    show: (update, live, more) => panel.show(state(update, more), live),
    lost: () => panel.lost(),
    sessionsChanged: () => panel.sessionsChanged(),
    get current() { return panel.current; },
  };
  return {
    nodes, panel, notice, titles, starts, checks, dialog: nodes['update-dialog'],
    failCheck(error) { checkFail = error; },
    check: () => nodes['release-check'].onclick(),
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
  const { nodes, notice, starts, dialog, open, confirm } = setup();
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
  // A failed attempt keeps the revision, so the open dialog stays and shows the reason.
  open();
  notice.show({ ...offer, revision: 2 }, [], { failed });
  assert.ok(dialog.open);
  assert.equal(nodes['update-error'].textContent, 'The last attempt failed: download failed');
  // The reason of an update to another release does not show in this dialog.
  notice.show({ ...offer, revision: 2 }, [], { failed: { available: '0.0.13', error: 'download failed' } });
  assert.ok(nodes['update-error'].hidden);
});

test('a lost status watch hides the offer until the watch sends it again', () => {
  const { nodes, notice, dialog, open } = setup();
  notice.show(offer, ['a']);
  open();
  notice.lost();
  // Without the watch, the dialog cannot tell which sessions the restart stops.
  assert.ok(nodes['update-open'].hidden);
  assert.ok(!dialog.open);
  assert.equal(nodes['release-status'].textContent, 'Waiting for the server.');
  assert.ok(nodes['release-check'].hidden);
  open();
  assert.ok(!dialog.open);
  notice.show(offer, ['a']);
  assert.ok(!nodes['update-open'].hidden);
  assert.equal(nodes['update-open'].textContent, 'Update…');
  // An update in progress stays, because the server goes away during its restart. It
  // cannot start again, and no check runs during it.
  notice.show({ ...offer, state: 'updating' }, []);
  notice.lost();
  assert.ok(nodes['update-open'].hidden);
  assert.equal(nodes['release-status'].textContent, 'Updating to 0.0.15…');
  assert.ok(nodes['release-check'].disabled);
});

test('the dot on Settings tells of an offer that the user can start', () => {
  const { nodes, panel } = setup();
  const settings = nodes['settings-open'];
  panel.show(state(), []);
  assert.ok(!panel.attention);
  assert.ok(!settings.classList.contains('has-update'));
  assert.ok(!settings.attributes.has('aria-label'));
  panel.show(state(offer), []);
  assert.ok(panel.attention);
  assert.ok(settings.classList.contains('has-update'));
  assert.equal(settings.attributes.get('aria-label'), 'Settings, Update available: 0.0.15');
  assert.equal(settings.title, 'Update available: 0.0.15. bbflow 0.0.14 runs now.');
  assert.ok(!nodes['release-notes'].hidden);
  assert.equal(nodes['release-notes'].href, 'https://github.com/gyson/bbflow/releases/tag/v0.0.15');
  panel.show(state(offer, { failed }), []);
  assert.ok(settings.classList.contains('failed'));
  assert.equal(settings.attributes.get('aria-label'), 'Settings, The update to 0.0.15 failed');
  // A failure shows also when a later check found no newer release.
  panel.show(state(undefined, { failed }), []);
  assert.ok(panel.attention);
  assert.ok(settings.classList.contains('failed'));
  assert.equal(settings.title, 'The update to 0.0.15 failed. bbflow 0.0.14 runs now.');
  // The page bar shows an update in progress instead.
  panel.show(state({ ...offer, state: 'updating' }), []);
  assert.ok(!panel.attention);
  assert.ok(!settings.classList.contains('has-update'));
});

test('Check now shows the check as running until the status watch reports it', async () => {
  const { nodes, panel, checks, check } = setup();
  const button = nodes['release-check'];
  panel.show(state(), []);
  assert.equal(button.textContent, 'Check now');
  check();
  assert.equal(button.textContent, 'Checking…');
  assert.ok(button.disabled);
  // A second click during the request sends nothing.
  check();
  await tick();
  assert.equal(checks.length, 1);
  // A status message from before the request does not end the check.
  panel.show(state(), []);
  assert.ok(button.disabled);
  panel.show(state(undefined, { checking: true }), []);
  assert.equal(button.textContent, 'Checking…');
  panel.show(state(offer, { checks: 2, checked: at(25, 14, 59) }), []);
  assert.equal(button.textContent, 'Check now');
  assert.ok(!button.disabled);
  assert.equal(nodes['update-open'].textContent, 'Update…');
});

test('a check that ends in the same second as the last one ends Check now', async () => {
  const { nodes, panel, check } = setup();
  const button = nodes['release-check'];
  panel.show(state(), []);
  check();
  await tick();
  // The watch did not see the check run, and the check time and the result are the same.
  // The count of checks still tells that the check ended.
  panel.show(state(undefined, { checks: 2 }), []);
  assert.equal(button.textContent, 'Check now');
  assert.ok(!button.disabled);
});

test('a failed check request shows its reason until a later check', async () => {
  const { nodes, panel, check, failCheck } = setup();
  panel.show(state(), []);
  failCheck(new Error('The server is not connected.'));
  check();
  await tick();
  assert.equal(nodes['release-check'].textContent, 'Check now');
  assert.equal(nodes['release-problem'].textContent, 'Could not check: The server is not connected.');
  assert.ok(!nodes['release-problem'].hidden);
  panel.show(state(), []);
  assert.ok(!nodes['release-problem'].hidden);
  panel.show(state(undefined, { checks: 2 }), []);
  assert.ok(nodes['release-problem'].hidden);
});

test('a development build hides Check now', () => {
  const { nodes, panel } = setup();
  panel.show({ version: 'dev' }, []);
  assert.ok(nodes['release-check'].hidden);
  assert.equal(nodes['release-version'].textContent, 'bbflow dev');
});


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
    if (order === 'status first') notice.show(offer, [], { failed });
    start.resolve();
    await settle();
    if (order === 'reply first') {
      notice.show({ ...offer, state: 'updating' }, []);
      assert.match(shown(notice), /^bbflow updates to 0\.0\.15\./, order);
      notice.show(offer, [], { failed });
    }
    assert.equal(shown(notice), '', order);
  }
});

test('a late failed status of an earlier attempt does not hide the bar of a retry', () => {
  const { notice } = setup();
  notice.show({ ...offer, state: 'updating' }, []);
  notice.show(offer, [], { failed });
  assert.equal(shown(notice), '');
  notice.show({ ...offer, revision: 2, state: 'updating' }, []);
  assert.match(shown(notice), /updates to 0\.0\.15/);
  // The bar stays while the watch is lost, because the server restarts.
  notice.lost();
  assert.match(shown(notice), /updates to 0\.0\.15/);
});
