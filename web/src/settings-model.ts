import type { Settings, Tool } from './protocol.js';

// The server rejects a tool without a name or a command.
export function toolComplete(tool: Tool): boolean {
  return tool.name.trim() !== '' && tool.command.trim() !== '';
}

// savePayload returns the settings to save from the page. An incomplete tool stays only
// in the page. If it is a saved tool, the payload keeps its saved version, so a cleared
// field never removes a tool.
export function savePayload(draft: Settings, saved: Settings): Settings {
  const savedTools = new Map(saved.tools.map(tool => [tool.id, tool]));
  const tools: Tool[] = [];
  for (const tool of draft.tools) {
    const source = toolComplete(tool) ? tool : savedTools.get(tool.id);
    if (!source) continue;
    const copy: Tool = { id: source.id, name: source.name.trim(), command: source.command };
    if (source.continueCommand?.trim()) copy.continueCommand = source.continueCommand;
    tools.push(copy);
  }
  const ids = new Set(['', ...tools.map(tool => tool.id)]);
  const defaultTool = ids.has(draft.defaultTool) ? draft.defaultTool : ids.has(saved.defaultTool) ? saved.defaultTool : '';
  return { revision: saved.revision, appearance: draft.appearance, defaultTool, worktree: draft.worktree, base: draft.base || 'HEAD', tools };
}

// sameSettings ignores the revision and the normalization that the server applies.
export function sameSettings(a: Settings, b: Settings): boolean {
  const key = (settings: Settings) => JSON.stringify([
    settings.appearance, settings.defaultTool, settings.worktree, settings.base || 'HEAD',
    settings.tools.map(tool => [tool.id, tool.name.trim(), tool.command, tool.continueCommand?.trim() ? tool.continueCommand : '']),
  ]);
  return key(a) === key(b);
}
