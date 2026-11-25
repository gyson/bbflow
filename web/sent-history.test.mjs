import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showButton, showMessage, terminalHeadingText } from './dist/sent-history.js';

const terminal = (number, status, started, ended) => ({ number, run: `run-${number}`, tool: number === 2 ? 'Claude' : 'Codex', status, started, ended });
const terminals = [
  terminal(1, 'exited', '2026-11-23T10:00:00Z', '2026-11-23T11:00:00Z'),
  terminal(2, 'stopped', '2026-11-23T11:05:00Z', '2026-11-23T12:00:00Z'),
  terminal(3, 'running', '2026-11-23T12:10:00Z', ''),
];
const [first, , live] = terminals;
const inFirst = '2026-11-23T10:30:00Z', inLive = '2026-11-23T12:30:00Z';

test('the button scrolls the shown terminal to a message that it shows', () => {
  for (const state of ['found', 'current']) {
    const button = showButton(state, terminals, live, inLive);
    assert.equal(button.text, 'Show in terminal');
    assert.equal(button.disabled, false);
  }
});

test('the button names the terminal of a message from another terminal', () => {
  const saved = showButton('missing', terminals, live, inFirst);
  assert.equal(saved.text, 'Show in terminal 1');
  assert.equal(saved.disabled, false);
  assert.match(saved.title, /saved final screen of terminal 1.*Input and Send are off/);
  const back = showButton('missing', terminals, first, inLive);
  assert.equal(back.text, 'Show in terminal 3');
  assert.match(back.title, /^Open terminal 3, the live terminal,/);
  // An ended latest terminal is a saved screen too.
  const ended = terminals.map(item => item === live ? { ...item, status: 'exited', ended: '2026-11-23T13:00:00Z' } : item);
  assert.match(showButton('missing', ended, ended[0], inLive).title, /saved final screen of terminal 3/);
});

test('the button is off when the shown terminal no longer shows its own message', () => {
  const button = showButton('missing', terminals, live, inLive);
  assert.equal(button.text, 'Show in terminal');
  assert.equal(button.disabled, true);
  // Without the terminal list, the view cannot name another terminal.
  assert.equal(showButton('missing', [], undefined, inFirst).disabled, true);
  assert.equal(showButton('missing', terminals, undefined, inFirst).disabled, true);
});

test('a heading names the terminal, its tool, and its status', () => {
  assert.equal(terminalHeadingText(terminals[1]), 'Terminal 2 · Claude · stopped');
  assert.equal(terminalHeadingText({ ...first, tool: '' }), 'Terminal 1 · Unknown tool · exited');
  assert.equal(terminalHeadingText(undefined), 'Unknown terminal');
});

test('after a failed read of the sent messages, the button of a message of the shown terminal reads them again', () => {
  const button = showButton('missing', terminals, live, inLive, true);
  assert.equal(button.text, 'Show in terminal');
  assert.equal(button.disabled, false);
  assert.match(button.title, /could not read the sent messages of this terminal/);
  // A message of another terminal still names its terminal.
  assert.equal(showButton('missing', terminals, live, inFirst, true).text, 'Show in terminal 1');
  assert.equal(showButton('missing', terminals, live, inLive, false).disabled, true);
});

test('a click scrolls the shown terminal, opens another terminal, or reads the sent messages again', () => {
  const calls = [];
  const host = (found, unread) => ({
    state: () => 'missing', terminals: () => terminals, shown: () => live,
    go: revision => { calls.push(`go ${revision}`); return found; },
    open: (revision, terminal) => calls.push(`open ${revision} in ${terminal.number}`),
    unread: () => unread,
    retry: revision => calls.push(`retry ${revision}`),
  });
  assert.equal(showMessage(host(true, false), { revision: 4, created: inLive }), true);
  assert.equal(showMessage(host(false, false), { revision: 1, created: inFirst }), true);
  assert.equal(showMessage(host(false, true), { revision: 4, created: inLive }), true);
  assert.equal(showMessage(host(false, false), { revision: 4, created: inLive }), false);
  assert.deepEqual(calls, ['go 4', 'go 1', 'open 1 in 1', 'go 4', 'retry 4', 'go 4']);
});
