import type { Settings, Tool } from './protocol.js';

// The server rejects a tool without a name or a command.
export function toolComplete(tool: Tool): boolean {
  return tool.name.trim() !== '' && tool.command.trim() !== '';
}

// toolKey ignores the normalization that the server applies to a tool.
export function toolKey(tool: Tool): string {
  return JSON.stringify([tool.name.trim(), tool.command, tool.continueCommand?.trim() ? tool.continueCommand : '']);
}

// savePayload returns the settings to save from the page. An incomplete tool, or a held
// tool that the server rejected, stays only in the page. If it is a saved tool, the
// payload keeps its saved version, so a cleared field never removes a tool.
export function savePayload(draft: Settings, saved: Settings, held: ReadonlySet<string> = new Set()): Settings {
  const savedTools = new Map(saved.tools.map(tool => [tool.id, tool]));
  const tools: Tool[] = [];
  for (const tool of draft.tools) {
    const source = toolComplete(tool) && !held.has(tool.id) ? tool : savedTools.get(tool.id);
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
    settings.appearance, settings.defaultTool, settings.worktree, settings.base || 'HEAD', settings.tools.map(tool => [tool.id, toolKey(tool)]),
  ]);
  return key(a) === key(b);
}

// rebaseDraft applies the page changes since base to latest. Another client saved
// latest. A value that the page did not change takes the value from latest.
export function rebaseDraft(draft: Settings, base: Settings, latest: Settings): Settings {
  const baseTools = new Map(base.tools.map(tool => [tool.id, tool]));
  const draftTools = new Map(draft.tools.map(tool => [tool.id, tool]));
  const edited = (tool: Tool) => { const old = baseTools.get(tool.id); return !old || toolKey(old) !== toolKey(tool); };
  const tools: Tool[] = [];
  for (const tool of latest.tools) {
    const mine = draftTools.get(tool.id);
    if (!mine && baseTools.has(tool.id)) continue; // The page removed this tool.
    tools.push(structuredClone(mine && edited(mine) ? mine : tool));
  }
  // Keep tools added in the page, and tools edited in the page that latest removed.
  const ids = new Set(tools.map(tool => tool.id));
  for (const mine of draft.tools) if (!ids.has(mine.id) && edited(mine)) tools.push(structuredClone(mine));
  // If the page moved tools, keep that order. Other tools keep their positions.
  const draftOrder = draft.tools.map(tool => tool.id).filter(id => baseTools.has(id));
  const baseOrder = base.tools.map(tool => tool.id).filter(id => draftTools.has(id));
  if (draftOrder.join() !== baseOrder.join()) {
    const order = new Map(draftOrder.map((id, index) => [id, index]));
    const slots = tools.flatMap((tool, index) => order.has(tool.id) ? [index] : []);
    const moved = slots.map(index => tools[index]!).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    slots.forEach((slot, index) => { tools[slot] = moved[index]!; });
  }
  const pick = <T>(mine: T, old: T, theirs: T): T => mine === old ? theirs : mine;
  let defaultTool = pick(draft.defaultTool, base.defaultTool, latest.defaultTool);
  if (defaultTool && !tools.some(tool => tool.id === defaultTool)) defaultTool = tools.some(tool => tool.id === latest.defaultTool) ? latest.defaultTool : '';
  return {
    revision: latest.revision,
    appearance: pick(draft.appearance, base.appearance, latest.appearance),
    defaultTool,
    worktree: pick(draft.worktree, base.worktree, latest.worktree),
    base: pick(draft.base, base.base, latest.base),
    tools,
  };
}
