import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentMark, inTerminal, locate, messageTime, sentText, stepMark, stepShortcut } from './dist/message-marks.js';

test('a message is found on the row that shows it after a prompt', () => {
  const rows = [
    'demo-agent (simulated). No model. No network.',
    'demo> Add an endpoint that returns the orbit period.',
    'Turn 1. Simulated reply to: Add an endpoint that returns the orbit period.',
    'demo> Run the tests and report the result.',
    'Turn 2. Simulated reply to: Run the tests and report the result.',
    'demo> ',
  ];
  assert.deepEqual(locate(rows, ['Add an endpoint that returns the orbit period.', 'Run the tests and report the result.']), [1, 3]);
});

test('the prompt characters of Claude Code and Codex CLI can come before a message', () => {
  // Recordings of Claude Code 2.1 and Codex CLI 0.171 show these characters before a message.
  assert.deepEqual(locate(['', '❯ Why does the step get smaller?', '', '⏺ The step follows the speed.'], ['Why does the step get smaller?']), [1]);
  assert.deepEqual(locate(['', '› Why does the step get smaller?', '', '• The step follows the speed.'], ['Why does the step get smaller?']), [1]);
  assert.deepEqual(locate(['❯ y', '› ok'], ['y', 'ok']), [0, 1]);
});

test('a wrapped and indented message is found on its first row', () => {
  const rows = [
    '> Rename the field to defaultTool in the protocol',
    '  too, and update each caller in the web',
    '  client.',
    '',
    '● Read internal/protocol/settings.go',
  ];
  const message = 'Rename the field to defaultTool in the protocol too, and update each caller in the web client.';
  assert.deepEqual(locate(rows, [message]), [0]);
  // A terminal that breaks a word at its right edge gives the same position.
  assert.deepEqual(locate(['> Rename the field to defaultTool in the proto', 'col too, and update each caller in the web cli', 'ent.'], [message]), [0]);
});

test('a message with several lines is found, and a frame character can follow it', () => {
  const rows = ['│ › The test fails.            │', '│   Fix it, but keep the fixture. │', 'Working'];
  assert.deepEqual(locate(rows, ['The test fails.\nFix it, but keep the fixture.']), [0]);
});

test('a later quote of a message is not taken for the message', () => {
  const rows = [
    '> Why does TestPeriod fail?',
    'You asked: "Why does TestPeriod fail?" The cause is the rounding.',
    'The answer to Why does TestPeriod fail?',
    '> Why does TestPeriod fail?',
    'Same answer.',
  ];
  assert.deepEqual(locate(rows, ['Why does TestPeriod fail?', 'Why does TestPeriod fail?']), [0, 3]);
});

test('a message that the rows do not show has no position, and later messages keep theirs', () => {
  const rows = ['> second message here', 'reply that quotes the first message text', '> third message here'];
  assert.deepEqual(locate(rows, ['the first message text', 'second message here', 'third message here']), [-1, 0, 2]);
});

test('a short message needs a row of its own after a prompt', () => {
  const rows = ['retry', 'eyes', 'Proceed with the plan? y', 'demo> y', 'ok'];
  assert.deepEqual(locate(rows, ['y']), [3]);
  assert.deepEqual(locate(['retry', 'eyes'], ['y']), [-1]);
});

test('a long message that the application shortens is found by its first line', () => {
  const rows = ['> Review the plan below and list the risks.', '  [Pasted text +40 lines]', 'Reading the plan'];
  const message = 'Review the plan below and list the risks.\n' + 'A line of the plan.\n'.repeat(40);
  assert.deepEqual(locate(rows, [message]), [0]);
});

test('a message after a long shell prompt is found when a prompt character ends the prompt', () => {
  const rows = ['user@host ~/projects/orbit % go test ./internal/orbit', 'ok  orbit 0.2s'];
  assert.deepEqual(locate(rows, ['go test ./internal/orbit']), [0]);
  assert.deepEqual(locate(['The command that I ran was go test ./internal/orbit'], ['go test ./internal/orbit']), [-1]);
});

test('the start of a first line finds a message with changed later text', () => {
  const rows = ['> Summarize the changes for the pull request… (2 files attached)'];
  assert.deepEqual(locate(rows, ['Summarize the changes for the pull request and name the files.']), [0]);
});

test('the sent text has the attached file paths as Send writes them', () => {
  const file = path => ({ id: 1, name: 'a', mediaType: '', size: 1, path });
  assert.equal(sentText({ text: 'Read this.', attachments: [file('/cache/1/a.txt'), file("/cache/2/it's.txt")] }),
    "Read this.\n\n'/cache/1/a.txt'\n'/cache/2/it'\\''s.txt'");
  assert.equal(sentText({ text: '', attachments: [file('/cache/1/a.txt')] }), "'/cache/1/a.txt'");
  assert.equal(sentText({ text: 'one\r\ntwo', attachments: [] }), 'one\ntwo');
  assert.deepEqual(locate(["> '/cache/1/a.txt'"], [sentText({ text: '', attachments: [file('/cache/1/a.txt')] })]), [0]);
});

test('the view reads the last message at or above its top row', () => {
  const rows = [10, 40, 90];
  assert.equal(currentMark(rows, 0), -1);
  assert.equal(currentMark(rows, 10), 0);
  assert.equal(currentMark(rows, 39), 0);
  assert.equal(currentMark(rows, 95), 2);
  assert.equal(currentMark(rows, 60, 2), 2, 'a jump target near the end stays the current message');
  assert.equal(currentMark(rows, 60, 5), 1, 'a target that is gone does not apply');
});

test('a step goes to the start of the current message, then to the earlier one', () => {
  const rows = [10, 40, 90];
  assert.equal(stepMark(rows, 55, -1, -1), 1, 'in a response, go to its message');
  assert.equal(stepMark(rows, 40, -1, -1), 0, 'at a message, go to the earlier message');
  assert.equal(stepMark(rows, 10, -1, -1), null);
  assert.equal(stepMark(rows, 5, -1, -1), null);
  assert.equal(stepMark(rows, 5, -1, 1), 0);
  assert.equal(stepMark(rows, 40, -1, 1), 2);
  assert.equal(stepMark(rows, 90, -1, 1), 'end');
  // The view shows message 2 near the end of the output, below its top row 60.
  assert.equal(stepMark(rows, 60, 2, -1), 1);
  assert.equal(stepMark(rows, 60, 2, 1), 'end');
  assert.equal(stepMark(rows, 60, 1, 1), 2);
  assert.equal(stepMark([], 0, -1, 1), 'end');
});

test('only the step keys step between messages', () => {
  const key = (key, modifiers = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers });
  assert.equal(stepShortcut(key('ArrowUp', { metaKey: true })), -1);
  assert.equal(stepShortcut(key('ArrowDown', { metaKey: true })), 1);
  assert.equal(stepShortcut(key('ArrowUp', { ctrlKey: true, shiftKey: true })), -1);
  assert.equal(stepShortcut(key('ArrowDown', { ctrlKey: true, shiftKey: true })), 1);
  assert.equal(stepShortcut(key('ArrowUp')), 0);
  assert.equal(stepShortcut(key('ArrowUp', { ctrlKey: true })), 0, 'Ctrl+Up stays a terminal key');
  assert.equal(stepShortcut(key('ArrowUp', { metaKey: true, shiftKey: true })), 0);
  assert.equal(stepShortcut(key('ArrowUp', { metaKey: true, altKey: true })), 0);
  assert.equal(stepShortcut(key('k', { metaKey: true })), 0);
});

test('a message belongs to the terminal that ran when it was sent', () => {
  const terminal = { started: '2026-11-23T10:00:00Z', ended: '2026-11-23T11:00:00Z' };
  assert.equal(inTerminal('2026-11-23T10:30:00Z', terminal), true);
  assert.equal(inTerminal('2026-11-23T09:59:59Z', terminal), false);
  assert.equal(inTerminal('2026-11-23T11:00:01Z', terminal), false);
  assert.equal(inTerminal('2026-11-23T12:00:00Z', { started: terminal.started, ended: '' }), true, 'a live terminal has no end');
  assert.equal(inTerminal('2026-11-23T09:00:00Z'), true);
});

test('the time of a message shows the date when it is not today', () => {
  const now = new Date('2026-11-23T15:00:00Z');
  assert.equal(messageTime('2026-11-23T14:02:00Z', now, 'en-US', 'UTC'), '14:02');
  assert.equal(messageTime('2026-11-21T09:05:00Z', now, 'en-US', 'UTC'), 'Nov 21 09:05');
  assert.equal(messageTime('not a date', now, 'en-US', 'UTC'), '');
});
