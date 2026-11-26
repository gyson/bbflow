import type { Prompt, Settings, TitleTool, Tool } from './protocol.js';

// A tool edit applies only the fields that the user changed.
export function mergeToolEdit(tools: Tool[], edited: Tool, original?: Tool): Tool[] {
  const index = tools.findIndex(tool => tool.id === edited.id);
  if (!original) return index < 0 ? [...tools, edited] : tools;
  const current = tools[index];
  if (!current) throw new Error('This tool was removed in another view.');
  const updated = [...tools];
  const field = <K extends 'name' | 'command' | 'type' | 'path' | 'permission'>(key: K) => edited[key] === original[key] ? current[key] : edited[key];
  // The model and the effort belong to the type. An edit of one of the three saves all
  // three from the edit.
  const modelEdited = edited.type !== original.type || edited.model !== original.model || edited.effort !== original.effort;
  updated[index] = {
    ...current,
    name: field('name'),
    command: field('command'),
    type: field('type'),
    path: field('path'),
    permission: field('permission'),
    model: modelEdited ? edited.model : current.model,
    effort: modelEdited ? edited.effort : current.effort,
  };
  return updated;
}

// The title tool is not a default. It saves alone, after its test.
export type Defaults = Pick<Settings, 'appearance' | 'defaultTool' | 'worktree' | 'base' | 'updateCheck'>;
export type SettingsChange = (settings: Settings) => Settings;

// The names of the defaults in the status of the Settings view.
export const defaultLabels: Record<keyof Defaults, string> = {
  appearance: 'Appearance',
  defaultTool: 'Default tool',
  worktree: 'Worktree default',
  base: 'Starting branch or commit',
  updateCheck: 'Update check',
};

// statusText is the status of the Settings view. unsaved names each entry that is not
// saved, so that the user knows which field to complete or restore.
export function statusText(saving: boolean, unsaved: string[]): string {
  if (saving) return 'Saving…';
  return unsaved.length ? `Not saved: ${unsaved.join(', ')}` : 'All settings saved';
}

// duplicateName tells if a tool other than id has the name. The CLI selects a tool by
// its name, so the Settings view does not add a second tool with the same name.
export function duplicateName(tools: Tool[], name: string, id: string): boolean {
  return tools.some(tool => tool.id !== id && tool.name === name);
}

export const duplicateNameError = 'Another tool has this name. Enter a different name.';

// toolEdit is the change that adds a tool, or that saves an edit of original. It checks
// the name against the settings of each attempt, because another client can add the
// name before a save after a conflict. An edit that keeps its name can save, also when
// an earlier save made two tools with one name.
export function toolEdit(edited: Tool, original?: Tool): SettingsChange {
  return settings => {
    if (edited.name !== original?.name && duplicateName(settings.tools, edited.name, edited.id)) throw new Error(duplicateNameError);
    return { ...settings, tools: mergeToolEdit(settings.tools, edited, original) };
  };
}

// fallbackTool is the default tool after the default tool turns off or leaves the list:
// Shell when it is on, else the first other tool that is on. It is null when no tool is
// left. It matches history.FallbackTool.
export function fallbackTool(settings: Settings, leaving: string): string | null {
  if (!settings.shellOff && leaving !== '') return '';
  return settings.tools.find(tool => tool.enabled && tool.id !== leaving)?.id ?? null;
}

// nextDefault returns the default tool of the settings after the tool with the ID turns
// off or leaves the list.
function nextDefault(settings: Settings, id: string): string {
  if (settings.defaultTool !== id) return settings.defaultTool;
  const fallback = fallbackTool(settings, id);
  if (fallback === null) throw new Error('This is the only tool that is on. Turn on another tool first.');
  return fallback;
}

// toolSwitch is the change that turns a tool on or off. The empty ID is Shell. A tool that
// is off cannot be the default tool, so turning off the default tool selects the
// fallback tool.
export function toolSwitch(id: string, enabled: boolean): SettingsChange {
  return settings => {
    const defaultTool = enabled ? settings.defaultTool : nextDefault(settings, id);
    if (id === '') return { ...settings, shellOff: !enabled, defaultTool };
    const index = settings.tools.findIndex(tool => tool.id === id);
    if (index < 0) throw new Error('This tool was removed in another view.');
    const tools = [...settings.tools];
    tools[index] = { ...tools[index]!, enabled };
    return { ...settings, tools, defaultTool };
  };
}

// toolRemoval is the change that removes a tool. A removal of the default tool makes
// Shell the default tool. warned tells that the user confirmed this result. Another
// client can make the tool the default tool after the user confirmed. The change then
// keeps the settings, and reconfirm() tells the view to ask again with the warning.
export function toolRemoval(id: string, warned: boolean): { change: SettingsChange; reconfirm: () => boolean } {
  let reconfirm = false;
  return {
    change: settings => {
      reconfirm = settings.defaultTool === id && !warned;
      if (reconfirm) return settings;
      return {
        ...settings,
        defaultTool: nextDefault(settings, id),
        tools: settings.tools.filter(tool => tool.id !== id),
      };
    },
    reconfirm: () => reconfirm,
  };
}

// The limits of the saved prompts. The server checks them too.
export const maxPrompts = 100;
export const maxPromptBytes = 16 * 1024;

// duplicatePromptName tells if a prompt other than id has the name, without regard to
// case. The server rejects such a list, because the ＋ menu shows prompts by name.
export function duplicatePromptName(prompts: Prompt[], name: string, id: string): boolean {
  const key = name.toLowerCase();
  return prompts.some(prompt => prompt.id !== id && prompt.name.toLowerCase() === key);
}

export const duplicatePromptError = 'Another prompt has this name. Enter a different name.';

// promptProblem checks the entry of the prompt editor before a request. It returns the
// first problem and the field to correct, or null.
export function promptProblem(prompts: Prompt[], name: string, text: string, id: string): { field: 'name' | 'text'; message: string } | null {
  // The server counts the characters of a name as code points, as [...name] does.
  if (!name) return { field: 'name', message: 'Enter a name.' };
  if ([...name].length > 200) return { field: 'name', message: 'Use a name of at most 200 characters.' };
  if (/\p{Cc}/u.test(name)) return { field: 'name', message: 'Remove the control characters from the name, such as a tab.' };
  if (duplicatePromptName(prompts, name, id)) return { field: 'name', message: duplicatePromptError };
  if (!text.trim()) return { field: 'text', message: 'Enter the text of the prompt.' };
  if (new TextEncoder().encode(text).length > maxPromptBytes) return { field: 'text', message: 'The text of a prompt can have at most 16 KiB.' };
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) return { field: 'text', message: 'Remove the control characters from the text. Tabs and new lines are allowed.' };
  if (!prompts.some(prompt => prompt.id === id) && prompts.length >= maxPrompts) return { field: 'name', message: `You can save at most ${maxPrompts} prompts. Remove a prompt first.` };
  return null;
}

// promptEdit is the change that adds a prompt, or that saves an edit of original. An
// edit applies only the fields that the user changed, as for the tools. It checks the
// name against the settings of each attempt, because another view can save the name
// first. An add can find its own ID when an earlier attempt saved but its reply did not
// come. The entry of the new attempt then replaces that prompt.
export function promptEdit(edited: Prompt, original?: Prompt): SettingsChange {
  return settings => {
    const prompts = [...settings.prompts];
    const index = prompts.findIndex(prompt => prompt.id === edited.id);
    let next = edited;
    if (original) {
      const current = prompts[index];
      if (!current) throw new Error('This prompt was removed in another view.');
      next = {
        id: current.id,
        name: edited.name === original.name ? current.name : edited.name,
        text: edited.text === original.text ? current.text : edited.text,
      };
    }
    if (next.name !== original?.name && duplicatePromptName(prompts, next.name, next.id)) throw new Error(duplicatePromptError);
    if (index >= 0) prompts[index] = next;
    else prompts.push(next);
    return { ...settings, prompts };
  };
}

// promptRemoval is the change that removes a prompt.
export function promptRemoval(id: string): SettingsChange {
  return settings => ({ ...settings, prompts: settings.prompts.filter(prompt => prompt.id !== id) });
}

// promptMove is the change that moves a prompt up, with a negative offset, or down.
export function promptMove(id: string, offset: number): SettingsChange {
  return settings => {
    const prompts = [...settings.prompts];
    const index = prompts.findIndex(prompt => prompt.id === id);
    if (index < 0) throw new Error('This prompt was removed in another view.');
    const destination = index + offset;
    if (destination < 0 || destination >= prompts.length) return settings;
    const [prompt] = prompts.splice(index, 1);
    prompts.splice(destination, 0, prompt!);
    return { ...settings, prompts };
  };
}

export function samePrompts(a: Prompt[], b: Prompt[]): boolean {
  return a.length === b.length && a.every((prompt, index) => {
    const other = b[index]!;
    return prompt.id === other.id && prompt.name === other.name && prompt.text === other.text;
  });
}

// The two values of remote access. Each has its own field in Settings.
export type RemoteKey = 'remoteHost' | 'remoteLogin';
export type RemoteValues = Pick<Settings, RemoteKey>;

// remoteValue gives the value that the server saves for the text of a field. The server
// saves the host name in lower case, and it removes the spaces around each value.
export function remoteValue(key: RemoteKey, text: string): string {
  return key === 'remoteHost' ? text.trim().toLowerCase() : text.trim();
}

// RemoteChanged is the failure of a click that turns remote access on after another
// client changed the host name or the login. The message names the saved values. A
// second click turns remote access on for them.
export class RemoteChanged extends Error {
  constructor(settings: Settings) {
    const host = settings.remoteHost || 'none';
    const login = settings.remoteLogin || 'none';
    super(`Another view changed remote access. The saved host name is ${host}, and the saved login is ${login}. Turn the switch on again to use them.`);
  }
}

// The server calls of the Settings saves. conflict tells a rejected save that another
// save can cause, such as a revision change.
export interface SettingsService {
  save(settings: Settings): Promise<Settings>;
  get(): Promise<Settings>;
  conflict(error: unknown): boolean;
}

// SettingsSaves runs the saves of one Settings view one at a time. Each save applies its
// change to the latest saved settings. After a conflict, it applies the change again to
// the latest settings. Pending defaults save together. The port and remote access each
// save alone, so a rejected value never joins a save of another setting.
export class SettingsSaves {
  saved: Settings | null = null;
  // A default stays pending until a save with its value succeeds.
  readonly defaults: Partial<Defaults> = {};
  // The pending defaults that the last save of them rejected. No save of them runs.
  readonly rejected = new Set<keyof Defaults>();
  writes = 0;
  private queue = Promise.resolve();

  // changed runs after a change of saved. status runs when writes changes.
  constructor(private readonly service: SettingsService, private readonly changed: () => void, private readonly status: () => void) {}

  enqueue(write: () => Promise<void>): Promise<void> {
    this.writes++;
    this.status();
    const result = this.queue.then(write).finally(() => {
      this.writes--;
      this.status();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async save(change: SettingsChange): Promise<void> {
    if (!this.saved) throw new Error('Settings are unavailable.');
    for (let attempt = 0; ; attempt++) {
      const saved = this.saved;
      const next = change(saved);
      if (sameSettings(next, saved)) return;
      try {
        this.update(await this.service.save(next));
        return;
      } catch (error) {
        if (!this.service.conflict(error) || attempt === 2) throw error;
        const latest = await this.service.get().catch(() => null);
        if (!latest || latest.revision === saved.revision) throw error;
        // A read can reply after a newer title tool change. Keep the newer settings.
        this.update(latest);
      }
    }
  }

  saveDefault<K extends keyof Defaults>(key: K, value: Defaults[K]): Promise<void> {
    this.defaults[key] = value;
    this.rejected.delete(key);
    return this.enqueue(async () => {
      const defaults = { ...this.defaults };
      const keys = Object.keys(defaults) as (keyof Defaults)[];
      try {
        await this.save(settings => {
          const next = { ...settings, ...defaults };
          if (next.defaultTool && !next.tools.some(tool => tool.id === next.defaultTool)) next.defaultTool = settings.defaultTool;
          return next;
        });
      } catch (error) {
        for (const key of keys) {
          if (this.defaults[key] === defaults[key]) this.rejected.add(key);
        }
        throw error;
      }
      for (const key of keys) {
        if (this.defaults[key] !== defaults[key]) continue;
        delete this.defaults[key];
        this.rejected.delete(key);
      }
    });
  }

  // discard removes a pending default, so that it does not join a later save. A save
  // that already runs keeps its copy of the value.
  discard(key: keyof Defaults): void {
    delete this.defaults[key];
    this.rejected.delete(key);
  }

  // discardRejected removes each default that a save rejected. A default that waits for
  // its save, or whose save runs, stays.
  discardRejected(): void {
    for (const key of [...this.rejected]) this.discard(key);
  }

  savePort(port: number): Promise<void> {
    return this.enqueue(() => this.save(settings => ({ ...settings, port })));
  }

  // Each value of remote access saves alone, as the port does. The save keeps the other
  // value of the latest settings. Thus a view with an earlier login cannot restore a
  // login that another view removed.
  saveRemoteValue(key: RemoteKey, value: string): Promise<void> {
    return this.enqueue(() => this.save(settings => ({ ...settings, [key]: value })));
  }

  // The switch of remote access saves alone. It keeps the saved host name and login.
  // Turning it on admits the remote requests for them. Thus it needs the values that the
  // view showed at the click, shown. When the saved values differ, also after a change
  // in another view, the save fails with RemoteChanged. Turning the switch off needs no
  // check.
  saveRemoteSwitch(remoteOn: boolean, shown: RemoteValues): Promise<void> {
    return this.enqueue(() => this.save(settings => {
      if (remoteOn && !settings.remoteOn && (settings.remoteHost !== shown.remoteHost || settings.remoteLogin !== shown.remoteLogin)) {
        throw new RemoteChanged(settings);
      }
      return { ...settings, remoteOn };
    }));
  }

  // update takes the settings that a request outside the queue saved, such as a title
  // tool change. Only a newer revision applies, so a late reply cannot undo a later save.
  update(settings: Settings): void {
    if (this.saved && settings.revision <= this.saved.revision) return;
    this.saved = settings;
    this.changed();
  }
}

// The saved title tool and custom command.
export type TitleChoice = Pick<Settings, 'titleTool' | 'titleCommand'>;

// failedTitleChange returns the state of the Settings view after a failed title tool
// change. tool is the tool of the change. before is the saved choice at the start of the
// change, and after is the saved choice after it, or null when the read failed.
// customOpen keeps Custom in the list only when Custom is not saved. A failed new
// command for a saved Custom then stays in the field as an edit. detail tells what to do.
// When another change of the title tool saved meanwhile, the tool or the command can
// have no fault, so detail tells about that change.
export function failedTitleChange(tool: string, before: TitleChoice, after: TitleChoice | null): { customOpen: boolean; detail: string } {
  const saved = after ?? before;
  const changed = !!after && (after.titleTool !== before.titleTool || after.titleCommand !== before.titleCommand);
  let detail = '';
  if (changed) detail = 'Another change of the title tool saved during the test.';
  else if (tool === 'custom') detail = 'Fix the command, then click Save and test again.';
  else if (tool !== 'none') detail = 'Fix the problem, then select the tool again.';
  return { customOpen: tool === 'custom' && saved.titleTool !== 'custom', detail };
}

// The revision tracks saves. The other fields determine if a save is necessary. A
// settings save keeps the saved title tool and custom title command, so they are not
// among them.
export function sameSettings(a: Settings, b: Settings): boolean {
  return a.appearance === b.appearance && a.defaultTool === b.defaultTool && !!a.shellOff === !!b.shellOff &&
    a.worktree === b.worktree && a.base === b.base &&
    a.updateCheck === b.updateCheck && a.port === b.port &&
    a.remoteOn === b.remoteOn && a.remoteHost === b.remoteHost && a.remoteLogin === b.remoteLogin && sameTools(a.tools, b.tools) &&
    samePrompts(a.prompts ?? [], b.prompts ?? []);
}

// parsePort reads the Port field. An empty field selects the automatic port, 0. Text
// that is not a whole number from 1024 to 65535, or 0, gives null. The server checks the
// range too, and it rejects the ports that browsers refuse.
export function parsePort(text: string): number | null {
  const value = text.trim();
  if (!value) return 0;
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port === 0 || (port >= 1024 && port <= 65535) ? port : null;
}

// portText shows a saved port in the Port field. The automatic port shows an empty field.
export function portText(port: number): string {
  return port ? String(port) : '';
}

// FieldEdit keeps the state of a text field that saves on Enter or blur, such as Port.
// format gives the text of a saved value. A render shows the saved value only when the
// field has no edit. During a save, each input is an edit, also when its text is the
// same as the earlier value. A save clears the edit only when no input came after the
// save started.
export class FieldEdit<T> {
  text = '';
  edited = false;
  private inputs = 0;
  private saving = 0;

  constructor(private readonly format: (saved: T) => string) {}

  input(text: string, saved: T): void {
    this.inputs++;
    this.text = text;
    this.edited = this.saving > 0 || text !== this.format(saved);
  }

  render(saved: T): string {
    if (!this.edited) this.text = this.format(saved);
    return this.text;
  }

  // reset discards the edit, so that the field shows the saved value again. A running
  // save is then not current, and its reply does not change the error of the field.
  reset(): void {
    this.inputs++;
    this.edited = false;
  }

  // begin returns the token for done.
  begin(): number {
    this.saving++;
    return this.inputs;
  }

  // done tells if the save is current: no input came after the save started. Only a
  // current save changes the error of the field. Thus a late reply keeps the error of a
  // newer edit.
  done(token: number, saved: boolean): boolean {
    this.saving--;
    const current = token === this.inputs;
    if (saved && current) this.edited = false;
    return current;
  }
}

// portStatus tells which port the server uses now and when the saved port applies.
export function portStatus(saved: number, current: number): string {
  if (!saved) return `Automatic. The server uses port ${current} now. Later starts use it again when it is free.`;
  if (saved === current) return `The server uses port ${current}.`;
  return `The server uses port ${current} now. It uses port ${saved} after the next server start, when no other program uses that port.`;
}

// remoteStatus tells if the saved switch and values admit remote requests. The switch
// and the values are independent, so the switch can be on without the values.
export function remoteStatus(on: boolean, host: string, login: string): string {
  if (!on) return '';
  if (host && login) return `Remote access is on for ${host} and the Tailscale user ${login}.`;
  return 'The switch is on, but remote access needs both the host name and the login.';
}

export function sameTools(a: Tool[], b: Tool[]): boolean {
  return a.length === b.length && a.every((tool, index) => {
    const other = b[index]!;
    return tool.id === other.id && tool.name === other.name && tool.command === other.command &&
      tool.type === other.type && tool.model === other.model && tool.effort === other.effort && tool.permission === other.permission &&
      tool.builtin === other.builtin && tool.enabled === other.enabled && tool.path === other.path;
  });
}

// The state of the title tool controls. shown is the tool in the list, and saved is the
// saved tool. busy reports a running title test or title tool change. edited reports an
// edit in the custom command field. command is the exact command of a built-in tool.
// custom shows the custom command field. Test needs the saved tool, other than none, and
// no busy state. For Custom, Test also needs a field without edits, because Test runs
// the saved command. testShown shows Test. None has nothing to test, and a Custom that
// is not saved or has an edit shows only Save and test. A save of another setting does
// not change this state.
export function titleControls(tools: TitleTool[], shown: string, saved: string, busy: boolean, edited = false):
  { command: string; custom: boolean; test: boolean; testShown: boolean; select: boolean } {
  const tool = tools.find(tool => tool.id === shown);
  const unsavedCustom = shown === 'custom' && (saved !== 'custom' || edited);
  return {
    command: tool?.command ?? '',
    custom: shown === 'custom',
    test: shown !== 'none' && shown === saved && !busy && !unsavedCustom,
    testShown: shown !== 'none' && !unsavedCustom,
    select: !busy,
  };
}
