import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedText, left, level, resetText, untilText, usageTools, windowName } from './dist/usage.js';

const tool = (type, name, builtin = true, enabled = true) => ({ id: `builtin-${type}`, name, command: type, type, model: '', effort: '', builtin, enabled, path: '' });

test('only the built-in Codex, Claude Code, and Antigravity tools that are on get a check', () => {
  const tools = [
    tool('codex', 'Codex'), tool('claude', 'Claude Code'), tool('agy', 'Antigravity', true, false),
    tool('code-puppy', 'Code Puppy'), tool('custom', 'codex wrapper', false), tool('', 'Shell'),
  ];
  assert.deepEqual(usageTools(tools).map(item => item.name), ['Claude Code', 'Codex']);
  assert.deepEqual(usageTools([...tools, tool('agy', 'Antigravity')]).map(item => item.type), ['agy', 'claude', 'codex']);
});

test('a limit shows the part that is left, and its level', () => {
  assert.equal(left({ label: '5-hour', used: 38 }), 62);
  assert.equal(left({ label: '5-hour', used: 80.6 }), 19);
  assert.equal(left({ label: '5-hour', used: 120 }), 0);
  assert.equal(level({ label: '5-hour', used: 80 }), 'ok');
  assert.equal(level({ label: '5-hour', used: 81 }), 'low');
  assert.equal(level({ label: '5-hour', used: 99.6 }), 'empty');
  assert.equal(windowName({ label: 'Weekly', used: 0 }), 'Weekly');
  assert.equal(windowName({ label: 'Weekly', model: 'Fable', used: 0 }), 'Weekly (Fable)');
});

test('a reset tells its time and the time until it', () => {
  assert.equal(untilText(48 * 60000), 'in 48 min');
  assert.equal(untilText((3 * 60 + 52) * 60000), 'in 3 h 52 min');
  assert.equal(untilText(5 * 3600000), 'in 5 h');
  assert.equal(untilText((5 * 24 + 14) * 3600000), 'in 5 d 14 h');
  assert.equal(untilText(2 * 86400000), 'in 2 d');
  assert.equal(untilText(-60000), 'in 0 min');
  const now = new Date(2026, 10, 25, 2, 36);
  // The time zone of the computer sets the local times. A space before AM can be a narrow
  // no-break space.
  assert.match(resetText(new Date(2026, 10, 25, 6, 32).toISOString(), now, 'en-US'), /^Resets 6:32\s?AM · in 3 h 56 min$/);
  assert.match(resetText(new Date(2026, 10, 27, 9, 0).toISOString(), now, 'en-US'), /^Resets Fri 9:00\s?AM · in 2 d 6 h$/);
  assert.match(resetText(new Date(2026, 11, 9, 9, 0).toISOString(), now, 'en-US'), /^Resets Dec 9, 9:00\s?AM · in 14 d 6 h$/);
  assert.equal(resetText(undefined, now), '');
  assert.equal(resetText('soon', now), '');
  assert.match(checkedText(new Date(2026, 10, 25, 10, 41).toISOString(), 'en-US'), /^10:41\s?AM$/);
  assert.equal(checkedText(''), '');
});
