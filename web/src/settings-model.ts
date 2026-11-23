import type { Settings, TitleTool, Tool } from './protocol.js';

// A tool edit applies only the fields that the user changed.
export function mergeToolEdit(tools: Tool[], edited: Tool, original?: Tool): Tool[] {
  const index = tools.findIndex(tool => tool.id === edited.id);
  if (!original) return index < 0 ? [...tools, edited] : tools;
  const current = tools[index];
  if (!current) throw new Error('This tool was removed in another view.');
  const updated = [...tools];
  updated[index] = {
    id: current.id,
    name: edited.name === original.name ? current.name : edited.name,
    command: edited.command === original.command ? current.command : edited.command,
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
        defaultTool: settings.defaultTool === id ? '' : settings.defaultTool,
        tools: settings.tools.filter(tool => tool.id !== id),
      };
    },
    reconfirm: () => reconfirm,
  };
}

// The saved values of remote access that a Settings view shows.
export interface RemoteValues {
  host: string;
  login: string;
}

// RemoteChanged is the failure of a remote access save after another client changed
// remote access. saved holds the values of that change. A second save from them is a
// decision of the user to replace them.
export class RemoteChanged extends Error {
  readonly saved: RemoteValues;

  constructor(settings: Settings) {
    const host = settings.remoteHost || 'none';
    const login = settings.remoteLogin || 'none';
    super(`Another view changed remote access. The saved host name is ${host}, and the saved login is ${login}. Click Save again to replace them.`);
    this.saved = { host: settings.remoteHost, login: settings.remoteLogin };
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

  // The two values of remote access save together and alone, as the port does. base
  // holds the saved values that the user edited from. When another client changed
  // remote access since then, the save fails with RemoteChanged and keeps that change.
  // Thus a view with earlier values cannot restore a login that another view removed.
  saveRemote(base: RemoteValues, remoteHost: string, remoteLogin: string): Promise<void> {
    return this.enqueue(() => this.save(settings => {
      if (settings.remoteHost !== base.host || settings.remoteLogin !== base.login) throw new RemoteChanged(settings);
      return { ...settings, remoteHost, remoteLogin };
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
  return a.appearance === b.appearance && a.defaultTool === b.defaultTool &&
    a.worktree === b.worktree && a.base === b.base &&
    a.updateCheck === b.updateCheck && a.port === b.port &&
    a.remoteHost === b.remoteHost && a.remoteLogin === b.remoteLogin && sameTools(a.tools, b.tools);
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

// PortField keeps the state of the Port field. A render shows the saved port only when
// the field has no edit. During a port save, each input is an edit, also when its text
// is the same as the earlier port. A save clears the edit only when no input came after
// the save started.
export class PortField {
  text = '';
  edited = false;
  private inputs = 0;
  private saving = 0;

  input(text: string, saved: number): void {
    this.inputs++;
    this.text = text;
    this.edited = this.saving > 0 || text !== portText(saved);
  }

  render(saved: number): string {
    if (!this.edited) this.text = portText(saved);
    return this.text;
  }

  // reset discards the edit, so that the field shows the saved port again. A running
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

// remoteStatus tells if the saved values turn remote access on.
export function remoteStatus(host: string, login: string): string {
  if (host && login) return `Remote access is on for ${host} and the Tailscale user ${login}.`;
  if (host || login) return 'Remote access is off. It needs both the host name and the login.';
  return 'Remote access is off.';
}

export function sameTools(a: Tool[], b: Tool[]): boolean {
  return a.length === b.length && a.every((tool, index) => {
    const other = b[index]!;
    return tool.id === other.id && tool.name === other.name && tool.command === other.command;
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
