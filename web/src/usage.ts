import { element } from './dom.js';
import { call, errorMessage } from './protocol.js';
import type { ServerInfo, Tool, ToolUsage, UsageWindow } from './protocol.js';

// The tool types that have a usage check.
const checkedTypes = ['codex', 'claude', 'agy'];

// usageTools returns the built-in tools that have a usage check and are on, sorted by
// name, like the tool menus.
export function usageTools(tools: readonly Tool[]): Tool[] {
  return tools.filter(tool => tool.builtin && tool.enabled && checkedTypes.includes(tool.type))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// The part of a limit that is left, in whole percent.
export function left(window: UsageWindow): number {
  return Math.max(0, Math.min(100, Math.round(100 - window.used)));
}

// A limit is low with less than 20 percent left, and empty with nothing left.
export function level(window: UsageWindow): 'ok' | 'low' | 'empty' {
  const part = left(window);
  return part <= 0 ? 'empty' : part < 20 ? 'low' : 'ok';
}

// The name of a limit. A limit for one model names the model.
export function windowName(window: UsageWindow): string {
  return window.model ? `${window.label} (${window.model})` : window.label;
}

// The time until a reset, such as "in 3 h 52 min".
export function untilText(ms: number): string {
  let minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  minutes %= 60;
  if (hours < 24) return minutes ? `in ${hours} h ${minutes} min` : `in ${hours} h`;
  return hours % 24 ? `in ${Math.floor(hours / 24)} d ${hours % 24} h` : `in ${hours / 24} d`;
}

// locale is the locale of the time formats. Tests set it. The page uses the locale of the browser.
const clock = (date: Date, locale?: string) => date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });

// The reset of a limit, such as "Resets 6:32 AM · in 3 h 52 min". A reset on another day
// names the day: the weekday within 6 days, else the date.
export function resetText(resets: string | undefined, now: Date, locale?: string): string {
  if (!resets) return '';
  const date = new Date(resets);
  if (Number.isNaN(date.getTime())) return '';
  let day = '';
  if (date.toDateString() !== now.toDateString()) {
    day = date.getTime() - now.getTime() < 6 * 86400000
      ? `${date.toLocaleDateString(locale, { weekday: 'short' })} `
      : `${date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}, `;
  }
  return `Resets ${day}${clock(date, locale)} · ${untilText(date.getTime() - now.getTime())}`;
}

// The time of a check, such as "10:41 AM".
export function checkedText(checked: string | undefined, locale?: string): string {
  if (!checked) return '';
  const date = new Date(checked);
  return Number.isNaN(date.getTime()) ? '' : clock(date, locale);
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text) item.textContent = text;
  return item;
}

// The Usage dialog shows the usage limits of the built-in agent tools that are on. Each
// tool has its own request, so a slow CLI does not delay the others. A request reuses a
// check of the server that is less than a minute old. Check now asks each CLI again.
export class UsageDialog {
  private readonly dialog = element('usage-dialog', HTMLDialogElement);
  private readonly list = element('usage-list', HTMLElement);
  private readonly check = element('usage-check', HTMLButtonElement);
  private tools: Tool[] = [];
  private readonly reports = new Map<string, ToolUsage>();
  // The error of a request that the server did not answer with a report.
  private readonly failures = new Map<string, string>();
  private readonly pending = new Set<string>();
  // A close ends the requests of the dialog. Their answers then change nothing.
  private generation = 0;

  // tools runs with the tools of the settings that the dialog reads.
  constructor(private readonly host: { server(): ServerInfo | null, tools(tools: readonly Tool[]): void }) {
    element('usage-close', HTMLButtonElement).onclick = element('usage-done', HTMLButtonElement).onclick = () => this.dialog.close();
    this.check.onclick = () => this.load(true);
    this.dialog.addEventListener('close', () => { this.generation++; });
  }

  // Open the dialog with the tools of the saved settings, then check each tool.
  async open(): Promise<void> {
    const server = this.host.server();
    if (!server) return;
    const settings = await call(server, { operation: 'settings-get' });
    this.generation++;
    this.tools = usageTools(settings.tools);
    this.host.tools(settings.tools);
    this.reports.clear();
    this.failures.clear();
    this.pending.clear();
    this.render();
    this.dialog.showModal();
    this.load(false);
  }

  private load(refresh: boolean): void {
    const server = this.host.server();
    if (!server) return;
    const generation = this.generation;
    for (const tool of this.tools) {
      if (this.pending.has(tool.type)) continue;
      this.pending.add(tool.type);
      call(server, { operation: 'tool-usage', toolType: tool.type, refresh }).then(report => {
        if (generation !== this.generation) return;
        this.reports.set(tool.type, report);
        this.failures.delete(tool.type);
      }, error => {
        if (generation !== this.generation) return;
        this.failures.set(tool.type, errorMessage(error));
      }).finally(() => {
        if (generation !== this.generation) return;
        this.pending.delete(tool.type);
        this.render();
      });
    }
    this.render();
  }

  private render(): void {
    const now = new Date();
    if (!this.tools.length) {
      this.list.replaceChildren(node('p', 'form-help', 'No agent tool with a usage check is on. Turn on Codex, Claude Code, or Antigravity in Settings.'));
    } else {
      this.list.replaceChildren(...this.tools.map(tool => this.section(tool, now)));
    }
    this.check.disabled = !this.tools.length || this.pending.size > 0;
    this.check.textContent = this.pending.size ? 'Checking…' : 'Check now';
  }

  private section(tool: Tool, now: Date): HTMLElement {
    const report = this.reports.get(tool.type);
    const failure = this.failures.get(tool.type);
    const busy = this.pending.has(tool.type);
    const section = node('section', 'usage-tool');
    section.setAttribute('aria-busy', String(busy));
    const head = node('div', 'usage-tool-head');
    head.append(node('h3', '', tool.name));
    if (report?.plan) head.append(node('span', 'usage-plan', report.plan.toUpperCase()));
    if (busy) head.append(node('span', 'usage-state', 'Checking…'));
    else if (report?.checked) head.append(node('span', 'usage-state', `Checked ${checkedText(report.checked)}`));
    section.append(head);
    const groups = report?.groups ?? [];
    for (const group of groups) {
      if (group.name && groups.length > 1) section.append(node('h4', 'usage-group', group.name));
      for (const window of group.windows ?? []) section.append(this.row(window, now));
    }
    if (failure) section.append(node('p', 'form-error', failure));
    else if (report?.error && groups.length) {
      section.append(node('p', 'form-warning', `The last check failed. These values are from ${checkedText(report.checked)}. ${report.error}`));
    } else if (report?.error) section.append(node('p', 'form-error', report.error));
    else if (!report && !busy) section.append(node('p', 'form-help', 'No check yet.'));
    return section;
  }

  private row(window: UsageWindow, now: Date): HTMLElement {
    const row = node('div', `usage-window ${level(window)}`);
    const name = windowName(window);
    const part = left(window);
    const bar = node('span', 'usage-bar');
    bar.setAttribute('role', 'meter');
    bar.setAttribute('aria-label', `${name} limit left`);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(part));
    const fill = node('span', '');
    fill.style.width = `${part}%`;
    bar.append(fill);
    row.append(node('span', 'usage-name', name), bar, node('span', 'usage-left', `${part}% left`), node('span', 'usage-reset', resetText(window.resets, now)));
    return row;
  }
}
