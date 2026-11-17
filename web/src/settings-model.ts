import type { Settings, Tool } from './protocol.js';

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
    a.worktree === b.worktree && a.base === b.base && sameTools(a.tools, b.tools);
}

export function sameTools(a: Tool[], b: Tool[]): boolean {
  return a.length === b.length && a.every((tool, index) => {
    const other = b[index]!;
    return tool.id === other.id && tool.name === other.name && tool.command === other.command;
  });
}
