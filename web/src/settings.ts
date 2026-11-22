import { element } from './dom.js';
import { call, ConnectionError, errorMessage } from './protocol.js';
import type { ServerInfo, Settings, TitleTool, Tool } from './protocol.js';
import { defaultLabels, duplicateName, duplicateNameError, failedTitleChange, parsePort, PortField, portStatus, sameTools, SettingsSaves, statusText, titleControls, toolEdit, toolRemoval } from './settings-model.js';
import type { Defaults, SettingsChange } from './settings-model.js';

const portRange = 'Enter a port from 1024 to 65535, or leave the field empty for an automatic port.';
const portNotSaved = 'The port did not save.';
const defaultNotSaved = 'A setting did not save.';
const titleToolNotSaved = 'The title tool did not save.';

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
  private readonly removeDialog = element('tool-remove-dialog', HTMLDialogElement);
  private readonly removeForm = element('tool-remove-form', HTMLFormElement);
  private readonly removeCancel = element('cancel-tool-remove', HTMLButtonElement);
  private readonly removeSummary = element('tool-remove-summary', HTMLElement);
  private readonly removeDefault = element('tool-remove-default', HTMLElement);
  private readonly titleCard = element('title-settings', HTMLElement);
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
  // The tool of the open Remove dialog.
  private removing: Tool | null = null;
  private newToolId = '';
  private toolBusy = false;
  private renderedTools: Tool[] | null = null;

  // The number of times that the user left Settings. A request that started before the
  // latest close has no entry in the view any more, and no place for its error.
  private visits = 0;

  // report shows an error toast. It tells about an entry that did not save when the user
  // left Settings, because the view keeps no entry and no error of it. send is the server
  // call. A fixture replaces it to control the time of each reply.
  constructor(private readonly server: () => ServerInfo | null, private readonly updateAppearance: () => void,
    private readonly report: (title: string, detail: string) => void, private readonly send: typeof call = call) {
    const connected = (): ServerInfo => {
      const server = this.server();
      if (!server) throw new Error('Settings are unavailable.');
      return server;
    };
    this.saves = new SettingsSaves({
      save: settings => this.send(connected(), { operation: 'settings-save', settings }),
      get: () => this.send(connected(), { operation: 'settings-get' }),
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
    // Escape restores the saved value of a text field that saves on blur.
    this.base.onkeydown = event => {
      if (event.key === 'Escape' && (this.base.value !== this.renderedBase || this.saves.rejected.has('base'))) this.restoreBase();
    };
    this.port.onkeydown = event => {
      if (event.key === 'Escape' && this.portField.edited) this.restorePort();
    };
    this.form.onsubmit = event => { event.preventDefault(); this.saveBase(); };
    this.port.onchange = () => this.savePort();
    this.port.oninput = () => {
      this.portField.input(this.port.value, this.saved?.port ?? 0);
      // The error is about the earlier text. Leaving Settings reports an error in view.
      this.portError.hidden = true;
      this.showStatus();
    };
    this.portForm.onsubmit = event => { event.preventDefault(); this.savePort(); };
    this.addTool.cancel.onclick = () => this.resetAddTool();
    this.editTool.cancel.onclick = () => this.closeEditor();
    this.addTool.form.oninput = this.editTool.form.oninput = () => this.showStatus();
    this.removeCancel.onclick = () => this.removeDialog.close();
    this.removeForm.onsubmit = event => { event.preventDefault(); this.removeTool(); };
    this.titleTool.onchange = () => this.selectTitleTool(this.titleTool.value);
    this.customForm.onsubmit = event => { event.preventDefault(); this.saveCustom(); };
    this.customCommand.oninput = () => {
      // A result tells about the command that ran. An edit makes the result stale, and
      // Test waits until the edit saves.
      if (this.testedTool === 'custom') this.testResult.hidden = true;
      this.showTitleTool();
      this.showStatus();
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

  private get saved(): Settings | null { return this.saves.saved; }

  async open(): Promise<void> {
    const server = this.server();
    if (!server) return;
    if (!this.titleTools.length) {
      ({ tools: this.titleTools, sample: this.titleSample } = await this.send(server, { operation: 'title-tools' }));
      this.titleTool.replaceChildren(new Option('None', 'none'), ...this.titleTools.map(tool => new Option(tool.name, tool.id)), new Option('Custom', 'custom'));
    }
    if (!this.pending() && !this.editing) {
      const settings = await this.send(server, { operation: 'settings-get' });
      if (!this.pending() && !this.editing) {
        // A title tool change can save while this read runs. Keep the newer settings.
        this.saves.update(settings);
        this.render();
      }
    }
    this.panel.hidden = false;
  }

  // Leave Settings. Entries that are not saved do not stay in the hidden view. There
  // they would block the reload after a server restart, and the browser would warn about
  // them at a close of the tab, with no entry in view. A running save or title tool
  // change continues.
  close(): void {
    this.panel.hidden = true;
    this.visits++;
    if (this.removeDialog.open) this.removeDialog.close();
    // A default that a save rejected does not join a later save from the hidden view.
    // As for the port below, the click on Done can save a field and get the rejection
    // before the click ends, so the toast repeats the error.
    if (this.saves.rejected.size && !this.error.hidden) this.report(defaultNotSaved, this.error.textContent ?? '');
    this.saves.discardRejected();
    this.error.hidden = true;
    this.base.value = this.renderedBase;
    // The click on Done first takes focus from the Port field, and the field saves. The
    // server can reject the port before the click ends. The error of the field is then
    // in view only for a moment, so the toast repeats it. A reply after this close
    // gives its own toast.
    if (this.portField.edited) {
      const reason = !this.portError.hidden ? this.portError.textContent ?? '' : parsePort(this.port.value) === null ? portRange : '';
      if (reason) this.report(portNotSaved, reason);
    }
    this.restorePort();
    // A running title tool change continues. Its end discards the custom entry.
    if (!this.busy) this.discardCustom();
    this.newToolId = '';
    this.addTool.form.reset();
    this.addTool.error.hidden = true;
    if (this.editing) {
      this.editing = null;
      this.editTool.form.hidden = true;
      this.renderTools();
    }
    this.render();
  }

  // The entries that are not saved, by the names that the status shows.
  private unsavedNames(): string[] {
    const names = new Set<string>();
    for (const key of Object.keys(this.saves.defaults) as (keyof Defaults)[]) names.add(defaultLabels[key]);
    if (this.base.value !== this.renderedBase) names.add(defaultLabels.base);
    if (this.portField.edited) names.add('Port');
    if (this.customOpen || this.customCommand.value !== this.renderedCustom) names.add('Custom title command');
    if (this.addTool.name.value || this.addTool.command.value) names.add('New tool');
    if (this.editing && (this.editTool.name.value !== this.editing.name || this.editTool.command.value !== this.editing.command)) {
      names.add(`Edit of ${this.editing.name}`);
    }
    return [...names];
  }

  private saving(): boolean { return this.saves.writes > 0 || this.settingTool !== null; }

  private pending(): boolean { return this.saving() || this.unsavedNames().length > 0; }

  // Clear shows only while the add row has text.
  private showStatus(): void {
    this.status.textContent = statusText(this.saving(), this.unsavedNames());
    this.addTool.cancel.hidden = !(this.addTool.name.value || this.addTool.command.value);
  }

  // Show the saved starting branch or commit again. A rejected value does not stay
  // pending.
  private restoreBase(): void {
    this.saves.discard('base');
    this.base.value = this.renderedBase;
    if (!this.saves.rejected.size) this.error.hidden = true;
    this.render();
  }

  // Discard a custom title command that is not saved, and the result of its test.
  private discardCustom(): void {
    if (!this.customOpen && this.customCommand.value === this.renderedCustom) return;
    this.customOpen = false;
    this.customCommand.value = this.renderedCustom;
    this.testResult.hidden = true;
  }

  // Show the saved port again, and hide the error of the discarded text.
  private restorePort(): void {
    this.portField.reset();
    this.portError.hidden = true;
    this.render();
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
      action('Remove', 'Remove', () => this.confirmRemove(tool));
      row.append(name, command, actions);
      rows.push(row);
    }
    // Keep the forms mounted so a settings refresh cannot interrupt an edit.
    this.tools.querySelectorAll(':scope > div.tool-row').forEach(row => row.remove());
    this.editTool.form.before(...before);
    this.addTool.form.before(...after);
    if (focusedRowButton) document.getElementById(focusedRowButton.id)?.focus({ preventScroll: true });
  }

  // A removal has no undo, so a dialog asks first. It also tells when the removal changes
  // the default tool.
  private confirmRemove(tool: Tool): void {
    if (!this.saved || this.toolBusy) return;
    this.removing = tool;
    this.toolError.hidden = true;
    this.removeSummary.textContent = `“${tool.name}” leaves the tool list. Drafts and sessions that use it keep their own copy of the command. A removal has no undo.`;
    this.removeDefault.textContent = `“${tool.name}” is the default tool. After the removal, Shell is the default tool.`;
    this.removeDefault.hidden = this.saved.defaultTool !== tool.id;
    this.removeDialog.showModal();
  }

  // The close of the dialog returns focus to Remove of the row. The change then moves
  // focus to the nearest row. Another view or the CLI can make the tool the default tool
  // while the dialog is open. Then the removal does not save, and the dialog opens again
  // with the warning about the default tool.
  private removeTool(): void {
    const tool = this.removing;
    const warned = !this.removeDefault.hidden;
    this.removing = null;
    this.removeDialog.close();
    if (!tool) return;
    const removal = toolRemoval(tool.id, warned);
    void this.changeTool(removal.change, `The removal of “${tool.name}” did not save.`).then(() => {
      const latest = this.saved?.tools.find(current => current.id === tool.id);
      if (removal.reconfirm() && latest && !this.panel.hidden) this.confirmRemove(latest);
    });
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
    // An edit that keeps its name can save, also when an earlier save made a duplicate.
    // This check gives the error without a request. The change checks the name again
    // against the latest settings, which can have a tool from another view or the CLI.
    if (name !== original?.name && duplicateName(this.saved.tools, name, id)) {
      editor.error.textContent = duplicateNameError;
      editor.error.hidden = false;
      editor.name.focus();
      return;
    }
    const failure = original ? `The edit of “${original.name}” did not save.` : `The new tool “${name}” did not save.`;
    void this.changeTool(toolEdit({ id, name, command }, original ?? undefined), failure, editor.error, () => {
      if (original) this.closeEditor();
      else this.resetAddTool();
    });
  }

  private moveTool(id: string, offset: number): void {
    const name = this.saved?.tools.find(tool => tool.id === id)?.name ?? '';
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
    }, `The move of “${name}” did not save.`);
  }

  private setToolBusy(busy: boolean): void {
    this.toolBusy = busy;
    for (const editor of [this.addTool, this.editTool]) {
      editor.name.disabled = editor.command.disabled = editor.submit.disabled = editor.cancel.disabled = busy;
    }
  }

  // Save a change of the tools. failure names the action for the error toast. The toast
  // shows when the user left Settings before the reply, because the close discarded the
  // entry of the row. Otherwise the error shows in error.
  private async changeTool(change: SettingsChange, failure: string, error = this.toolError, done?: () => void): Promise<void> {
    if (this.toolBusy) return;
    const visit = this.visits;
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
      if (visit !== this.visits) this.report(failure, errorMessage(cause));
      else {
        error.textContent = errorMessage(cause);
        error.hidden = false;
      }
    } finally {
      this.setToolBusy(false);
      this.renderTools();
      // After a close, the rows have no entry of this change to reset.
      if (saved && done && visit === this.visits) done();
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
    const edited = this.customCommand.value !== this.renderedCustom;
    const controls = titleControls(this.titleTools, this.titleTool.value, this.saved?.titleTool ?? 'none', this.busy, edited);
    this.titleCommand.textContent = controls.command;
    this.titleBuiltin.hidden = !controls.command;
    this.customForm.hidden = this.customSave.hidden = !controls.custom;
    this.customCommand.disabled = this.customSave.disabled = !controls.select;
    this.titleTest.disabled = !controls.test;
    this.titleTest.hidden = !controls.testShown;
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
  // tests it at once. Without one, the command field waits for a command. The view sends
  // the custom command that it shows, so the test runs that command, also after another
  // view saves another one.
  private selectTitleTool(tool: string): void {
    if (tool !== 'custom') {
      this.customOpen = false;
      this.customCommand.value = this.renderedCustom;
      void this.setTitleTool(tool);
      return;
    }
    if (this.saved?.titleCommand) {
      void this.setTitleTool('custom', this.saved.titleCommand);
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
  // user can fix it. The list keeps Custom only when Custom is not saved.
  private async setTitleTool(tool: string, command = ''): Promise<void> {
    const server = this.server();
    if (!server || !this.saved || this.busy) {
      this.render();
      return;
    }
    const name = this.titleToolName(tool);
    const before = { titleTool: this.saved.titleTool, titleCommand: this.saved.titleCommand };
    const visit = this.visits;
    this.busy = true;
    this.settingTool = this.testedTool = tool;
    this.render();
    if (tool !== 'none') this.showTest('running', `Testing ${name}. This can take up to 90 seconds.`);
    else this.testResult.hidden = true;
    try {
      const result = await this.send(server, { operation: 'title-tool-set', settings: { titleTool: tool, titleCommand: command } });
      if (tool === 'custom') this.customCommand.value = this.renderedCustom = result.settings.titleCommand;
      this.customOpen = false;
      this.saves.update(result.settings);
      if (tool !== 'none') this.showTest('passed', `✓ ${name} is configured. Its test made the title “${result.title}” from the sample message.`);
    } catch (error) {
      // Another change can save during the test. Read the settings, so that the list
      // shows the saved tool.
      const latest = await this.send(server, { operation: 'settings-get' }).catch(() => null);
      if (latest) this.saves.update(latest);
      const failed = failedTitleChange(tool, before, latest);
      this.customOpen = failed.customOpen;
      this.showTest('failed', `✕ ${errorMessage(error)}`, failed.detail, tool !== 'none');
      // The user left Settings during the test. The view keeps no entry of the change,
      // so a toast tells about the failure.
      if (visit !== this.visits) {
        this.discardCustom();
        this.report(titleToolNotSaved, errorMessage(error));
      }
    } finally {
      this.busy = false;
      this.settingTool = null;
      // The result stays below the tool that the list shows after the change.
      this.testedTool = this.customOpen ? 'custom' : this.saved?.titleTool ?? 'none';
      this.render();
      this.focusTitle(this.customOpen ? this.customCommand : this.titleTool);
    }
  }

  // Move focus to a title control at the end of a test, only when focus is not in
  // another field. A test can run for 90 seconds, and the user can type in another field
  // meanwhile. A blur there would save a partial value.
  private focusTitle(control: HTMLElement): void {
    const active = document.activeElement;
    if (!active || active === document.body || this.titleCard.contains(active)) control.focus({ preventScroll: true });
  }

  // Run the saved title tool once with the sample message. The test saves nothing. For
  // Custom, the view sends the saved command that the field shows.
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
      const titleCommand = tool === 'custom' ? this.customCommand.value : '';
      const result = await this.send(server, { operation: 'title-test', settings: { titleTool: tool, titleCommand } });
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
        this.focusTitle(this.titleTest);
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
      this.portError.textContent = portRange;
      this.portError.hidden = false;
      return;
    }
    if (!this.saved) return;
    const visit = this.visits;
    const token = this.portField.begin();
    void this.saves.savePort(port).then(() => {
      if (this.portField.done(token, true)) this.portError.hidden = true;
      this.render();
    }, (error: unknown) => {
      if (!this.portField.done(token, false)) {
        if (visit !== this.visits) this.report(portNotSaved, errorMessage(error));
        return;
      }
      this.portError.textContent = errorMessage(error);
      this.portError.hidden = false;
    });
  }

  private saveDefault<K extends keyof Defaults>(key: K, value: Defaults[K]): void {
    if (!this.saved) return;
    const visit = this.visits;
    void this.saves.saveDefault(key, value).then(() => {
      this.error.hidden = true;
      this.render();
    }, (error: unknown) => {
      // The user left Settings before the reply. The rejected default does not stay
      // pending, so a toast tells about it.
      if (visit !== this.visits) {
        this.saves.discardRejected();
        this.report(defaultNotSaved, errorMessage(error));
        this.render();
        return;
      }
      this.error.textContent = errorMessage(error);
      this.error.hidden = false;
    });
  }
}
