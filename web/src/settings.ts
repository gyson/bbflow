import { element } from './dom.js';
import { call, ConnectionError, errorMessage } from './protocol.js';
import type { ServerInfo, Settings, Tool } from './protocol.js';
import { rebaseDraft, sameSettings, savePayload, toolComplete, toolKey } from './settings-model.js';

// SettingsView saves each change automatically. A text field saves when it loses focus.
// Only one save runs at a time. A change during a save starts one more save after it.
// Saves send only committed values, so a retry never sends text that is still in edit.

// A send result: saved, a rebase after a conflict, a server rejection, or a transport
// failure. Only a server rejection can hold a tool.
type SendResult = 'saved' | 'conflict' | { rejected: string } | { failed: string };
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
  // saved is the latest server copy. draft is the form state, with incomplete tools and
  // text still in edit. committed is the draft at the last change event or button.
  private saved: Settings | null = null;
  private draft: Settings | null = null;
  private committed: Settings | null = null;
  // rejected holds tool edits that the server rejected. The page keeps such an edit and
  // does not send it again until the user changes the tool.
  private readonly rejected = new Map<string, { key: string; error: string }>();
  private merged = false;
  private rendering = false;
  private saving = false;
  private queued = false;

  constructor(private readonly server: () => ServerInfo | null, private readonly updateAppearance: () => void) {
    this.form.oninput = () => { this.capture(); this.merged = false; this.showStatus(); };
    this.form.onchange = event => {
      // Chrome fires change when a render removes a focused input. That text is still in
      // edit, so do not commit it.
      if (this.rendering || !(event.target instanceof Node && event.target.isConnected)) return;
      this.commit();
      if (event.target === this.appearance) this.applyAppearance(this.appearance.value);
      void this.save();
    };
    this.form.onsubmit = event => { event.preventDefault(); this.commit(); void this.save(); };
    element('tool-add', HTMLButtonElement).onclick = () => {
      if (!this.draft) return;
      this.capture();
      this.draft.tools.push({ id: crypto.randomUUID(), name: '', command: '' });
      this.committed = structuredClone(this.draft);
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
      this.committed = structuredClone(settings);
      this.show(structuredClone(settings));
      this.error.hidden = true;
    }
    this.panel.hidden = false;
  }

  close(): void { this.panel.hidden = true; }

  // held returns the tools whose committed edit the server rejected.
  private held(): Set<string> {
    const held = new Set<string>();
    for (const [id, entry] of this.rejected) {
      const tool = this.committed?.tools.find(tool => tool.id === id);
      if (tool && toolKey(tool) === entry.key) held.add(id); else this.rejected.delete(id);
    }
    return held;
  }

  private payload(): Settings | null {
    return this.committed && this.saved ? savePayload(this.committed, this.saved, this.held()) : null;
  }

  // pending is true while the form has a change that the server does not have.
  private pending(): boolean {
    if (!this.draft || !this.saved) return false;
    return this.saving || this.queued || this.held().size > 0 || this.draft.tools.some(tool => !toolComplete(tool)) || !sameSettings(savePayload(this.draft, this.saved), this.saved);
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
    else if (!sameSettings(savePayload(this.draft, this.saved), this.saved)) this.status.textContent = this.error.hidden ? 'Not saved yet' : 'Not saved';
    else this.status.textContent = this.merged ? 'All settings saved, with changes from another view' : 'All settings saved';
  }

  private commit(): void {
    this.merged = false;
    this.capture();
    if (this.draft) this.committed = structuredClone(this.draft);
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

  // renderTools reuses the row of each tool by its ID and updates its fields in place. It
  // never moves the row with the focus, so the focused input stays mounted. Chrome fires
  // no change event for a new input that gets its text before the focus, so text in edit
  // must stay in its original input to save on blur.
  //
  // The draft always holds the text of each field, because capture runs first. Only a
  // rebase can make a field differ from the draft: the field has no edit since the last
  // commit, so the rebase took the latest value. Thus an update never replaces a pending
  // edit, also in the focused input.
  private renderTools(): void {
    const settings = this.draft;
    if (!settings) return;
    this.rendering = true;
    try {
      const existing = new Map(Array.from(this.tools.querySelectorAll<HTMLElement>('.tool-row')).map(row => [row.dataset.id ?? '', row]));
      const rows = settings.tools.map(preset => existing.get(preset.id) ?? this.createRow(preset.id));
      for (const [id, row] of existing) if (!settings.tools.some(tool => tool.id === id)) row.remove();
      const active = document.activeElement;
      const anchor = rows.findIndex(row => row.contains(active));
      if (anchor < 0) this.tools.append(...rows);
      else {
        for (const row of rows.slice(0, anchor)) this.tools.insertBefore(row, rows[anchor]!);
        let previous = rows[anchor]!;
        for (const row of rows.slice(anchor + 1)) { previous.after(row); previous = row; }
      }
      this.tool.replaceChildren(new Option('Shell', ''));
      for (const [index, preset] of settings.tools.entries()) {
        const row = rows[index]!;
        const values = [preset.name, preset.command, preset.continueCommand ?? ''];
        row.querySelectorAll('input').forEach((input, field) => {
          if (input.value !== values[field]) input.value = values[field] ?? '';
        });
        const name = row.querySelector('input')?.value || 'Unnamed tool';
        this.tool.add(new Option(name, preset.id));
        const buttons = row.querySelectorAll<HTMLButtonElement>('.tool-actions button');
        for (const [position, label] of ['Move up', 'Move down', 'Remove'].entries()) {
          const button = buttons[position];
          if (!button) continue;
          button.setAttribute('aria-label', `${label} ${preset.name || 'tool'}`);
          button.disabled = position === 0 && index === 0 || position === 1 && index === settings.tools.length - 1;
        }
      }
      this.tool.value = settings.defaultTool;
    } finally { this.rendering = false; }
  }

  private createRow(id: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'tool-row'; row.dataset.id = id;
    for (const [label, placeholder, max, required] of [
      ['Name', 'Codex 6 Astra', 200, true],
      ['Command', 'codex --model=gpt-6-astra', 1000, true],
      ['Continue command', 'codex --model=gpt-6-astra {prompt}', 1000, false],
    ] as const) {
      const field = document.createElement('label'); field.textContent = label;
      if (!required) { const optional = document.createElement('span'); optional.className = 'optional'; optional.textContent = 'optional'; field.append(optional); }
      const input = document.createElement('input'); input.placeholder = placeholder; input.maxLength = max; input.required = required;
      if (label === 'Name') {
        input.oninput = () => {
          const option = Array.from(this.tool.options).find(option => option.value === id);
          if (option) option.textContent = input.value || 'Unnamed tool';
        };
      } else input.spellcheck = false;
      field.append(input); row.append(field);
    }
    const actions = document.createElement('div'); actions.className = 'tool-actions';
    for (const [name, offset] of [['Move up', -1], ['Move down', 1], ['Remove', 0]] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = name === 'Move up' ? '↑' : name === 'Move down' ? '↓' : 'Remove';
      button.onclick = () => {
        // Read the current draft. A conflict can replace it after this row is built.
        const draft = this.draft;
        if (!draft) return;
        this.capture();
        const at = draft.tools.findIndex(tool => tool.id === id);
        const tool = draft.tools[at];
        if (!tool) return;
        this.merged = false;
        draft.tools.splice(at, 1);
        if (!offset) { if (draft.defaultTool === tool.id) draft.defaultTool = ''; }
        else draft.tools.splice(Math.max(0, Math.min(draft.tools.length, at + offset)), 0, tool);
        this.committed = structuredClone(draft);
        this.renderTools();
        void this.save();
      };
      actions.append(button);
    }
    const error = document.createElement('p'); error.className = 'form-error tool-error'; error.setAttribute('role', 'alert'); error.hidden = true;
    row.append(actions, error);
    return row;
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

  // push saves the committed changes. If the server rejects the save, push saves each
  // changed tool alone. It holds each rejected tool, then saves the other changes
  // without them. A transport failure holds nothing, so the next change retries all.
  private async push(server: ServerInfo): Promise<void> {
    let payload = this.payload();
    if (!payload || !this.saved) return;
    // The page again matches the server, for example after the user fixes a rejected value.
    if (sameSettings(payload, this.saved)) { this.error.hidden = true; return; }
    const result = await this.send(server, payload);
    if (typeof result !== 'object') return;
    const before = new Map(this.saved.tools.map(tool => [tool.id, tool]));
    const changed = payload.tools.filter(tool => { const old = before.get(tool.id); return !old || toolKey(old) !== toolKey(tool); });
    if ('failed' in result || !changed.length) { this.showError('failed' in result ? result.failed : result.rejected); return; }
    for (const tool of changed) {
      const saved: Settings = this.saved;
      const tools: Tool[] = before.has(tool.id) ? saved.tools.map(old => old.id === tool.id ? tool : old) : [...saved.tools, tool];
      const probe = await this.send(server, { ...saved, tools });
      if (probe === 'conflict') return;
      if (typeof probe === 'object' && 'failed' in probe) { this.showError(probe.failed); return; }
      if (typeof probe === 'object') this.rejected.set(tool.id, { key: toolKey(tool), error: probe.rejected });
    }
    payload = this.payload();
    if (!payload || sameSettings(payload, this.saved)) return;
    const rest = await this.send(server, payload);
    if (typeof rest === 'object') this.showError('failed' in rest ? rest.failed : rest.rejected);
  }

  private async send(server: ServerInfo, payload: Settings): Promise<SendResult> {
    try {
      this.saved = await call(server, { operation: 'settings-save', settings: payload });
      this.error.hidden = true;
      return 'saved';
    } catch (error) {
      if (!(error instanceof ConnectionError && error.fromServer)) return { failed: errorMessage(error) };
      const latest = await call(server, { operation: 'settings-get' }).catch(() => null);
      if (!latest) return { failed: errorMessage(error) };
      if (latest.revision === payload.revision || !this.draft || !this.committed || !this.saved) return { rejected: errorMessage(error) };
      // Another view or the CLI saved first. Apply the committed changes to its
      // settings. Then apply the form changes since the last commit to that result, so a
      // pending edit stays even when it restores the earlier saved value. The retry
      // sends only committed values.
      this.capture();
      const committed = rebaseDraft(this.committed, this.saved, latest);
      const draft = rebaseDraft(this.draft, this.committed, committed);
      this.committed = committed;
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
