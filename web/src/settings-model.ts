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
