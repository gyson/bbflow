import { element } from './dom.js';
import { call, ConnectionError, errorMessage } from './protocol.js';
import type { ServerInfo, Settings, TitleTool, Tool } from './protocol.js';
import { mergeToolEdit, sameSettings, sameTools, titleControls } from './settings-model.js';

type Defaults = Pick<Settings, 'appearance' | 'defaultTool' | 'worktree' | 'base' | 'titleTool' | 'updateCheck'>;
type SettingsChange = (settings: Settings) => Settings;

// Test sends this message to the title tool in place of a real first message.
const titleSample = 'The login page redirects to a blank page after sign-in. Find the cause and fix it.';

function toolEditor(prefix: string) {
  return {
    form: element(`${prefix}-editor`, HTMLFormElement),
    name: element(`${prefix}-name`, HTMLInputElement),
    command: element(`${prefix}-command`, HTMLInputElement),
    submit: element(`${prefix}-submit`, HTMLButtonElement),
    cancel: element(`${prefix}-cancel`, HTMLButtonElement),
    error: element(`${prefix}-error`, HTMLElement),
  };
}

type ToolEditor = ReturnType<typeof toolEditor>;

export class SettingsView {
  private readonly panel = element('settings-view', HTMLElement);
  private readonly form = element('settings-form', HTMLFormElement);
  private readonly appearance = element('settings-appearance', HTMLSelectElement);
  private readonly tool = element('settings-tool', HTMLSelectElement);
  private readonly worktree = element('settings-worktree', HTMLInputElement);
  private readonly base = element('settings-base', HTMLInputElement);
  private readonly updateCheck = element('settings-update-check', HTMLInputElement);
  private readonly error = element('settings-error', HTMLElement);
  private readonly status = element('settings-status', HTMLElement);
  private readonly tools = element('settings-tools', HTMLElement);
  private readonly addTool = toolEditor('add-tool');
  private readonly editTool = toolEditor('edit-tool');
  private readonly toolError = element('tool-error', HTMLElement);
  private readonly titleTool = element('title-tool', HTMLSelectElement);
  private readonly titleCommand = element('title-tool-command', HTMLElement);
  private readonly titleTest = element('title-test', HTMLButtonElement);
  private readonly testResult = element('title-test-result', HTMLElement);
  private readonly testSample = element('title-test-sample', HTMLElement);
  private readonly testOutcome = element('title-test-outcome', HTMLElement);
  private readonly testDetail = element('title-test-detail', HTMLElement);

  private saved: Settings | null = null;
  private defaults: Partial<Defaults> = {};
  private renderedBase = '';
  // The title tools and their commands come from the server.
  private titleTools: TitleTool[] = [];
  // The number of the latest title test. A result shows only for the latest test.
  private titleRun = 0;
  private testing = false;
  // The tool of the shown test result. A result shows only under this tool.
  private testedTool = '';
  private editing: Tool | null = null;
  private newToolId = '';
  private toolBusy = false;
  private renderedTools: Tool[] | null = null;
  private queue = Promise.resolve();
  private writes = 0;

  constructor(private readonly server: () => ServerInfo | null, private readonly updateAppearance: () => void) {
    this.appearance.onchange = () => {
      this.applyAppearance(this.appearance.value);
      this.saveDefault('appearance', this.appearance.value);
    };
    this.tool.onchange = () => this.saveDefault('defaultTool', this.tool.value);
    this.worktree.onchange = () => this.saveDefault('worktree', this.worktree.checked);
    this.updateCheck.onchange = () => this.saveDefault('updateCheck', this.updateCheck.checked);
    this.base.onchange = () => this.saveBase();
    this.base.oninput = () => this.showStatus();
    this.form.onsubmit = event => { event.preventDefault(); this.saveBase(); };
    this.addTool.cancel.onclick = () => this.resetAddTool();
    this.editTool.cancel.onclick = () => this.closeEditor();
    this.addTool.form.oninput = this.editTool.form.oninput = () => this.showStatus();
    this.titleTool.onchange = () => {
      // A test result applies only to the tool that it tested.
      this.testResult.hidden = true;
      this.showTitleTool();
      this.saveDefault('titleTool', this.titleTool.value);
    };
    this.titleTest.onclick = () => void this.testTitleTool();
    this.addTool.form.onsubmit = event => { event.preventDefault(); this.saveTool(this.addTool, null); };
    this.editTool.form.onsubmit = event => {
      event.preventDefault();
      if (this.editing) this.saveTool(this.editTool, this.editing);
    };
    window.addEventListener('beforeunload', event => { if (this.unsaved) event.preventDefault(); });
  }

  get unsaved(): boolean { return this.pending(); }

  async open(): Promise<void> {
    const server = this.server();
    if (!server) return;
    if (!this.titleTools.length) {
      this.titleTools = await call(server, { operation: 'title-tools' });
      this.titleTool.replaceChildren(new Option('None', 'none'), ...this.titleTools.map(tool => new Option(tool.name, tool.id)));
    }
    if (!this.pending() && !this.editing) {
      const settings = await call(server, { operation: 'settings-get' });
      if (!this.pending() && !this.editing) {
        this.saved = settings;
        this.render();
      }
    }
    this.panel.hidden = false;
  }

  close(): void { this.panel.hidden = true; }

  private pending(): boolean {
    return this.writes > 0 || Object.keys(this.defaults).length > 0 || this.base.value !== this.renderedBase ||
      !!(this.addTool.name.value || this.addTool.command.value) ||
      !!this.editing && (this.editTool.name.value !== this.editing.name || this.editTool.command.value !== this.editing.command);
  }

  private showStatus(): void {
    this.status.textContent = this.writes ? 'Saving…' : this.pending() ? 'Changes not saved' : 'All settings saved';
  }

  private applyAppearance(appearance: string): void {
    this.appearance.value = appearance;
    document.documentElement.dataset.appearance = appearance;
    this.updateAppearance();
  }

  private render(): void {
    const saved = this.saved;
    if (!saved) return;
    this.applyAppearance(this.defaults.appearance ?? saved.appearance);
    this.worktree.checked = this.defaults.worktree ?? saved.worktree;
    this.updateCheck.checked = this.defaults.updateCheck ?? saved.updateCheck;
    // Keep any text entered since the last blur or submit.
    if (this.base.value === this.renderedBase) {
      this.renderedBase = this.defaults.base ?? saved.base;
      this.base.value = this.renderedBase;
    }
    this.titleTool.value = this.defaults.titleTool ?? saved.titleTool ?? 'none';
    this.showTitleTool();
    if (!this.renderedTools || !sameTools(saved.tools, this.renderedTools)) {
      this.tool.replaceChildren(new Option('Shell', ''), ...saved.tools.map(tool => new Option(tool.name, tool.id)));
      this.renderTools();
    }
    const defaultTool = this.defaults.defaultTool ?? saved.defaultTool;
    this.tool.value = !defaultTool || saved.tools.some(tool => tool.id === defaultTool) ? defaultTool : saved.defaultTool;
    this.showStatus();
  }

  private renderTools(): void {
    const tools = this.saved?.tools ?? [];
    this.renderedTools = tools;
    const locked = this.toolBusy || !!this.editing;
    const focused = document.activeElement;
    const focusedRowButton = focused instanceof HTMLButtonElement && this.tools.contains(focused) && !focused.form ? focused : null;
    const before: HTMLDivElement[] = [];
    const after: HTMLDivElement[] = [];
    let rows = before;
    for (const [index, tool] of tools.entries()) {
      if (tool.id === this.editing?.id) {
        rows = after;
        continue;
      }
      const row = document.createElement('div');
      row.className = 'tool-row';
      row.dataset.toolId = tool.id;
      const name = document.createElement('span');
      name.textContent = tool.name;
      const command = document.createElement('code');
      command.textContent = tool.command;
      const actions = document.createElement('div');
      actions.className = 'tool-actions';
      const action = (label: string, text: string, click: () => void, disabled = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.id = `tool-${label.toLowerCase().replace(' ', '-')}-${tool.id}`;
        button.textContent = text;
        button.setAttribute('aria-label', `${label} ${tool.name}`);
        button.disabled = locked || disabled;
        button.onclick = click;
        actions.append(button);
      };
      action('Edit', 'Edit', () => this.openEditor(tool));
      action('Move up', '↑', () => this.moveTool(tool.id, -1), index === 0);
      action('Move down', '↓', () => this.moveTool(tool.id, 1), index === tools.length - 1);
      action('Remove', 'Remove', () => void this.changeTool(settings => ({
        ...settings,
        defaultTool: settings.defaultTool === tool.id ? '' : settings.defaultTool,
        tools: settings.tools.filter(current => current.id !== tool.id),
      })));
      row.append(name, command, actions);
      rows.push(row);
    }
    // Keep the forms mounted so a settings refresh cannot interrupt an edit.
    this.tools.querySelectorAll(':scope > div.tool-row').forEach(row => row.remove());
    this.editTool.form.before(...before);
    this.addTool.form.before(...after);
    if (focusedRowButton) document.getElementById(focusedRowButton.id)?.focus({ preventScroll: true });
  }

  private openEditor(original: Tool): void {
    if (!this.saved || this.editing || this.toolBusy) return;
    this.editing = original;
    this.editTool.name.value = original.name;
    this.editTool.command.value = original.command;
    this.editTool.error.hidden = true;
    this.editTool.form.hidden = false;
    this.renderTools();
    this.editTool.name.focus({ preventScroll: true });
  }

  private closeEditor(): void {
    const id = this.editing?.id;
    this.editing = null;
    this.editTool.form.hidden = true;
    this.renderTools();
    this.showStatus();
    const edit = id ? document.getElementById(`tool-edit-${id}`) : null;
    (edit ?? this.addTool.name).focus({ preventScroll: true });
  }

  private resetAddTool(): void {
    this.newToolId = '';
    this.addTool.form.reset();
    this.addTool.error.hidden = true;
    this.showStatus();
    this.addTool.name.focus();
  }

  private saveTool(editor: ToolEditor, original: Tool | null): void {
    if (!this.saved || this.toolBusy) return;
    const name = editor.name.value.trim();
    const command = editor.command.value;
    if (!name || !command.trim()) {
      editor.error.textContent = 'Enter a name and a command.';
      editor.error.hidden = false;
      (!name ? editor.name : editor.command).focus();
      return;
    }
    const id = original?.id ?? (this.newToolId ||= crypto.randomUUID());
    const edited = { id, name, command };
    void this.changeTool(settings => ({
      ...settings,
      tools: mergeToolEdit(settings.tools, edited, original ?? undefined),
    }), editor.error, () => {
      if (original) this.closeEditor();
      else this.resetAddTool();
    });
  }

  private moveTool(id: string, offset: number): void {
    void this.changeTool(settings => {
      const tools = [...settings.tools];
      const index = tools.findIndex(tool => tool.id === id);
      if (index < 0) throw new Error('This tool was removed in another view.');
      const destination = index + offset;
      if (destination < 0 || destination >= tools.length) return settings;
      const tool = tools[index]!;
      tools.splice(index, 1);
      tools.splice(destination, 0, tool);
      return { ...settings, tools };
    });
  }

  private setToolBusy(busy: boolean): void {
    this.toolBusy = busy;
    for (const editor of [this.addTool, this.editTool]) {
      editor.name.disabled = editor.command.disabled = editor.submit.disabled = editor.cancel.disabled = busy;
    }
  }

  private async changeTool(change: SettingsChange, error = this.toolError, done?: () => void): Promise<void> {
    if (this.toolBusy) return;
    const focused = document.activeElement;
    const toolId = focused?.closest<HTMLElement>('#settings-tools > [data-tool-id]')?.dataset.toolId;
    const index = this.saved?.tools.findIndex(tool => tool.id === toolId) ?? -1;
    this.setToolBusy(true);
    error.hidden = true;
    this.renderTools();
    let saved = false;
    try {
      await this.enqueue(() => this.save(change));
      saved = true;
    } catch (cause) {
      error.textContent = errorMessage(cause);
      error.hidden = false;
    } finally {
      this.setToolBusy(false);
      this.renderTools();
      if (saved && done) done();
      else if (focused instanceof HTMLButtonElement && toolId && index >= 0 &&
          document.activeElement === document.body && !this.panel.hidden) {
        this.restoreToolFocus(focused.id, toolId, index);
      }
    }
  }

  private restoreToolFocus(buttonId: string, toolId: string, index: number): void {
    const button = document.getElementById(buttonId);
    if (button instanceof HTMLButtonElement && !button.disabled) {
      button.focus();
      return;
    }
    const tools = this.saved?.tools ?? [];
    const tool = tools.find(tool => tool.id === toolId) ?? tools[Math.min(index, tools.length - 1)];
    const edit = tool ? document.getElementById(`tool-edit-${tool.id}`) : null;
    (edit ?? this.addTool.name).focus();
  }

  // Show the command of the selected title tool. None has no command and no test. A
  // running test keeps Test and the list disabled, also across a render.
  private showTitleTool(): void {
    // Another view or a reload can change the saved tool. Hide a result of another tool.
    if (this.titleTool.value !== this.testedTool) this.testResult.hidden = true;
    const controls = titleControls(this.titleTools, this.titleTool.value, this.testing);
    this.titleCommand.textContent = controls.command;
    this.titleCommand.parentElement!.hidden = !controls.command;
    this.titleTest.disabled = !controls.test;
    this.titleTool.disabled = !controls.select;
  }

  // Show the state of a test: the sample message, then the outcome, then a note. state is
  // running, passed, or failed.
  private showTest(state: 'running' | 'passed' | 'failed', outcome: string, detail = ''): void {
    this.testResult.className = state;
    this.testSample.textContent = `Sample message: ${titleSample}`;
    this.testOutcome.textContent = outcome;
    this.testDetail.textContent = detail;
    this.testDetail.hidden = !detail;
    this.testResult.hidden = false;
  }

  // Run the selected title tool once with a sample message. The test saves nothing.
  private async testTitleTool(): Promise<void> {
    const server = this.server();
    const tool = this.titleTool.value;
    if (!server || tool === 'none' || this.testing) return;
    const run = ++this.titleRun;
    this.testing = true;
    this.testedTool = tool;
    this.showTitleTool();
    this.showTest('running', 'Testing the title tool…');
    try {
      const result = await call(server, { operation: 'title-test', settings: { titleTool: tool }, text: titleSample });
      if (run === this.titleRun && tool === this.titleTool.value) this.showTest('passed', `✓ Test passed. The tool made the title “${result.title}” from the sample message.`);
    } catch (error) {
      if (run === this.titleRun && tool === this.titleTool.value) this.showTest('failed', `✕ Test failed: ${errorMessage(error)}`,
        'Sessions keep their current title when the tool fails.');
    } finally {
      if (run === this.titleRun) {
        this.testing = false;
        this.showTitleTool();
        this.titleTest.focus({ preventScroll: true });
      }
    }
  }

  private saveBase(): void {
    this.renderedBase = this.base.value;
    this.saveDefault('base', this.base.value || 'HEAD');
  }

  private saveDefault<K extends keyof Defaults>(key: K, value: Defaults[K]): void {
    if (!this.saved) return;
    this.defaults[key] = value;
    void this.enqueue(async () => {
      const defaults = { ...this.defaults };
      try {
        await this.save(settings => {
          const next = { ...settings, ...defaults };
          if (next.defaultTool && !next.tools.some(tool => tool.id === next.defaultTool)) next.defaultTool = settings.defaultTool;
          return next;
        });
        for (const key of Object.keys(defaults) as (keyof Defaults)[]) {
          if (this.defaults[key] === defaults[key]) delete this.defaults[key];
        }
        this.error.hidden = true;
        this.render();
      } catch (error) {
        this.error.textContent = errorMessage(error);
        this.error.hidden = false;
      }
    });
  }

  // Serialize writes from the defaults and the Tools card.
  private enqueue(write: () => Promise<void>): Promise<void> {
    this.writes++;
    this.showStatus();
    const result = this.queue.then(write).finally(() => {
      this.writes--;
      this.showStatus();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  // Reapply the requested change to the latest settings after a revision conflict.
  private async save(change: SettingsChange): Promise<void> {
    const server = this.server();
    if (!server || !this.saved) throw new Error('Settings are unavailable.');
    for (let attempt = 0; ; attempt++) {
      const saved = this.saved;
      const next = change(saved);
      if (sameSettings(next, saved)) return;
      try {
        this.saved = await call(server, { operation: 'settings-save', settings: next });
        this.render();
        return;
      } catch (error) {
        if (!(error instanceof ConnectionError && error.fromServer) || attempt === 2) throw error;
        const latest = await call(server, { operation: 'settings-get' }).catch(() => null);
        if (!latest || latest.revision === saved.revision) throw error;
        this.saved = latest;
        this.render();
      }
    }
  }
}
