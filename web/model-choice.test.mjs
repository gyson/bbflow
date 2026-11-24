import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinCommand, draftCommand, effortChoices, fitEffort, launchCommand, modelChoices, modelSummary, otherModel } from './dist/model-choice.js';

const codex = { type: 'codex', source: 'codex debug models', loaded: 'now', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: [
  { id: 'gpt-6-luna', name: 'gpt-6-luna', efforts: ['low', 'medium', 'high'], default: 'medium' },
  { id: 'gpt-6-sol', name: 'gpt-6-sol', efforts: ['low', 'ultra'] },
] };
const agy = { type: 'agy', source: 'agy models', loaded: 'now', efforts: [], models: [
  { id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'high'] },
  { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)', efforts: [] },
] };

// These cases match TestCommand in internal/models, so that the view shows the command
// that the server submits.
test('the launch command adds the options of each type at the end', () => {
  assert.equal(launchCommand('codex', 'codex --no-alt-screen', 'gpt-6-luna', 'medium'), 'codex --no-alt-screen --model gpt-6-luna -c model_reasoning_effort=medium');
  assert.equal(launchCommand('codex', 'codex', '', 'high'), 'codex -c model_reasoning_effort=high');
  assert.equal(launchCommand('codex', 'codex', '', ''), 'codex');
  assert.equal(launchCommand('claude', 'claude ', 'opus', 'high'), 'claude --model opus --effort high');
  assert.equal(launchCommand('claude', 'claude', '', 'max'), 'claude --effort max');
  assert.equal(launchCommand('agy', 'agy', 'gemini-4-neon', 'high'), 'agy --model gemini-4-neon-high');
  assert.equal(launchCommand('agy', 'agy', 'gemini-pro-orchestrator-neon', ''), 'agy --model gemini-pro-orchestrator-neon');
  assert.equal(launchCommand('code-puppy', 'code-puppy', 'codex-gpt-6-luna', ''), 'code-puppy --model codex-gpt-6-luna');
  assert.equal(launchCommand('custom', './review.sh', '', ''), './review.sh');
  assert.equal(launchCommand('', '', '', ''), '');
});

test('the model menu keeps a saved model that the list does not have', () => {
  assert.deepEqual(modelChoices(codex, 'gpt-7').map(choice => choice.value), ['', 'gpt-6-luna', 'gpt-6-sol', 'gpt-7', otherModel]);
  assert.deepEqual(modelChoices(null, '').map(choice => choice.value), ['', otherModel]);
});

test('Codex lists the efforts of the chosen model, with its default', () => {
  const luna = effortChoices('codex', codex, 'gpt-6-luna', '', false);
  assert.deepEqual(luna.choices.map(choice => choice.label), ['Model default (Medium)', 'Low', 'Medium', 'High']);
  const any = effortChoices('codex', codex, '', '', false);
  assert.deepEqual(any.choices.map(choice => choice.value), ['', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(fitEffort('codex', codex, 'gpt-6-luna', 'ultra'), '');
  assert.equal(fitEffort('codex', codex, 'gpt-6-sol', 'ultra'), 'ultra');
});

test('Antigravity needs an effort for a model with efforts, and no effort for others', () => {
  assert.equal(fitEffort('agy', agy, 'gemini-4-neon', ''), 'low');
  assert.equal(fitEffort('agy', agy, 'gemini-4-neon', 'high'), 'high');
  assert.equal(fitEffort('agy', agy, 'gemini-pro-orchestrator-neon', 'high'), '');
  assert.deepEqual(effortChoices('agy', agy, 'gemini-4-neon', 'low', false).choices.map(choice => choice.value), ['low', 'high']);
  assert.equal(effortChoices('agy', agy, 'gemini-pro-orchestrator-neon', '', false).show, false);
  assert.equal(effortChoices('agy', agy, '', '', false).show, false);
  assert.equal(effortChoices('agy', agy, 'typed-model-high', '', true).show, false);
});

test('Code Puppy has no effort, and Claude Code has the CLI default first', () => {
  assert.equal(effortChoices('code-puppy', null, 'codex-gpt-6-luna', '', false).show, false);
  assert.equal(fitEffort('code-puppy', null, 'codex-gpt-6-luna', 'high'), '');
  assert.deepEqual(effortChoices('claude', null, 'opus', 'high', false).choices.map(choice => choice.value), ['', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('a summary names the model and the effort', () => {
  assert.equal(modelSummary('codex', 'gpt-6-luna', 'xhigh'), 'gpt-6-luna · XHigh');
  assert.equal(modelSummary('claude', '', ''), 'CLI default');
  assert.equal(modelSummary('custom', '', ''), '');
});

// These cases match TestBuiltinCommand in internal/models.
test('a built-in tool runs its CLI path with the fixed arguments of its type', () => {
  assert.equal(builtinCommand('codex', ''), 'codex --no-alt-screen');
  assert.equal(builtinCommand('codex', '/opt/homebrew/bin/codex'), '/opt/homebrew/bin/codex --no-alt-screen');
  assert.equal(builtinCommand('claude', ''), 'claude');
  assert.equal(builtinCommand('agy', '~/.local/bin/agy'), '~/.local/bin/agy');
});

test('a draft shows the command of the tool that it selects, also Shell before a save', () => {
  const saved = { toolId: 'codex', toolType: 'codex', command: 'codex --no-alt-screen' };
  const tools = [{ id: 'codex', type: 'codex', command: 'codex --no-alt-screen' }, { id: 'claude', type: 'claude', command: 'claude' }];
  assert.equal(draftCommand(saved, 'codex', tools, 'gpt-6-luna', 'high'), 'codex --no-alt-screen --model gpt-6-luna -c model_reasoning_effort=high');
  assert.equal(draftCommand(saved, 'claude', tools, 'opus', ''), 'claude --model opus');
  // Shell has no command, and no model options.
  assert.equal(draftCommand(saved, '', tools, 'gpt-6-luna', 'high'), '');
  // A saved tool that is no longer in Settings keeps its snapshot.
  assert.equal(draftCommand(saved, 'codex', [], '', ''), 'codex --no-alt-screen');
});
