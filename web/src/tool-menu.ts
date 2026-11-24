import type { Tool } from './protocol.js';

// A choice of a tool menu. The empty ID is Shell.
export interface ToolChoice { id: string; name: string }

// byName sorts by name, without regard to case.
const byName = (a: ToolChoice, b: ToolChoice) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// toolGroups returns the choices of a tool menu in two groups. The built-in tools come
// first, with Shell when it is on, sorted by name. The custom tools follow in their saved
// order. Only tools that are on are choices.
export function toolGroups(tools: readonly Tool[], shellOn: boolean): { builtin: ToolChoice[]; custom: ToolChoice[] } {
  const on = tools.filter(tool => tool.enabled);
  const builtin: ToolChoice[] = on.filter(tool => tool.builtin).map(tool => ({ id: tool.id, name: tool.name }));
  if (shellOn) builtin.push({ id: '', name: 'Shell' });
  builtin.sort(byName);
  const custom = on.filter(tool => !tool.builtin).map(tool => ({ id: tool.id, name: tool.name || 'Unnamed tool' }));
  return { builtin, custom };
}

// fillToolMenu shows the two groups in a menu, with a line between them. A browser that
// does not draw a line in a menu ignores it.
export function fillToolMenu(menu: HTMLSelectElement, tools: readonly Tool[], shellOn: boolean): void {
  const { builtin, custom } = toolGroups(tools, shellOn);
  const options = (choices: ToolChoice[]) => choices.map(choice => new Option(choice.name, choice.id));
  const line = builtin.length && custom.length ? [document.createElement('hr')] : [];
  menu.replaceChildren(...options(builtin), ...line, ...options(custom));
}

// sortedBuiltins returns the built-in tools sorted by name, for the table of Settings.
export function sortedBuiltins<T extends ToolChoice>(tools: readonly T[]): T[] {
  return [...tools].sort(byName);
}
