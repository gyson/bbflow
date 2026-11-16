import { element } from './dom.js';
import { call, errorMessage } from './protocol.js';
import type { ServerInfo, Settings } from './protocol.js';
import { sameSettings, savePayload, toolComplete } from './settings-model.js';

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
  private saving = false;
  private queued = false;

  constructor(private readonly server: () => ServerInfo | null, private readonly updateAppearance: () => void) {
    this.form.oninput = () => { this.capture(); this.showStatus(); };
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
      this.load(await call(server, { operation: 'settings-get' }));
      this.error.hidden = true;
    }
    this.panel.hidden = false;
  }

  close(): void { this.panel.hidden = true; }

  // pending is true while the page has a change that the server does not have.
  private pending(): boolean {
    if (!this.draft || !this.saved) return false;
    return this.saving || this.queued || this.draft.tools.some(tool => !toolComplete(tool)) || !sameSettings(savePayload(this.draft, this.saved), this.saved);
  }

  private load(settings: Settings): void {
    this.saved = settings;
    this.draft = structuredClone(settings);
    this.applyAppearance(settings.appearance);
    this.worktree.checked = settings.worktree;
    this.base.value = settings.base;
    this.renderTools();
    this.showStatus();
  }

  private applyAppearance(appearance: string): void {
    this.appearance.value = appearance;
    document.documentElement.dataset.appearance = appearance;
    this.updateAppearance();
  }

  private showStatus(): void {
    if (!this.draft || !this.saved) { this.status.textContent = ''; return; }
    if (this.saving) this.status.textContent = 'Saving…';
    else if (this.draft.tools.some(tool => !toolComplete(tool))) this.status.textContent = 'A tool needs a name and a command before it is saved';
    else if (!sameSettings(savePayload(this.draft, this.saved), this.saved)) this.status.textContent = this.error.hidden ? 'Not saved yet' : 'Not saved';
    else this.status.textContent = 'All settings saved';
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
    this.tools.replaceChildren();
    this.tool.replaceChildren(new Option('Shell', ''));
    for (const [index, preset] of settings.tools.entries()) {
      this.tool.add(new Option(preset.name || 'Unnamed tool', preset.id));
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
        if (label !== 'Name') input.spellcheck = false;
        input.oninput = () => { const option = Array.from(this.tool.options).find(option => option.value === preset.id); if (option) option.textContent = input.value || 'Unnamed tool'; };
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
      row.append(actions); this.tools.append(row);
    }
    this.tool.value = settings.defaultTool;
  }

  private async save(): Promise<void> {
    if (!this.draft || !this.saved) return;
    if (this.saving) { this.queued = true; return; }
    const server = this.server(); if (!server) return;
    const payload = savePayload(this.draft, this.saved);
    // The page again matches the server, for example after the user fixes a rejected value.
    if (sameSettings(payload, this.saved)) { this.error.hidden = true; this.showStatus(); return; }
    this.saving = true; this.error.hidden = true; this.showStatus();
    try {
      this.saved = await call(server, { operation: 'settings-save', settings: payload });
    } catch (error) {
      const latest = await call(server, { operation: 'settings-get' }).catch(() => null);
      if (latest && latest.revision !== this.saved.revision) {
        // Another view or the CLI saved first. Show its settings. Do not merge.
        this.queued = false;
        this.load(latest);
        this.error.textContent = 'Another view or a bbflow command changed the settings first. The page shows the latest settings. Make your last change again.';
      } else this.error.textContent = errorMessage(error);
      this.error.hidden = false;
    } finally {
      this.saving = false;
      if (this.queued) { this.queued = false; void this.save(); } else this.showStatus();
    }
  }
}
