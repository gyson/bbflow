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

export type Defaults = Pick<Settings, 'appearance' | 'defaultTool' | 'worktree' | 'base' | 'titleTool' | 'updateCheck'>;
export type SettingsChange = (settings: Settings) => Settings;

// The server calls of the Settings saves. conflict tells a rejected save that another
// save can cause, such as a revision change.
export interface SettingsService {
  save(settings: Settings): Promise<Settings>;
  get(): Promise<Settings>;
  conflict(error: unknown): boolean;
}

// SettingsSaves runs the saves of one Settings view one at a time. Each save applies its
// change to the latest saved settings. After a conflict, it applies the change again to
// the latest settings. Pending defaults save together. The port saves alone, so a
// rejected port never joins a save of another setting.
export class SettingsSaves {
  saved: Settings | null = null;
  // A default stays pending until a save with its value succeeds.
  readonly defaults: Partial<Defaults> = {};
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
        this.saved = await this.service.save(next);
        this.changed();
        return;
      } catch (error) {
        if (!this.service.conflict(error) || attempt === 2) throw error;
        const latest = await this.service.get().catch(() => null);
        if (!latest || latest.revision === saved.revision) throw error;
        this.saved = latest;
        this.changed();
      }
    }
  }

  saveDefault<K extends keyof Defaults>(key: K, value: Defaults[K]): Promise<void> {
    this.defaults[key] = value;
    return this.enqueue(async () => {
      const defaults = { ...this.defaults };
      await this.save(settings => {
        const next = { ...settings, ...defaults };
        if (next.defaultTool && !next.tools.some(tool => tool.id === next.defaultTool)) next.defaultTool = settings.defaultTool;
        return next;
      });
      for (const key of Object.keys(defaults) as (keyof Defaults)[]) {
        if (this.defaults[key] === defaults[key]) delete this.defaults[key];
      }
    });
  }

  savePort(port: number): Promise<void> {
    return this.enqueue(() => this.save(settings => ({ ...settings, port })));
  }
}

// The revision tracks saves. The other fields determine if a save is necessary.
export function sameSettings(a: Settings, b: Settings): boolean {
  return a.appearance === b.appearance && a.defaultTool === b.defaultTool &&
    a.worktree === b.worktree && a.base === b.base && a.titleTool === b.titleTool &&
    a.updateCheck === b.updateCheck && a.port === b.port && sameTools(a.tools, b.tools);
}

// parsePort reads the Port field. An empty field selects the automatic port, 0. Text
// that is not a whole number gives null. The server checks the range.
export function parsePort(text: string): number | null {
  const value = text.trim();
  if (!value) return 0;
  return /^\d{1,5}$/.test(value) ? Number(value) : null;
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

export function sameTools(a: Tool[], b: Tool[]): boolean {
  return a.length === b.length && a.every((tool, index) => {
    const other = b[index]!;
    return tool.id === other.id && tool.name === other.name && tool.command === other.command;
  });
}

// The state of the title tool controls. Test needs a tool and no running test. A save of
// another setting does not change this state.
export function titleControls(tools: TitleTool[], selected: string, testing: boolean): { command: string; test: boolean; select: boolean } {
  const tool = tools.find(tool => tool.id === selected);
  return { command: tool?.command ?? '', test: !!tool && !testing, select: !testing };
}
