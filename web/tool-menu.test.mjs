import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortedBuiltins, toolGroups } from './dist/tool-menu.js';

const tool = (id, name, builtin, enabled = true) => ({ id, name, command: id, type: builtin ? id : 'custom', model: '', effort: '', permission: '', codeMode: false, builtin, enabled, path: '' });
const tools = [
  tool('codex', 'Codex', true), tool('claude', 'Claude Code', true), tool('agy', 'Antigravity', true, false), tool('code-puppy', 'Code Puppy', true),
  tool('zeta', 'Zeta script', false), tool('alpha', 'alpha wrapper', false), tool('off', 'Off script', false, false),
];

test('a tool menu has the built-in tools by name, then the custom tools in their saved order', () => {
  const groups = toolGroups(tools, true);
  // Shell sorts with the built-in tools. A tool that is off is no choice.
  assert.deepEqual(groups.builtin.map(choice => choice.name), ['Claude Code', 'Code Puppy', 'Codex', 'Shell']);
  assert.deepEqual(groups.custom.map(choice => choice.id), ['zeta', 'alpha']);
  assert.deepEqual(toolGroups(tools, false).builtin.map(choice => choice.id), ['claude', 'code-puppy', 'codex']);
});

test('the table of Settings sorts the built-in tools by name too', () => {
  assert.deepEqual(sortedBuiltins([{ id: '', name: 'Shell' }, { id: 'codex', name: 'Codex' }, { id: 'agy', name: 'Antigravity' }]).map(choice => choice.name), ['Antigravity', 'Codex', 'Shell']);
});
