import { element } from './dom.js';
import { call, errorMessage } from './protocol.js';
import type { ServerInfo, ToolModels } from './protocol.js';

// These rules match internal/models. The server builds the launch command. The view
// builds the same command only to show it.

// typed tells if bbflow adds model options for the type.
export function typed(type: string): boolean {
  return type === 'codex' || type === 'claude' || type === 'agy' || type === 'code-puppy';
}

export function effortName(effort: string): string {
  if (effort === 'xhigh') return 'XHigh';
  return effort ? effort[0]!.toUpperCase() + effort.slice(1) : effort;
}

// builtinCommand is the command of a built-in tool: its CLI path, or the plain CLI name,
// then the fixed arguments of its type. It matches models.BuiltinCommand.
export function builtinCommand(type: string, path: string): string {
  const program = path || type;
  return type === 'codex' ? `${program} --no-alt-screen` : program;
}

// launchCommand adds the model and effort options of the type to the command.
export function launchCommand(type: string, command: string, model: string, effort: string): string {
  const options: string[] = [];
  if (type === 'codex') {
    if (model) options.push(`--model ${model}`);
    if (effort) options.push(`-c model_reasoning_effort=${effort}`);
  } else if (type === 'claude') {
    if (model) options.push(`--model ${model}`);
    if (effort) options.push(`--effort ${effort}`);
  } else if (type === 'agy') {
    // Antigravity names the effort in the model ID.
    if (model) options.push(`--model ${effort ? `${model}-${effort}` : model}`);
  } else if (type === 'code-puppy') {
    if (model) options.push(`--model ${model}`);
  }
  return options.length ? `${command.replace(/ +$/, '')} ${options.join(' ')}` : command;
}

// draftCommand returns the command that a draft submits. A draft keeps the snapshot of
// its saved tool. A newly selected tool, which is not saved yet, brings its own type and
// command. Shell, with the empty ID, has no command.
export function draftCommand(saved: { toolId: string; toolType: string; command: string }, selected: string,
  tools: readonly { id: string; type: string; command: string }[], model: string, effort: string): string {
  let type = saved.toolType, command = saved.command;
  if (selected !== saved.toolId) {
    const tool = tools.find(candidate => candidate.id === selected);
    type = tool?.type ?? '';
    command = tool?.command ?? '';
  }
  return launchCommand(type, command, typed(type) ? model : '', typed(type) ? effort : '');
}

// modelSummary is the short text of a model and an effort, such as "gpt-6-luna · Medium".
export function modelSummary(type: string, model: string, effort: string): string {
  if (!typed(type)) return '';
  const name = model || 'CLI default';
  return effort ? `${name} · ${effortName(effort)}` : name;
}

export interface Choice { value: string; label: string }

// The value of the Other choice. A model name starts with a letter or a digit.
export const otherModel = '*other';

// The efforts of Codex and Claude Code for the CLI default model, before the list loads.
const defaultEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];

// modelChoices lists the models of a type. A saved model that is not in the list stays a
// choice, so that the view shows it.
export function modelChoices(list: ToolModels | null, model: string): Choice[] {
  const choices: Choice[] = [{ value: '', label: 'CLI default' }];
  for (const m of list?.models ?? []) choices.push({ value: m.id, label: m.name });
  if (model && !choices.some(choice => choice.value === model)) choices.push({ value: model, label: model });
  choices.push({ value: otherModel, label: 'Other…' });
  return choices;
}

export interface EffortChoices { show: boolean; choices: Choice[]; note: string }

// effortChoices lists the efforts of a model. other tells that the user types the model.
export function effortChoices(type: string, list: ToolModels | null, model: string, effort: string, other: boolean): EffortChoices {
  const known = other ? undefined : list?.models.find(m => m.id === model);
  const choices = (values: string[], first?: string): Choice[] => {
    const result = first === undefined ? [] : [{ value: '', label: first }];
    for (const value of values) result.push({ value, label: effortName(value) });
    if (effort && !values.includes(effort)) result.push({ value: effort, label: effortName(effort) });
    return result;
  };
  switch (type) {
    case 'codex':
      if (known) return { show: true, choices: choices(known.efforts, known.default ? `Model default (${effortName(known.default)})` : 'Model default'), note: 'bbflow adds -c model_reasoning_effort.' };
      return { show: true, choices: choices(list?.efforts.length ? list.efforts : defaultEfforts, 'CLI default'), note: 'bbflow adds -c model_reasoning_effort.' };
    case 'claude':
      return { show: true, choices: choices(list?.efforts.length ? list.efforts : defaultEfforts, 'CLI default'), note: 'bbflow adds --effort.' };
    case 'agy':
      if (other) return { show: false, choices: [], note: 'Type the whole model ID, with its effort.' };
      if (!model) return { show: false, choices: [], note: 'Choose a model to choose its effort.' };
      if (known && !known.efforts.length) return { show: false, choices: [], note: 'This model has no effort levels.' };
      if (!known && !effort) return { show: false, choices: [], note: '' };
      return { show: true, choices: choices(known?.efforts ?? []), note: 'Antigravity names the effort in the model ID.' };
    case 'code-puppy':
      return { show: false, choices: [], note: 'Code Puppy has no effort option.' };
  }
  return { show: false, choices: [], note: '' };
}

// fitEffort keeps the effort after a change of the model when the new model has it. For
// Antigravity, a model with efforts needs one, because the effort is part of its ID.
export function fitEffort(type: string, list: ToolModels | null, model: string, effort: string): string {
  const known = list?.models.find(m => m.id === model);
  if (type === 'code-puppy') return '';
  if (type === 'codex') return known && effort && !known.efforts.includes(effort) ? '' : effort;
  if (type === 'agy') {
    if (!known || !known.efforts.length) return '';
    if (known.efforts.includes(effort)) return effort;
    return known.efforts.includes('medium') ? 'medium' : known.efforts[0]!;
  }
  return effort;
}

// The model lists of this page, by server instance and tool type. The server keeps them
// too. A refresh runs the list command again.
const lists = new Map<string, Promise<ToolModels>>();

// forgetModelLists drops the lists of this page. A change of the CLI path of a built-in
// tool changes the program that prints its list.
export function forgetModelLists(): void {
  lists.clear();
  forgotten++;
}

// The number of times that the page dropped its lists. A picker reads its list again
// when this number changed since its last read.
let forgotten = 0;

function loadList(server: ServerInfo, type: string, refresh: boolean, send: typeof call): Promise<ToolModels> {
  const key = `${server.instance} ${type}`;
  let list = lists.get(key);
  if (!list || refresh) {
    list = send(server, { operation: 'tool-models', toolType: type, refresh });
    lists.set(key, list);
    list.catch(() => { if (lists.get(key) === list) lists.delete(key); });
  }
  return list;
}

// ModelPicker shows the model and effort controls with one prefix. The fields element
// holds all controls. It is hidden for Shell and for a Custom tool. changed runs after
// each change by the user. A quiet picker shows no notes about the list and the
// options. It shows only a failure of the list, with Refresh list.
export class ModelPicker {
  private readonly fields: HTMLElement;
  private readonly modelSelect: HTMLSelectElement;
  private readonly otherInput: HTMLInputElement;
  private readonly help: HTMLElement;
  private readonly refresh: HTMLButtonElement;
  private readonly effortSelect: HTMLSelectElement;
  private readonly effortHelp: HTMLElement;
  private type = '';
  private chosen = '';
  private chosenEffort = '';
  private other = false;
  private list: ToolModels | null = null;
  private error = '';
  private loading = false;
  private token = 0;
  private locked = false;
  // The value of forgotten at the last read of the list.
  private read = 0;

  constructor(prefix: string, private readonly host: { server(): ServerInfo | null; changed(): void; send?: typeof call; quiet?: boolean }) {
    this.fields = element(`${prefix}-models`, HTMLElement);
    this.modelSelect = element(`${prefix}-model`, HTMLSelectElement);
    this.otherInput = element(`${prefix}-model-other`, HTMLInputElement);
    this.help = element(`${prefix}-model-help`, HTMLElement);
    this.refresh = element(`${prefix}-model-refresh`, HTMLButtonElement);
    this.effortSelect = element(`${prefix}-effort`, HTMLSelectElement);
    this.effortHelp = element(`${prefix}-effort-help`, HTMLElement);
    this.modelSelect.onchange = () => {
      const value = this.modelSelect.value;
      this.other = value === otherModel;
      if (this.other) {
        this.chosen = this.otherInput.value.trim();
        if (this.type === 'agy') this.chosenEffort = '';
      } else {
        this.chosen = value;
        this.chosenEffort = fitEffort(this.type, this.list, value, this.chosenEffort);
      }
      this.render();
      if (this.other) this.otherInput.focus();
      this.host.changed();
    };
    this.otherInput.oninput = () => { this.chosen = this.otherInput.value.trim(); this.render(); this.host.changed(); };
    this.effortSelect.onchange = () => { this.chosenEffort = this.effortSelect.value; this.render(); this.host.changed(); };
    this.refresh.onclick = () => void this.load(true);
  }

  get model(): string { return this.chosen; }
  get effort(): string { return this.chosenEffort; }

  // set shows the type with a model and an effort, and loads the model list of the type.
  set(type: string, model: string, effort: string): void {
    const sameType = type === this.type;
    this.type = type; this.chosen = model; this.chosenEffort = effort; this.other = false;
    this.otherInput.value = '';
    if (!sameType || this.read !== forgotten) { this.list = null; this.error = ''; }
    this.render();
    if (!this.list) void this.load(false);
  }

  set disabled(disabled: boolean) {
    this.locked = disabled;
    this.render();
  }

  private async load(refresh: boolean): Promise<void> {
    const server = this.host.server(), type = this.type;
    if (!server || !typed(type)) return;
    const token = ++this.token;
    this.read = forgotten;
    this.loading = true; this.error = '';
    this.render();
    try {
      const list = await loadList(server, type, refresh, this.host.send ?? call);
      if (token !== this.token) return;
      this.list = list;
    } catch (error) {
      if (token !== this.token) return;
      this.error = errorMessage(error);
    }
    this.loading = false;
    this.render();
  }

  private render(): void {
    const type = this.type;
    this.fields.hidden = !typed(type);
    if (!typed(type)) return;
    const value = this.other ? otherModel : this.chosen;
    const choices = modelChoices(this.list, this.other ? '' : this.chosen);
    this.modelSelect.replaceChildren(...choices.map(choice => new Option(choice.label, choice.value)));
    this.modelSelect.value = value;
    this.otherInput.hidden = !this.other;
    if (this.other) this.otherInput.value = this.otherInput.value || this.chosen;
    const builtin = type === 'claude';
    this.refresh.hidden = builtin || this.loading;
    const quiet = !!this.host.quiet;
    if (quiet) {
      this.help.textContent = this.error ? `${this.error} Choose Other to type a model name.` : '';
      this.refresh.hidden = !this.error;
    } else if (this.loading) this.help.textContent = 'Loading the model list…';
    else if (this.error) this.help.textContent = `${this.error} Choose Other to type a model name.`;
    else if (builtin) this.help.textContent = 'Built-in suggestions. Claude Code has no command that lists models. Choose Other to type any full name.';
    else if (this.list) this.help.textContent = `Suggestions from ${this.list.source}.`;
    else this.help.textContent = '';
    const efforts = effortChoices(type, this.list, this.chosen, this.chosenEffort, this.other);
    this.effortSelect.hidden = !efforts.show;
    this.effortSelect.replaceChildren(...efforts.choices.map(choice => new Option(choice.label, choice.value)));
    this.effortSelect.value = this.chosenEffort;
    this.effortHelp.textContent = quiet ? '' : efforts.note;
    // An empty note takes no space.
    const note = this.help.parentElement;
    if (note) note.hidden = !this.help.textContent && this.refresh.hidden;
    this.effortHelp.hidden = !this.effortHelp.textContent;
    this.modelSelect.disabled = this.otherInput.disabled = this.effortSelect.disabled = this.refresh.disabled = this.locked;
  }
}
