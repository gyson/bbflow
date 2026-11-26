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

interface PermissionMode { value: string; label: string; options: string }

// The permission modes of each type, in the order of the menu. The values and the options
// match internal/models. The labels are the names that each CLI shows.
const permissionModes: Record<string, readonly PermissionMode[]> = {
  codex: [
    { value: 'ask', label: 'Ask for approval', options: '--sandbox workspace-write --ask-for-approval on-request -c approvals_reviewer=user' },
    { value: 'approve-for-me', label: 'Approve for me', options: '--approve-for-me' },
    { value: 'read-only', label: 'Read Only', options: '--sandbox read-only --ask-for-approval on-request -c approvals_reviewer=user' },
    { value: 'full-access', label: 'Full Access', options: '--sandbox danger-full-access --ask-for-approval never' },
  ],
  claude: [
    { value: 'manual', label: 'Manual', options: '--permission-mode manual' },
    { value: 'accept-edits', label: 'Accept edits', options: '--permission-mode acceptEdits' },
    { value: 'plan', label: 'Plan', options: '--permission-mode plan' },
    { value: 'auto', label: 'Auto', options: '--permission-mode auto' },
    { value: 'dont-ask', label: "Don't Ask", options: '--permission-mode dontAsk' },
    { value: 'bypass-permissions', label: 'Bypass Permissions', options: '--permission-mode bypassPermissions' },
  ],
  agy: [
    { value: 'accept-edits', label: 'Accept edits', options: '--mode accept-edits' },
    { value: 'auto', label: 'Auto', options: '--mode auto' },
    { value: 'plan', label: 'Plan', options: '--mode plan' },
    { value: 'skip-permissions', label: 'Skip permissions', options: '--dangerously-skip-permissions' },
  ],
  'code-puppy': [
    { value: 'confirm', label: 'YOLO off', options: '--yolo false' },
    { value: 'yolo', label: 'YOLO on', options: '--yolo true' },
  ],
};

// permissionChoices lists the permission modes of a type. The first choice, the CLI
// default, adds no option. A saved mode that the list does not have stays a choice, so
// that the view shows it.
export function permissionChoices(type: string, permission = ''): Choice[] {
  const choices: Choice[] = [{ value: '', label: 'CLI default' }];
  for (const mode of permissionModes[type] ?? []) choices.push({ value: mode.value, label: mode.label });
  if (permission && !choices.some(choice => choice.value === permission)) choices.push({ value: permission, label: permission });
  return choices;
}

// permissionOptions returns the options of a permission mode, or an empty string.
export function permissionOptions(type: string, permission: string): string {
  return permissionModes[type]?.find(mode => mode.value === permission)?.options ?? '';
}

// launchCommand adds the model, effort, and permission options of the type to the command.
export function launchCommand(type: string, command: string, model: string, effort: string, permission = ''): string {
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
  const mode = permissionOptions(type, permission);
  if (mode) options.push(mode);
  return options.length ? `${command.replace(/ +$/, '')} ${options.join(' ')}` : command;
}

// draftCommand returns the command that a draft submits. A draft keeps the snapshot of
// its saved tool. A newly selected tool, which is not saved yet, brings its own type and
// command. Shell, with the empty ID, has no command.
export function draftCommand(saved: { toolId: string; toolType: string; command: string }, selected: string,
  tools: readonly { id: string; type: string; command: string }[], model: string, effort: string, permission: string): string {
  let type = saved.toolType, command = saved.command;
  if (selected !== saved.toolId) {
    const tool = tools.find(candidate => candidate.id === selected);
    type = tool?.type ?? '';
    command = tool?.command ?? '';
  }
  const agent = typed(type);
  return launchCommand(type, command, agent ? model : '', agent ? effort : '', agent ? permission : '');
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
}

const listKey = (server: ServerInfo, type: string) => `${server.instance} ${type}`;

// The pickers of this page. A refresh in one picker updates the others of its type.
const pickers = new Set<ModelPicker>();

function loadList(server: ServerInfo, type: string, refresh: boolean, send: typeof call): Promise<ToolModels> {
  const key = listKey(server, type);
  let list = lists.get(key);
  if (!list || refresh) {
    list = send(server, { operation: 'tool-models', toolType: type, refresh });
    lists.set(key, list);
    list.catch(() => { if (lists.get(key) === list) lists.delete(key); });
  }
  return list;
}

// ModelPicker shows the model and effort controls with one prefix. With permission, it
// also shows the Permissions menu. The fields element holds all controls. It is hidden
// for Shell and for a Custom tool. changed runs after each change by the user. A quiet
// picker shows no notes about the list and the options. It shows only a failure of the
// list, with Refresh list.
export class ModelPicker {
  private readonly fields: HTMLElement;
  private readonly modelSelect: HTMLSelectElement;
  private readonly otherInput: HTMLInputElement;
  private readonly help: HTMLElement;
  private readonly refresh: HTMLButtonElement;
  private readonly effortSelect: HTMLSelectElement;
  private readonly effortHelp: HTMLElement;
  private readonly permissionSelect: HTMLSelectElement | null = null;
  private readonly permissionHelp: HTMLElement | null = null;
  private type = '';
  private chosen = '';
  private chosenEffort = '';
  private chosenPermission = '';
  private other = false;
  private list: ToolModels | null = null;
  private error = '';
  private loading = false;
  private token = 0;
  private locked = false;
  // The shared list that the picker read last. A refresh in another picker replaces the
  // shared list, and the next set reads the new one.
  private from: Promise<ToolModels> | undefined;

  constructor(prefix: string, private readonly host: { server(): ServerInfo | null; changed(): void; send?: typeof call; quiet?: boolean; permission?: boolean }) {
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
    if (host.permission) {
      const select = this.permissionSelect = element(`${prefix}-permission`, HTMLSelectElement);
      this.permissionHelp = element(`${prefix}-permission-help`, HTMLElement);
      select.onchange = () => { this.chosenPermission = select.value; this.render(); this.host.changed(); };
    }
    this.refresh.onclick = () => void this.load(true);
    pickers.add(this);
  }

  get model(): string { return this.chosen; }
  get effort(): string { return this.chosenEffort; }
  get permission(): string { return this.chosenPermission; }

  // set shows the type with a model, an effort, and a permission mode, and loads the model
  // list of the type.
  set(type: string, model: string, effort: string, permission = ''): void {
    const sameType = type === this.type;
    this.type = type; this.chosen = model; this.chosenEffort = effort; this.chosenPermission = permission; this.other = false;
    this.otherInput.value = '';
    const server = this.host.server();
    const shared = server && typed(type) ? lists.get(listKey(server, type)) : undefined;
    if (!sameType || !shared || shared !== this.from) { this.list = null; this.error = ''; }
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
    this.loading = true; this.error = '';
    this.render();
    try {
      const from = loadList(server, type, refresh, this.host.send ?? call);
      this.from = from;
      const list = await from;
      if (token !== this.token) return;
      this.list = list;
      // Only the current shared list goes to the other pickers. An earlier refresh that
      // ends after a later one started is no longer current.
      if (refresh && lists.get(listKey(server, type)) === from) {
        for (const other of pickers) if (other !== this) other.adopt(server, type, from, list);
      }
    } catch (error) {
      if (token !== this.token) return;
      this.error = errorMessage(error);
    }
    this.loading = false;
    this.render();
  }

  // adopt shows a list that another picker refreshed, when this picker shows the same
  // type. The chosen model and effort stay, also a model that the new list does not have.
  private adopt(server: ServerInfo, type: string, from: Promise<ToolModels>, list: ToolModels): void {
    const current = this.host.server();
    if (this.type !== type || !current || listKey(current, type) !== listKey(server, type) || this.from === from) return;
    if (lists.get(listKey(server, type)) !== from) return;
    this.token++;
    this.from = from;
    this.list = list;
    this.error = '';
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
    const select = this.permissionSelect, help = this.permissionHelp;
    if (select && help) {
      select.replaceChildren(...permissionChoices(type, this.chosenPermission).map(choice => new Option(choice.label, choice.value)));
      select.value = this.chosenPermission;
      select.disabled = this.locked;
      const options = permissionOptions(type, this.chosenPermission);
      help.textContent = quiet ? '' : options ? `bbflow adds ${options}.` : 'bbflow adds no option, so the CLI uses its own setting.';
      help.hidden = !help.textContent;
    }
  }
}
