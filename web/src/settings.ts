import { element } from './dom.js';
import { call, errorMessage } from './protocol.js';
import type { ServerInfo, Settings, Tool } from './protocol.js';
import { rebaseDraft, sameSettings, savePayload, toolComplete, toolKey } from './settings-model.js';

// SettingsView saves each change automatically. A text field saves when it loses focus.
// Only one save runs at a time. A change during a save starts one more save after it.
export class SettingsView {
  private readonly panel = element('settings-view', HTMLElement);
  private readonly form = element('settings-form', HTMLFormElement);
  private readonly tools = element('settings-tools', HTMLElement);
  private readonly appearance = element('settings-appearance', HTMLSelectElement);
  private readonly tool = element('settings-tool', HTMLSelectElement);
  private readonly worktree = element('settings-worktree', HTMLInputElement);
  private readonly base = element('settings-base', HTMLInputElement);
  private readonly error = element('settings-error', HTMLElement);
  private readonly status = element('settings-status', HTMLElement);
  // saved is the latest server copy. draft is the page state, with incomplete tools.
  private saved: Settings | null = null;
  private draft: Settings | null = null;
  // rejected holds tool edits that the server rejected. The page keeps such an edit and
  // does not send it again until the user changes the tool.
  private readonly rejected = new Map<string, { key: string; error: string }>();
  private merged = false;
  private saving = false;
  private queued = false;

  constructor(private readonly server: () => ServerInfo | null, private readonly updateAppearance: () => void) {
    this.form.oninput = () => { this.capture(); this.merged = false; this.showStatus(); };
    this.form.onchange = event => {
      this.capture();
      if (event.target === this.appearance) this.applyAppearance(this.appearance.value);
      void this.save();
    };
    this.form.onsubmit = event => { event.preventDefault(); this.capture(); void this.save(); };
    element('tool-add', HTMLButtonElement).onclick = () => {
      if (!this.draft) return;
      this.capture();
      this.draft.tools.push({ id: crypto.randomUUID(), name: '', command: '' });
      this.renderTools();
      this.showStatus();
      this.tools.lastElementChild?.querySelector('input')?.focus();
    };
    window.addEventListener('beforeunload', event => { if (this.pending()) event.preventDefault(); });
  }

  async open(): Promise<void> {
    const server = this.server();
    if (!server) return;
    if (!this.pending()) {
      const settings = await call(server, { operation: 'settings-get' });
      this.saved = settings;
      this.show(structuredClone(settings));
      this.error.hidden = true;
    }
    this.panel.hidden = false;
  }

  close(): void { this.panel.hidden = true; }

  // held returns the tools whose current edit the server rejected.
  private held(): Set<string> {
    const held = new Set<string>();
    for (const [id, entry] of this.rejected) {
      const tool = this.draft?.tools.find(tool => tool.id === id);
      if (tool && toolKey(tool) === entry.key) held.add(id); else this.rejected.delete(id);
    }
    return held;
  }

  private payload(): Settings | null {
    return this.draft && this.saved ? savePayload(this.draft, this.saved, this.held()) : null;
  }

  // pending is true while the page has a change that the server does not have.
  private pending(): boolean {
    const payload = this.payload();
    if (!payload || !this.draft || !this.saved) return false;
    return this.saving || this.queued || this.held().size > 0 || this.draft.tools.some(tool => !toolComplete(tool)) || !sameSettings(payload, this.saved);
  }

  // show puts a draft in the form. It keeps the focus and the cursor of a tool field.
  private show(draft: Settings): void {
    this.draft = draft;
    this.applyAppearance(draft.appearance);
    this.worktree.checked = draft.worktree;
    this.base.value = draft.base;
    this.renderTools();
    this.showStatus();
  }

  private applyAppearance(appearance: string): void {
    this.appearance.value = appearance;
    document.documentElement.dataset.appearance = appearance;
    this.updateAppearance();
  }

  private showStatus(): void {
    const payload = this.payload();
    const held = this.held();
    for (const row of this.tools.querySelectorAll<HTMLElement>('.tool-row')) {
      const message = row.querySelector<HTMLElement>('.tool-error');
      const entry = held.has(row.dataset.id ?? '') ? this.rejected.get(row.dataset.id ?? '') : undefined;
      if (message) { message.textContent = entry?.error ?? ''; message.hidden = !entry; }
    }
    if (!payload || !this.draft || !this.saved) this.status.textContent = '';
    else if (this.saving) this.status.textContent = 'Saving…';
    else if (held.size) this.status.textContent = 'A tool has an error. Other changes are saved.';
    else if (this.draft.tools.some(tool => !toolComplete(tool))) this.status.textContent = 'A tool needs a name and a command before it is saved';
    else if (!sameSettings(payload, this.saved)) this.status.textContent = this.error.hidden ? 'Not saved yet' : 'Not saved';
    else this.status.textContent = this.merged ? 'All settings saved, with changes from another view' : 'All settings saved';
  }

  private capture(): void {
    if (!this.draft) return;
    this.draft.appearance = this.appearance.value;
    this.draft.defaultTool = this.tool.value;
    this.draft.worktree = this.worktree.checked;
    this.draft.base = this.base.value;
    for (const row of this.tools.querySelectorAll<HTMLElement>('.tool-row')) {
      const preset = this.draft.tools.find(tool => tool.id === row.dataset.id);
      const fields = row.querySelectorAll('input');
      if (preset && fields[0] && fields[1] && fields[2]) {
        preset.name = fields[0].value; preset.command = fields[1].value;
        if (fields[2].value.trim()) preset.continueCommand = fields[2].value; else delete preset.continueCommand;
      }
    }
  }

  private renderTools(): void {
    const settings = this.draft;
    if (!settings) return;
    const active = document.activeElement;
    const focusRow = active instanceof HTMLInputElement ? active.closest<HTMLElement>('.tool-row') : null;
    const focus = focusRow && active instanceof HTMLInputElement
      ? { id: focusRow.dataset.id, field: Array.from(focusRow.querySelectorAll('input')).indexOf(active), start: active.selectionStart, end: active.selectionEnd }
      : null;
    this.tools.replaceChildren();
    this.tool.replaceChildren(new Option('Shell', ''));
    for (const [index, preset] of settings.tools.entries()) {
      const option = new Option(preset.name || 'Unnamed tool', preset.id);
      this.tool.add(option);
      const row = document.createElement('div');
      row.className = 'tool-row'; row.dataset.id = preset.id;
      for (const [label, value, placeholder, max, required] of [
        ['Name', preset.name, 'Codex 6 Astra', 200, true],
        ['Command', preset.command, 'codex --model=gpt-6-astra', 1000, true],
        ['Continue command', preset.continueCommand ?? '', 'codex --model=gpt-6-astra {prompt}', 1000, false],
      ] as const) {
        const field = document.createElement('label'); field.textContent = label;
        if (!required) { const optional = document.createElement('span'); optional.className = 'optional'; optional.textContent = 'optional'; field.append(optional); }
        const input = document.createElement('input'); input.value = value; input.placeholder = placeholder; input.maxLength = max; input.required = required;
        if (label === 'Name') input.oninput = () => { option.textContent = input.value || 'Unnamed tool'; };
        else input.spellcheck = false;
        field.append(input); row.append(field);
      }
      const actions = document.createElement('div'); actions.className = 'tool-actions';
      for (const [name, offset] of [['Move up', -1], ['Move down', 1], ['Remove', 0]] as const) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = name === 'Move up' ? '↑' : name === 'Move down' ? '↓' : 'Remove';
        button.setAttribute('aria-label', `${name} ${preset.name || 'tool'}`);
        button.disabled = offset === -1 && index === 0 || offset === 1 && index === settings.tools.length - 1;
        button.onclick = () => {
          this.capture();
          if (!offset) { settings.tools.splice(index, 1); if (settings.defaultTool === preset.id) settings.defaultTool = ''; }
          else { settings.tools.splice(index, 1); settings.tools.splice(index + offset, 0, preset); }
          this.renderTools();
          void this.save();
        };
        actions.append(button);
      }
      const error = document.createElement('p'); error.className = 'form-error tool-error'; error.setAttribute('role', 'alert'); error.hidden = true;
      row.append(actions, error); this.tools.append(row);
    }
    this.tool.value = settings.defaultTool;
    if (focus) {
      const input = Array.from(this.tools.querySelectorAll<HTMLElement>('.tool-row')).find(row => row.dataset.id === focus.id)?.querySelectorAll('input')[focus.field];
      if (input) { input.focus(); input.setSelectionRange(focus.start, focus.end); }
    }
  }

  private async save(): Promise<void> {
    if (!this.draft || !this.saved) return;
    if (this.saving) { this.queued = true; return; }
    const server = this.server(); if (!server) return;
    this.saving = true; this.showStatus();
    try { await this.push(server); }
    finally {
      this.saving = false;
      if (this.queued) { this.queued = false; void this.save(); } else this.showStatus();
    }
  }

  // push saves the page. If the server rejects the save, push saves each changed tool
  // alone. It holds each rejected tool, then saves the other changes without them.
  private async push(server: ServerInfo): Promise<void> {
    let payload = this.payload();
    if (!payload || !this.saved) return;
    // The page again matches the server, for example after the user fixes a rejected value.
    if (sameSettings(payload, this.saved)) { this.error.hidden = true; return; }
    const error = await this.send(server, payload);
    if (error === null || error === 'conflict') return;
    const before = new Map(this.saved.tools.map(tool => [tool.id, tool]));
    const changed = payload.tools.filter(tool => { const old = before.get(tool.id); return !old || toolKey(old) !== toolKey(tool); });
    if (!changed.length) { this.showError(error); return; }
    for (const tool of changed) {
      const saved: Settings = this.saved;
      const tools: Tool[] = before.has(tool.id) ? saved.tools.map(old => old.id === tool.id ? tool : old) : [...saved.tools, tool];
      const result = await this.send(server, { ...saved, tools });
      if (result === 'conflict') return;
      if (result !== null) this.rejected.set(tool.id, { key: toolKey(tool), error: result });
    }
    payload = this.payload();
    if (!payload || sameSettings(payload, this.saved)) return;
    const result = await this.send(server, payload);
    if (result !== null && result !== 'conflict') this.showError(result);
  }

  // send returns null after a save, 'conflict' after it rebased the page on newer
  // settings from another client, or the error message.
  private async send(server: ServerInfo, payload: Settings): Promise<string | null> {
    try {
      this.saved = await call(server, { operation: 'settings-save', settings: payload });
      this.error.hidden = true;
      return null;
    } catch (error) {
      const latest = await call(server, { operation: 'settings-get' }).catch(() => null);
      if (!latest || latest.revision === payload.revision || !this.draft || !this.saved) return errorMessage(error);
      // Another view or the CLI saved first. Apply the page changes to its settings.
      this.capture();
      const draft = rebaseDraft(this.draft, this.saved, latest);
      this.saved = latest;
      this.merged = true;
      this.show(draft);
      this.queued = true;
      return 'conflict';
    }
  }

  private showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
  }
}
