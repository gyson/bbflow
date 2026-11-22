import { element } from './dom.js';
import { call, ConnectionError, errorMessage } from './protocol.js';
import type { ServerInfo, Settings, TitleTool, Tool } from './protocol.js';
import { mergeToolEdit, parsePort, PortField, portStatus, sameTools, SettingsSaves, titleControls } from './settings-model.js';
import type { Defaults, SettingsChange } from './settings-model.js';

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
  private readonly portForm = element('settings-port-form', HTMLFormElement);
  private readonly port = element('settings-port', HTMLInputElement);
  private readonly portError = element('settings-port-error', HTMLElement);
  private readonly portStatus = element('settings-port-status', HTMLElement);
  private readonly error = element('settings-error', HTMLElement);
  private readonly status = element('settings-status', HTMLElement);
  private readonly tools = element('settings-tools', HTMLElement);
  private readonly addTool = toolEditor('add-tool');
  private readonly editTool = toolEditor('edit-tool');
  private readonly toolError = element('tool-error', HTMLElement);
  private readonly titleTool = element('title-tool', HTMLSelectElement);
  private readonly titleSpinner = element('title-spinner', HTMLElement);
  private readonly titleBuiltin = element('title-builtin', HTMLElement);
  private readonly titleCommand = element('title-tool-command', HTMLElement);
  private readonly customForm = element('title-custom', HTMLFormElement);
  private readonly customCommand = element('title-custom-command', HTMLInputElement);
  private readonly customSave = element('title-custom-save', HTMLButtonElement);
  private readonly titleTest = element('title-test', HTMLButtonElement);
  private readonly testResult = element('title-test-result', HTMLElement);
  private readonly testSample = element('title-test-sample', HTMLElement);
  private readonly testOutcome = element('title-test-outcome', HTMLElement);
  private readonly testDetail = element('title-test-detail', HTMLElement);

  private readonly saves: SettingsSaves;
  private renderedBase = '';
  private readonly portField = new PortField();
  // The title tools, their commands, and the sample message of a test come from the
  // server.
  private titleTools: TitleTool[] = [];
  private titleSample = '';
  // The number of the latest title test. A result shows only for the latest test.
  private titleRun = 0;
  // busy reports a running title test or title tool change.
  private busy = false;
  // The tool of a running title tool change. The list shows it until the change ends.
  private settingTool: string | null = null;
  // The tool of the shown test result. A result shows only under this tool.
  private testedTool = '';
  // customOpen reports that the list shows Custom, but Custom is not saved. The custom
  // command field then waits for a command, or keeps a command that failed its test.
  private customOpen = false;
  // The saved custom command that the field showed last. Other text is an edit.
  private renderedCustom = '';
  private editing: Tool | null = null;
  private newToolId = '';
  private toolBusy = false;
  private renderedTools: Tool[] | null = null;

  constructor(private readonly server: () => ServerInfo | null, private readonly updateAppearance: () => void) {
    const connected = (): ServerInfo => {
      const server = this.server();
      if (!server) throw new Error('Settings are unavailable.');
      return server;
    };
    this.saves = new SettingsSaves({
      save: settings => call(connected(), { operation: 'settings-save', settings }),
      get: () => call(connected(), { operation: 'settings-get' }),
      conflict: error => error instanceof ConnectionError && error.fromServer,
    }, () => this.render(), () => this.showStatus());
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
    this.port.onchange = () => this.savePort();
    this.port.oninput = () => {
      this.portField.input(this.port.value, this.saved?.port ?? 0);
      this.showStatus();
    };
    this.portForm.onsubmit = event => { event.preventDefault(); this.savePort(); };
    this.addTool.cancel.onclick = () => this.resetAddTool();
    this.editTool.cancel.onclick = () => this.closeEditor();
    this.addTool.form.oninput = this.editTool.form.oninput = () => this.showStatus();
    this.titleTool.onchange = () => this.selectTitleTool(this.titleTool.value);
    this.customForm.onsubmit = event => { event.preventDefault(); this.saveCustom(); };
    this.customCommand.oninput = () => this.showStatus();
    this.titleTest.onclick = () => void this.testTitleTool();
    this.addTool.form.onsubmit = event => { event.preventDefault(); this.saveTool(this.addTool, null); };
    this.editTool.form.onsubmit = event => {
      event.preventDefault();
      if (this.editing) this.saveTool(this.editTool, this.editing);
    };
    window.addEventListener('beforeunload', event => { if (this.unsaved) event.preventDefault(); });
  }

  get unsaved(): boolean { return this.pending(); }

  private get saved(): Settings | null { return this.saves.saved; }

  async open(): Promise<void> {
    const server = this.server();
    if (!server) return;
    if (!this.titleTools.length) {
      ({ tools: this.titleTools, sample: this.titleSample } = await call(server, { operation: 'title-tools' }));
      this.titleTool.replaceChildren(new Option('None', 'none'), ...this.titleTools.map(tool => new Option(tool.name, tool.id)), new Option('Custom', 'custom'));
    }
    if (!this.pending() && !this.editing) {
      const settings = await call(server, { operation: 'settings-get' });
      if (!this.pending() && !this.editing) {
        this.saves.saved = settings;
        this.render();
      }
    }
    this.panel.hidden = false;
  }

  close(): void { this.panel.hidden = true; }

  private pending(): boolean {
    return this.saves.writes > 0 || Object.keys(this.saves.defaults).length > 0 || this.base.value !== this.renderedBase ||
      this.portField.edited || this.settingTool !== null || this.customOpen || this.customCommand.value !== this.renderedCustom ||
      !!(this.addTool.name.value || this.addTool.command.value) ||
      !!this.editing && (this.editTool.name.value !== this.editing.name || this.editTool.command.value !== this.editing.command);
  }

  private showStatus(): void {
    this.status.textContent = this.saves.writes || this.settingTool !== null ? 'Saving…' : this.pending() ? 'Changes not saved' : 'All settings saved';
  }

  private applyAppearance(appearance: string): void {
    this.appearance.value = appearance;
    document.documentElement.dataset.appearance = appearance;
    this.updateAppearance();
  }

  private render(): void {
    const saved = this.saved;
    if (!saved) return;
    const defaults = this.saves.defaults;
    this.applyAppearance(defaults.appearance ?? saved.appearance);
    this.worktree.checked = defaults.worktree ?? saved.worktree;
    this.updateCheck.checked = defaults.updateCheck ?? saved.updateCheck;
    // Keep any text entered since the last blur or submit.
    if (this.base.value === this.renderedBase) {
      this.renderedBase = defaults.base ?? saved.base;
      this.base.value = this.renderedBase;
    }
    const port = this.portField.render(saved.port);
    if (this.port.value !== port) this.port.value = port;
    const server = this.server();
    this.portStatus.textContent = server ? portStatus(saved.port, server.port) : '';
    this.titleTool.value = this.settingTool ?? (this.customOpen ? 'custom' : saved.titleTool ?? 'none');
    // Keep any text entered in the custom command field since the last render.
    if (this.customCommand.value === this.renderedCustom) {
      this.renderedCustom = saved.titleCommand ?? '';
      this.customCommand.value = this.renderedCustom;
    }
    this.showTitleTool();
    if (!this.renderedTools || !sameTools(saved.tools, this.renderedTools)) {
      this.tool.replaceChildren(new Option('Shell', ''), ...saved.tools.map(tool => new Option(tool.name, tool.id)));
      this.renderTools();
    }
    const defaultTool = defaults.defaultTool ?? saved.defaultTool;
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
      await this.saves.enqueue(() => this.saves.save(change));
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

  // Show the controls of the tool in the list. A built-in tool shows its exact command.
  // Custom shows its command field. None has no command and no test. A running test or
  // change keeps the controls disabled and shows the spinner, also across a render.
  private showTitleTool(): void {
    // Another view or a reload can change the saved tool. Hide a result of another tool.
    if (this.titleTool.value !== this.testedTool) this.testResult.hidden = true;
    const controls = titleControls(this.titleTools, this.titleTool.value, this.saved?.titleTool ?? 'none', this.busy);
    this.titleCommand.textContent = controls.command;
    this.titleBuiltin.hidden = !controls.command;
    this.customForm.hidden = this.customSave.hidden = !controls.custom;
    this.customCommand.disabled = this.customSave.disabled = !controls.select;
    this.titleTest.disabled = !controls.test;
    this.titleTool.disabled = !controls.select;
    this.titleSpinner.hidden = !this.busy;
  }

  // Show the state of a test: the sample message, the outcome, and a note. state is
  // running, passed, or failed. A result without a test shows no sample. The command
  // shows only once, under the list or in the custom command field.
  private showTest(state: 'running' | 'passed' | 'failed', outcome: string, detail = '', sample = true): void {
    this.testResult.className = state;
    this.testSample.textContent = `Sample message: ${this.titleSample}`;
    this.testSample.hidden = !sample;
    this.testOutcome.textContent = outcome;
    this.testDetail.textContent = detail;
    this.testDetail.hidden = !detail;
    this.testResult.hidden = false;
  }

  // The name of a title tool for a message.
  private titleToolName(tool: string): string {
    if (tool === 'custom') return 'Custom';
    return this.titleTools.find(candidate => candidate.id === tool)?.name ?? 'None';
  }

  // A selection in the list starts a title tool change. Custom with a saved command
  // tests it at once. Without one, the command field waits for a command.
  private selectTitleTool(tool: string): void {
    if (tool !== 'custom') {
      this.customOpen = false;
      this.customCommand.value = this.renderedCustom;
      void this.setTitleTool(tool);
      return;
    }
    if (this.saved?.titleCommand) {
      void this.setTitleTool('custom');
      return;
    }
    this.customOpen = true;
    this.testResult.hidden = true;
    this.render();
    this.customCommand.focus({ preventScroll: true });
  }

  // Save and test the command in the custom command field.
  private saveCustom(): void {
    const command = this.customCommand.value.trim();
    if (command) {
      void this.setTitleTool('custom', command);
      return;
    }
    this.testedTool = 'custom';
    this.showTest('failed', '✕ Enter a command for the custom title tool.', '', false);
    this.customCommand.focus({ preventScroll: true });
  }

  // Save a title tool. The server first tests each tool except None with the sample
  // message. A failed test saves nothing. Then the list shows the saved tool again, with
  // the error below it. A custom command that failed stays in its field, so that the
  // user can fix it.
  private async setTitleTool(tool: string, command = ''): Promise<void> {
    const server = this.server();
    if (!server || !this.saved || this.busy) {
      this.render();
      return;
    }
    const name = this.titleToolName(tool);
    this.busy = true;
    this.settingTool = this.testedTool = tool;
    this.render();
    if (tool !== 'none') this.showTest('running', `Testing ${name}. This can take up to 90 seconds.`);
    else this.testResult.hidden = true;
    try {
      const result = await call(server, { operation: 'title-tool-set', settings: { titleTool: tool, titleCommand: command } });
      if (tool === 'custom') this.customCommand.value = this.renderedCustom = result.settings.titleCommand;
      this.customOpen = false;
      this.saves.update(result.settings);
      if (tool !== 'none') this.showTest('passed', `✓ ${name} is configured. Its test made the title “${result.title}” from the sample message.`);
    } catch (error) {
      this.customOpen = tool === 'custom';
      const detail = tool === 'custom' ? 'Fix the command, then click Save and test again.' : tool === 'none' ? '' : 'Fix the problem, then select the tool again.';
      this.showTest('failed', `✕ ${errorMessage(error)}`, detail, tool !== 'none');
    } finally {
      this.busy = false;
      this.settingTool = null;
      // The result stays below the tool that the list shows after the change.
      this.testedTool = this.customOpen ? 'custom' : this.saved?.titleTool ?? 'none';
      this.render();
      (this.customOpen ? this.customCommand : this.titleTool).focus({ preventScroll: true });
    }
  }

  // Run the saved title tool once with the sample message. The test saves nothing.
  private async testTitleTool(): Promise<void> {
    const server = this.server();
    const tool = this.titleTool.value;
    if (!server || tool === 'none' || this.busy) return;
    const name = this.titleToolName(tool);
    const runNumber = ++this.titleRun;
    this.busy = true;
    this.testedTool = tool;
    this.showTitleTool();
    this.showTest('running', `Testing ${name}. This can take up to 90 seconds.`);
    try {
      const result = await call(server, { operation: 'title-test', settings: { titleTool: tool } });
      if (runNumber === this.titleRun && tool === this.titleTool.value) {
        this.showTest('passed', `✓ Test passed. ${name} made the title “${result.title}” from the sample message.`);
      }
    } catch (error) {
      if (runNumber === this.titleRun && tool === this.titleTool.value) {
        this.showTest('failed', `✕ Test failed: ${errorMessage(error)}`, 'Sessions keep their current title when the tool fails.');
      }
    } finally {
      if (runNumber === this.titleRun) {
        this.busy = false;
        this.showTitleTool();
        this.titleTest.focus({ preventScroll: true });
      }
    }
  }

  private saveBase(): void {
    this.renderedBase = this.base.value;
    this.saveDefault('base', this.base.value || 'HEAD');
  }

  // An empty Port field selects the automatic port. Other text must be a whole number.
  // The port saves alone. Its error shows below the field.
  private savePort(): void {
    const port = parsePort(this.port.value);
    if (port === null) {
      this.portError.textContent = 'Enter a port from 1024 to 65535, or leave the field empty for an automatic port.';
      this.portError.hidden = false;
      return;
    }
    if (!this.saved) return;
    const token = this.portField.begin();
    void this.saves.savePort(port).then(() => {
      if (this.portField.done(token, true)) this.portError.hidden = true;
      this.render();
    }, (error: unknown) => {
      if (!this.portField.done(token, false)) return;
      this.portError.textContent = errorMessage(error);
      this.portError.hidden = false;
    });
  }

  private saveDefault<K extends keyof Defaults>(key: K, value: Defaults[K]): void {
    if (!this.saved) return;
    void this.saves.saveDefault(key, value).then(() => {
      this.error.hidden = true;
      this.render();
    }, (error: unknown) => {
      this.error.textContent = errorMessage(error);
      this.error.hidden = false;
    });
  }
}
