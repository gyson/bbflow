import { element } from './dom.js';
import { fillToolMenu, sortedBuiltins } from './tool-menu.js';
import { builtinCommand, forgetModelLists, launchCommand, modelSummary, ModelPicker, typed } from './model-choice.js';
import { call, ConnectionError, errorMessage } from './protocol.js';
import type { ServerInfo, Settings, TitleTool, Tool } from './protocol.js';
import { defaultLabels, duplicateName, duplicateNameError, failedTitleChange, FieldEdit, parsePort, portStatus, portText, remoteStatus, remoteValue, fallbackTool, sameTools, SettingsSaves, statusText, titleControls, toolEdit, toolRemoval, toolSwitch } from './settings-model.js';
import type { Defaults, RemoteKey, RemoteValues, SettingsChange } from './settings-model.js';

const portRange = 'Enter a port from 1024 to 65535, or leave the field empty for an automatic port.';
const portNotSaved = 'The port did not save.';
const remoteNotSaved = 'Remote access did not save.';
const remoteFieldNotSaved = 'Remote access stays off, because a field did not save. Correct the field, or press Esc to restore its saved value. Then turn the switch on.';
const defaultNotSaved = 'A setting did not save.';
const titleToolNotSaved = 'The title tool did not save.';

// PageLook applies the saved settings that change the look of the page.
export interface PageLook {
  // Apply the appearance that data-appearance of the page now has.
  appearance(): void;
  // Use a sidebar width preset: narrow, normal, or wide.
  sidebarWidth(preset: string): void;
}

// A field of remote access. It saves alone, as Port does, and it shows its own error.
// sending is the running save of the current text, so that Enter and the blur after it
// save the text once. Its result tells if the text saved. An input or a reset ends it,
// so that the next Enter or blur saves again.
interface RemoteField {
  key: RemoteKey;
  label: string;
  input: HTMLInputElement;
  error: HTMLElement;
  edit: FieldEdit<string>;
  sending: { text: string; saved: Promise<boolean> } | null;
}

export class SettingsView {
  private readonly panel = element('settings-view', HTMLElement);
  private readonly form = element('settings-form', HTMLFormElement);
  private readonly appearance = element('settings-appearance', HTMLSelectElement);
  private readonly sidebarWidth = element('settings-sidebar-width', HTMLSelectElement);
  private readonly tool = element('settings-tool', HTMLSelectElement);
  private readonly worktree = element('settings-worktree', HTMLInputElement);
  private readonly base = element('settings-base', HTMLInputElement);
  private readonly updateCheck = element('settings-update-check', HTMLInputElement);
  private readonly portForm = element('settings-port-form', HTMLFormElement);
  private readonly port = element('settings-port', HTMLInputElement);
  private readonly portError = element('settings-port-error', HTMLElement);
  private readonly portStatus = element('settings-port-status', HTMLElement);
  private readonly remoteSwitch = element('settings-remote-switch', HTMLButtonElement);
  private readonly remoteError = element('settings-remote-error', HTMLElement);
  private readonly remoteStatus = element('settings-remote-status', HTMLElement);
  private readonly error = element('settings-error', HTMLElement);
  private readonly status = element('settings-status', HTMLElement);
  // The built-in tools and the custom tools have a table each.
  private readonly builtinTools = element('settings-builtin-tools', HTMLElement);
  private readonly tools = element('settings-tools', HTMLElement);
  // One editor dialog adds a tool or edits a saved tool.
  private readonly toolAdd = element('tool-add', HTMLButtonElement);
  private readonly editorDialog = element('tool-editor-dialog', HTMLDialogElement);
  private readonly editor = element('tool-editor', HTMLFormElement);
  private readonly toolClose = element('tool-close', HTMLButtonElement);
  private readonly editorTitle = element('tool-editor-title', HTMLElement);
  private readonly toolName = element('tool-name', HTMLInputElement);
  private readonly toolCommand = element('tool-command', HTMLInputElement);
  private readonly toolCommandHelp = element('tool-command-help', HTMLElement);
  // The CLI path shows only for a built-in tool.
  private readonly toolPathField = element('tool-path-field', HTMLElement);
  private readonly toolPath = element('tool-path', HTMLInputElement);
  private readonly toolPathHelp = element('tool-path-help', HTMLElement);
  // A built-in tool shows a note in place of its name, type, and command, which bbflow
  // keeps.
  private readonly toolBuiltinNote = element('tool-builtin-note', HTMLElement);
  private readonly toolIdentity = element('tool-identity', HTMLElement);
  private readonly toolCommandField = element('tool-command-field', HTMLElement);
  private readonly toolPreview = element('tool-preview', HTMLElement);
  private readonly toolSubmit = element('tool-submit', HTMLButtonElement);
  private readonly toolCancel = element('tool-cancel', HTMLButtonElement);
  private readonly editorError = element('tool-editor-error', HTMLElement);
  private readonly toolHelp = element('settings-tool-help', HTMLElement);
  private readonly toolModels: ModelPicker;
  // adding reports that the editor holds a new custom tool.
  private adding = false;
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
  private readonly titleModelSave = element('title-model-save', HTMLButtonElement);
  private readonly titleModels: ModelPicker;
  // The saved title tool, model, and effort that the model controls showed last. Other
  // values are an edit.
  private renderedTitle = '';
  // titlePending is a title tool of an agent CLI that the list shows but that is not
  // saved. Its model controls wait for Save and test, so the user can choose a model first.
  private titlePending: string | null = null;
  private readonly testResult = element('title-test-result', HTMLElement);
  private readonly testSample = element('title-test-sample', HTMLElement);
  private readonly testOutcome = element('title-test-outcome', HTMLElement);
  private readonly testDetail = element('title-test-detail', HTMLElement);

  private readonly saves: SettingsSaves;
  private renderedBase = '';
  private readonly portField = new FieldEdit(portText);
  private readonly remoteFields: RemoteField[] = [
    { key: 'remoteHost', label: 'Tailscale host name', input: element('settings-remote-host', HTMLInputElement), error: element('settings-remote-host-error', HTMLElement), edit: new FieldEdit((host: string) => host), sending: null },
    { key: 'remoteLogin', label: 'Tailscale login', input: element('settings-remote-login', HTMLInputElement), error: element('settings-remote-login-error', HTMLElement), edit: new FieldEdit((login: string) => login), sending: null },
  ];
  // switchBusy reports a running save of the switch of remote access. The switch then
  // takes no click.
  private switchBusy = false;
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
  private renderedDefault = '';
  private renderedShellOff = false;
  // The agent types whose CLI the server found on PATH, or null before the check.
  private installed: Record<string, boolean> | null = null;

  // The number of times that the user left Settings. A request that started before the
  // latest close has no entry in the view any more, and no place for its error.
  private visits = 0;

  // report shows an error toast. It tells about an entry that did not save when the user
  // left Settings, because the view keeps no entry and no error of it. send is the server
  // call. A fixture replaces it to control the time of each reply.
  constructor(private readonly server: () => ServerInfo | null, private readonly look: PageLook,
    private readonly report: (title: string, detail: string) => void, private readonly send: typeof call = call) {
    this.toolModels = new ModelPicker('tool', { server: () => this.server(), changed: () => this.editorChanged(), send: this.send });
    this.toolName.oninput = this.toolCommand.oninput = this.toolPath.oninput = () => this.editorChanged();
    this.toolAdd.onclick = () => this.openEditor(null);
    this.toolCancel.onclick = this.toolClose.onclick = () => this.closeEditor();
    this.editor.onsubmit = event => { event.preventDefault(); this.saveTool(); };
    // Escape is Cancel. The dialog stays open while a save runs.
    this.editorDialog.oncancel = event => {
      event.preventDefault();
      if (!this.toolBusy) this.closeEditor();
    };
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
    this.sidebarWidth.onchange = () => {
      this.applySidebarWidth(this.sidebarWidth.value);
      this.saveDefault('sidebarWidth', this.sidebarWidth.value);
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
    // A press on the switch keeps the focus in a field, as Safari does for each button.
    // Thus the field gets no blur before the click, and its save does not go out before
    // the switch. A click that turns access off then saves first. See switchRemote.
    this.remoteSwitch.onmousedown = event => event.preventDefault();
    this.remoteSwitch.onclick = () => void this.switchRemote();
    for (const field of this.remoteFields) {
      field.input.onchange = () => void this.saveRemoteField(field);
      field.input.oninput = () => {
        field.sending = null;
        field.edit.input(field.input.value, this.saved?.[field.key] ?? '');
        // The error is about the earlier text.
        field.error.hidden = true;
        this.showStatus();
      };
      // The card has two fields, so Enter does not submit a form. The field saves itself.
      field.input.onkeydown = event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void this.saveRemoteField(field);
        }
        if (event.key === 'Escape' && field.edit.edited) this.restoreRemote(field);
      };
    }
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
    this.titleModels = new ModelPicker('title', { server: () => this.server(), changed: () => { this.showTitleTool(); this.showStatus(); }, send: this.send });
    // A change of the model or the effort saves only after a passed test.
    this.titleModelSave.onclick = () => void this.setTitleTool(this.titleTool.value, '', this.titleModels.model, this.titleModels.effort);
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
    } else void this.refreshTitleTools(server);
    if (!this.pending() && !this.editorOpen()) {
      const settings = await this.send(server, { operation: 'settings-get' });
      if (!this.pending() && !this.editorOpen()) {
        // A title tool change can save while this read runs. Keep the newer settings.
        this.saves.update(settings);
        this.render();
      }
    }
    this.panel.hidden = false;
    void this.checkInstalled(server);
  }

  // refreshTitleTools reads the title commands again. The CLI path of a built-in tool is
  // the program of its title tool, so a change of that path changes them.
  private async refreshTitleTools(server: ServerInfo): Promise<void> {
    try {
      this.titleTools = (await this.send(server, { operation: 'title-tools' })).tools;
      this.showTitleTool();
    } catch { /* The earlier commands stay. */ }
  }

  // checkInstalled asks the server which agent CLIs it finds. A built-in tool then tells
  // when its CLI is missing. A failed check shows nothing.
  private async checkInstalled(server: ServerInfo): Promise<void> {
    try {
      this.installed = (await this.send(server, { operation: 'tool-check' })).installed ?? {};
    } catch {
      this.installed = null;
    }
    this.renderTools();
    // A title tool of an agent CLI tells when its CLI is missing.
    for (const option of Array.from(this.titleTool.options ?? [])) {
      const tool = this.titleTools.find(candidate => candidate.id === option.value);
      if (tool?.type) option.text = this.installed && !this.installed[tool.type] ? `${tool.name} (not found)` : tool.name;
    }
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
    // The click on Done also saves a remote access field. As for the port, the toast
    // repeats an error that came before the click ended.
    for (const field of this.remoteFields) {
      if (field.edit.edited && !field.error.hidden) this.report(remoteNotSaved, field.error.textContent ?? '');
      this.restoreRemote(field);
    }
    this.remoteError.hidden = true;
    // A running title tool change continues. Its end discards the custom entry.
    if (!this.busy) {
      this.discardCustom();
      this.titlePending = null;
      this.renderedTitle = '';
    }
    if (this.editorOpen()) this.discardEditor();
    this.render();
  }

  // The entries that are not saved, by the names that the status shows.
  private unsavedNames(): string[] {
    const names = new Set<string>();
    for (const key of Object.keys(this.saves.defaults) as (keyof Defaults)[]) names.add(defaultLabels[key]);
    if (this.base.value !== this.renderedBase) names.add(defaultLabels.base);
    if (this.portField.edited) names.add('Port');
    for (const field of this.remoteFields) if (field.edit.edited) names.add(field.label);
    if (this.customOpen || this.customCommand.value !== this.renderedCustom) names.add('Custom title command');
    if (this.titleModelEdited()) names.add('Title model');
    if (this.titlePending) names.add('Title tool');
    if (this.adding && (this.toolName.value || this.toolCommand.value)) names.add('New tool');
    if (this.editing && (this.toolName.value !== this.editing.name || this.toolCommand.value !== this.editing.command ||
      this.toolModels.model !== this.editing.model || this.toolModels.effort !== this.editing.effort ||
      this.toolPath.value.trim() !== this.editing.path)) {
      names.add(`Edit of ${this.editing.name}`);
    }
    return [...names];
  }

  private saving(): boolean { return this.saves.writes > 0 || this.settingTool !== null; }

  private pending(): boolean { return this.saving() || this.unsavedNames().length > 0; }

  private showStatus(): void {
    this.status.textContent = statusText(this.saving(), this.unsavedNames());
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

  // Show the saved value of a remote access field again, and hide its error.
  private restoreRemote(field: RemoteField): void {
    field.sending = null;
    field.edit.reset();
    field.error.hidden = true;
    this.render();
  }

  private applyAppearance(appearance: string): void {
    this.appearance.value = appearance;
    document.documentElement.dataset.appearance = appearance;
    this.look.appearance();
  }

  private applySidebarWidth(preset: string): void {
    this.sidebarWidth.value = preset;
    this.look.sidebarWidth(preset);
  }

  private render(): void {
    const saved = this.saved;
    if (!saved) return;
    const defaults = this.saves.defaults;
    this.applyAppearance(defaults.appearance ?? saved.appearance);
    this.applySidebarWidth(defaults.sidebarWidth ?? saved.sidebarWidth);
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
    for (const field of this.remoteFields) {
      const text = field.edit.render(saved[field.key]);
      if (field.input.value !== text) field.input.value = text;
    }
    this.remoteSwitch.setAttribute('aria-checked', String(saved.remoteOn));
    this.remoteSwitch.textContent = saved.remoteOn ? 'On' : 'Off';
    this.remoteStatus.textContent = remoteStatus(saved.remoteOn, saved.remoteHost, saved.remoteLogin);
    this.remoteSwitch.disabled = this.switchBusy;
    this.titleTool.value = this.settingTool ?? (this.customOpen ? 'custom' : this.titlePending ?? saved.titleTool ?? 'none');
    // Keep any text entered in the custom command field since the last render.
    if (this.customCommand.value === this.renderedCustom) {
      this.renderedCustom = saved.titleCommand ?? '';
      this.customCommand.value = this.renderedCustom;
    }
    // Keep a model choice that is not saved. Otherwise show the saved model of the tool.
    // renderedTitle holds the tool, the model, and the effort that the controls show.
    const title = `${saved.titleTool}\n${saved.titleModel ?? ''}\n${saved.titleEffort ?? ''}`;
    if (!this.busy && !this.titlePending && title !== this.renderedTitle && !this.titleModelEdited()) {
      this.renderedTitle = title;
      this.titleModels.set(this.titleType(saved.titleTool), saved.titleModel ?? '', saved.titleEffort ?? '');
    }
    this.showTitleTool();
    if (!this.renderedTools || !sameTools(saved.tools, this.renderedTools) || !!saved.shellOff !== this.renderedShellOff) {
      // A tool that is off cannot be the default tool. Shell too.
      fillToolMenu(this.tool, saved.tools, !saved.shellOff);
      this.renderTools();
    } else if (saved.defaultTool !== this.renderedDefault) this.renderTools();
    const defaultTool = defaults.defaultTool ?? saved.defaultTool;
    this.tool.value = !defaultTool || saved.tools.some(tool => tool.id === defaultTool) ? defaultTool : saved.defaultTool;
    const shown = saved.tools.find(tool => tool.id === this.tool.value);
    this.toolHelp.textContent = shown && typed(shown.type)
      ? `New drafts select this tool with its default model and effort: ${modelSummary(shown.type, shown.model, shown.effort)}.` : '';
    this.showStatus();
  }

  // renderTools shows the saved tools in two tables: the built-in tools, and the custom
  // tools that the user added. Each row starts with its switch. The buttons of
  // the rows wait while the editor dialog is open or a change saves.
  private renderTools(): void {
    const tools = this.saved?.tools ?? [];
    this.renderedTools = tools;
    this.renderedDefault = this.saved?.defaultTool ?? '';
    this.renderedShellOff = !!this.saved?.shellOff;
    const locked = this.toolBusy || this.editorOpen();
    const focused = document.activeElement;
    const focusedRowButton = focused instanceof HTMLButtonElement && (this.tools.contains(focused) || this.builtinTools.contains(focused)) ? focused : null;
    const own = tools.filter(tool => !tool.builtin);
    const toolRow = (tool: Tool) => {
      const row = document.createElement('tr');
      row.dataset.toolId = tool.id;
      row.className = [tool.id === this.editing?.id ? 'editing' : '', tool.enabled ? '' : 'off'].filter(Boolean).join(' ');
      const cell = (className: string, text = '') => {
        const td = document.createElement('td');
        td.className = className;
        td.textContent = text;
        row.append(td);
        return td;
      };
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.id = `tool-switch-${tool.id || 'shell'}`;
      toggle.className = 'switch';
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', String(tool.enabled));
      toggle.setAttribute('aria-label', `${tool.name} on`);
      toggle.textContent = tool.enabled ? 'On' : 'Off';
      toggle.disabled = locked;
      toggle.onclick = () => this.switchTool(tool.id, tool.name, tool.enabled);
      cell('tool-on').append(toggle);
      const name = cell('tool-name', tool.name);
      const chip = (text: string, className = 'tool-chip') => {
        const span = document.createElement('span');
        span.className = className;
        span.textContent = text;
        name.append(span);
      };
      if (tool.id === this.renderedDefault) chip('DEFAULT');
      if (tool.builtin && tool.id && this.installed && !this.installed[tool.type]) chip('NOT FOUND', 'tool-chip missing');
      if (tool.id) {
        const command = document.createElement('code');
        command.textContent = tool.command;
        cell('tool-command-cell').append(command);
      } else cell('tool-command-cell muted-cell', 'Your shell, with no command');
      // Only a built-in tool has a default model. Shell has none.
      if (tool.builtin) cell(typed(tool.type) ? 'tool-default' : 'tool-default muted-cell', typed(tool.type) ? modelSummary(tool.type, tool.model, tool.effort) : 'None');
      const actions = cell('tool-actions');
      if (!tool.id) return row;
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
      // The built-in tools keep their order and cannot be removed.
      if (!tool.builtin) {
        const index = own.indexOf(tool);
        action('Move up', '↑', () => this.moveTool(tool.id, -1), index === 0);
        action('Move down', '↓', () => this.moveTool(tool.id, 1), index === own.length - 1);
        action('Remove', 'Remove', () => this.confirmRemove(tool));
      }
      return row;
    };
    // Shell is a built-in tool without a command. Its row has only its switch.
    const shell: Tool = { id: '', name: 'Shell', command: '', type: 'shell', model: '', effort: '', builtin: true, enabled: !this.saved?.shellOff, path: '' };
    // The built-in tools are sorted by name, as in the tool menus.
    this.builtinTools.replaceChildren(...sortedBuiltins([shell, ...tools.filter(tool => tool.builtin)]).map(toolRow));
    const rows = own.map(toolRow);
    if (!rows.length) {
      const row = document.createElement('tr');
      const empty = document.createElement('td');
      empty.className = 'tool-empty';
      empty.colSpan = 4;
      empty.textContent = 'No custom tools yet. Click ＋ Add custom tool to add one.';
      row.append(empty);
      rows.push(row);
    }
    this.tools.replaceChildren(...rows);
    this.toolAdd.disabled = locked;
    if (focusedRowButton) document.getElementById(focusedRowButton.id)?.focus({ preventScroll: true });
  }

  // A removal has no undo, so a dialog asks first. It also tells when the removal changes
  // the default tool.
  private confirmRemove(tool: Tool): void {
    if (!this.saved || this.toolBusy) return;
    this.removing = tool;
    this.toolError.hidden = true;
    this.removeSummary.textContent = `“${tool.name}” leaves the tool list. Drafts and sessions that use it keep their own copy of the command. A removal has no undo.`;
    const fallback = fallbackTool(this.saved, tool.id);
    const next = fallback === '' ? 'Shell' : this.saved.tools.find(candidate => candidate.id === fallback)?.name;
    this.removeDefault.textContent = next
      ? `“${tool.name}” is the default tool. After the removal, ${next} is the default tool.`
      : `“${tool.name}” is the default tool and the only tool that is on. Turn on another tool before the removal.`;
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

  private editorOpen(): boolean { return this.adding || !!this.editing; }

  // openEditor shows the editor with a saved tool, or empty for a new tool.
  private openEditor(original: Tool | null): void {
    if (!this.saved || this.editorOpen() || this.toolBusy) return;
    this.editing = original;
    this.adding = !original;
    if (!original) this.newToolId = '';
    this.editorTitle.textContent = original ? `Edit of ${original.name}` : 'New custom tool';
    this.toolSubmit.textContent = original ? 'Save' : 'Add tool';
    this.toolName.value = original?.name ?? '';
    this.toolCommand.value = original?.command ?? '';
    const type = this.editorType();
    const builtin = !!original?.builtin;
    this.toolPathField.hidden = !builtin;
    this.toolIdentity.hidden = this.toolCommandField.hidden = builtin;
    this.toolBuiltinNote.hidden = !builtin;
    this.toolBuiltinNote.textContent = 'bbflow keeps the name and the command of this built-in tool. For other options, add a custom tool.';
    this.toolPath.value = original?.path ?? '';
    this.toolPath.placeholder = type;
    this.toolPathHelp.textContent = `Leave it empty to run ${type} from the PATH of the server. bbflow runs this program for sessions, the model list, the check for the CLI, and automatic titles.`;
    this.toolModels.set(type, original?.model ?? '', original?.effort ?? '');
    this.editorError.hidden = true;
    if (!this.editorDialog.open) this.editorDialog.showModal();
    this.renderTools();
    this.editorChanged();
    // A built-in tool shows no name field, so its first field is the CLI path.
    (original?.builtin ? this.toolPath : this.toolName).focus({ preventScroll: true });
  }

  // editorType is the type of the tool in the editor. A built-in tool has the type of its
  // agent. A tool that the user adds is a Custom tool.
  private editorType(): string {
    return this.editing?.builtin ? this.editing.type : 'custom';
  }

  // editorChanged shows the command that new sessions submit, and the status.
  private editorChanged(): void {
    const type = this.editorType();
    const model = typed(type) ? this.toolModels.model : '', effort = typed(type) ? this.toolModels.effort : '';
    const command = this.editing?.builtin ? builtinCommand(type, this.toolPath.value.trim()) : this.toolCommand.value;
    this.toolPreview.textContent = launchCommand(type, command, model, effort) || '(no startup command)';
    this.toolCommandHelp.textContent = 'bbflow submits this command unchanged. Put all options of the tool in it.';
    this.showStatus();
  }

  // discardEditor hides the editor and forgets its entry.
  private discardEditor(): void {
    this.editing = null;
    this.adding = false;
    this.newToolId = '';
    if (this.editorDialog.open) this.editorDialog.close();
    this.editorError.hidden = true;
    this.renderTools();
  }

  // closeEditor hides the editor and moves focus to Edit of the tool, or to Add tool.
  private closeEditor(focusId = this.editing?.id): void {
    this.discardEditor();
    this.showStatus();
    const edit = focusId ? document.getElementById(`tool-edit-${focusId}`) : null;
    (edit ?? this.toolAdd).focus({ preventScroll: true });
  }

  private saveTool(): void {
    if (!this.saved || this.toolBusy || !this.editorOpen()) return;
    const original = this.editing;
    // The server keeps the name and builds the command of a built-in tool.
    const name = original?.builtin ? original.name : this.toolName.value.trim();
    const command = original?.builtin ? builtinCommand(original.type, this.toolPath.value.trim()) : this.toolCommand.value;
    if (!name || !command.trim()) {
      this.editorError.textContent = 'Enter a name and a command.';
      this.editorError.hidden = false;
      (!name ? this.toolName : this.toolCommand).focus();
      return;
    }
    const id = original?.id ?? (this.newToolId ||= crypto.randomUUID());
    // An edit that keeps its name can save, also when an earlier save made a duplicate.
    // This check gives the error without a request. The change checks the name again
    // against the latest settings, which can have a tool from another view or the CLI.
    if (name !== original?.name && duplicateName(this.saved.tools, name, id)) {
      this.editorError.textContent = duplicateNameError;
      this.editorError.hidden = false;
      this.toolName.focus();
      return;
    }
    const failure = original ? `The edit of “${original.name}” did not save.` : `The new tool “${name}” did not save.`;
    const type = this.editorType(), model = typed(type) ? this.toolModels.model : '', effort = typed(type) ? this.toolModels.effort : '';
    const path = original?.builtin ? this.toolPath.value.trim() : '';
    void this.changeTool(toolEdit({ id, name, command, type, model, effort, builtin: original?.builtin ?? false, enabled: original?.enabled ?? true, path }, original ?? undefined), failure, this.editorError, () => {
      this.closeEditor(id);
      // The CLI path of a built-in tool is the program of its model list, the check for
      // its CLI, and its title tool.
      const server = this.server();
      if (original?.builtin && path !== original.path && server) {
        forgetModelLists();
        this.renderedTitle = '';
        void this.checkInstalled(server);
        void this.refreshTitleTools(server);
      }
    });
  }

  // switchTool turns a tool on or off. The empty ID is Shell. Turning off the default
  // tool selects Shell, or the first other tool that is on.
  private switchTool(id: string, name: string, enabled: boolean): void {
    const failure = enabled ? `Turning off “${name}” did not save.` : `Turning on “${name}” did not save.`;
    void this.changeTool(toolSwitch(id, !enabled), failure);
  }

  private moveTool(id: string, offset: number): void {
    const name = this.saved?.tools.find(tool => tool.id === id)?.name ?? '';
    void this.changeTool(settings => {
      const tools = [...settings.tools];
      const index = tools.findIndex(tool => tool.id === id);
      if (index < 0) throw new Error('This tool was removed in another view.');
      // A tool of the user moves only among the tools of the user.
      const destination = index + offset;
      if (destination < 0 || destination >= tools.length || tools[destination]!.builtin) return settings;
      const tool = tools[index]!;
      tools.splice(index, 1);
      tools.splice(destination, 0, tool);
      return { ...settings, tools };
    }, `The move of “${name}” did not save.`);
  }

  private setToolBusy(busy: boolean): void {
    this.toolBusy = busy;
    this.toolName.disabled = this.toolCommand.disabled = this.toolPath.disabled = this.toolSubmit.disabled = this.toolCancel.disabled = this.toolClose.disabled = busy;
    this.toolModels.disabled = busy;
  }

  // Save a change of the tools. failure names the action for the error toast. The toast
  // shows when the user left Settings before the reply, because the close discarded the
  // entry of the row. Otherwise the error shows in error.
  private async changeTool(change: SettingsChange, failure: string, error = this.toolError, done?: () => void): Promise<void> {
    if (this.toolBusy) return;
    const visit = this.visits;
    const focused = document.activeElement;
    const toolId = focused?.closest<HTMLElement>('[data-tool-id]')?.dataset.toolId;
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
    (edit ?? this.toolAdd).focus();
  }

  // Show the controls of the tool in the list. A built-in tool shows its exact command.
  // Custom shows its command field. None has no command and no test. A running test or
  // change keeps the controls disabled and shows the spinner, also across a render.
  private showTitleTool(): void {
    // Another view or a reload can change the saved tool. Hide a result of another tool.
    if (this.titleTool.value !== this.testedTool) this.testResult.hidden = true;
    const edited = this.customCommand.value !== this.renderedCustom;
    const modelEdited = this.titleModelEdited();
    const controls = titleControls(this.titleTools, this.titleTool.value, this.saved?.titleTool ?? 'none', this.busy, edited);
    // The model controls show for the saved tool and for a pending tool of an agent CLI.
    const shown = this.titleTools.find(tool => tool.id === this.titleTool.value);
    const modelsShown = !!shown?.type && (shown.id === this.saved?.titleTool || shown.id === this.titlePending);
    this.titleModels.disabled = this.busy;
    // Hidden controls forget their values. The next render shows the saved model again.
    if (!modelsShown && this.renderedTitle) {
      this.titleModels.set('', '', '');
      this.renderedTitle = '';
    }
    this.titleModelSave.hidden = !modelEdited && !(this.titlePending && this.titleTool.value === this.titlePending);
    this.titleModelSave.disabled = this.busy;
    this.titleCommand.textContent = shown?.type && modelsShown
      ? launchCommand(shown.type, shown.prefix ?? '', this.titleModels.model, this.titleModels.effort) + (shown.suffix ?? '')
      : controls.command;
    this.titleBuiltin.hidden = !controls.command;
    this.customForm.hidden = this.customSave.hidden = !controls.custom;
    this.customCommand.disabled = this.customSave.disabled = !controls.select;
    // Test runs the saved model, so it waits while the model has an edit. A pending tool
    // has nothing saved to test.
    this.titleTest.disabled = !controls.test || modelEdited;
    this.titleTest.hidden = !controls.testShown || !!this.titlePending;
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

  // titleType returns the agent type of a title tool, or empty for a title tool without
  // a model choice.
  private titleType(tool: string): string {
    return this.titleTools.find(candidate => candidate.id === tool)?.type ?? '';
  }

  // titleModelEdited reports a model or an effort of the saved title tool that is not
  // saved.
  // It compares the controls with the saved values that they showed last, not with the
  // newest settings. Thus a newer model from another view is no edit of this view.
  private titleModelEdited(): boolean {
    if (!this.renderedTitle) return false;
    const [tool = '', model = '', effort = ''] = this.renderedTitle.split('\n');
    if (!this.titleType(tool) || this.titleTool.value !== tool) return false;
    return this.titleModels.model !== model || this.titleModels.effort !== effort;
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
      // A newly selected tool of an agent CLI shows its default model and effort, and
      // waits for Save and test. The saved tool, None, and Apple save at once.
      const defaults = this.titleTools.find(candidate => candidate.id === tool);
      if (defaults?.type && tool !== this.saved?.titleTool) {
        this.titlePending = tool;
        this.renderedTitle = '';
        this.titleModels.set(defaults.type, defaults.model ?? '', defaults.effort ?? '');
        this.testResult.hidden = true;
        this.render();
        return;
      }
      this.titlePending = null;
      if (tool === this.saved?.titleTool) {
        this.render();
        return;
      }
      void this.setTitleTool(tool, '', defaults?.model ?? '', defaults?.effort ?? '');
      return;
    }
    this.titlePending = null;
    this.renderedTitle = '';
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
  private async setTitleTool(tool: string, command = '', model = '', effort = ''): Promise<void> {
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
      const result = await this.send(server, { operation: 'title-tool-set', settings: { titleTool: tool, titleCommand: command, titleModel: model, titleEffort: effort } });
      this.renderedTitle = '';
      this.titlePending = null;
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
      // The result stays below the tool that the list shows after the change. A pending
      // tool or a model edit that failed its test stays for another try, but only while
      // Settings is open. After a close, the controls show the saved values again.
      if (visit !== this.visits) {
        this.titlePending = null;
        this.renderedTitle = '';
      }
      this.testedTool = this.customOpen ? 'custom' : this.titlePending ?? this.saved?.titleTool ?? 'none';
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
      // Test runs the saved model and effort. A changed model tests with Save and test.
      const titleModel = this.saved?.titleModel ?? '', titleEffort = this.saved?.titleEffort ?? '';
      const result = await this.send(server, { operation: 'title-test', settings: { titleTool: tool, titleCommand, titleModel, titleEffort } });
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

  // A field of remote access saves alone, as Port does. The server checks the value and
  // saves the host name in lower case. A failed save keeps the text, with the error below
  // the field. Only a current save changes the error of its field. See FieldEdit. The
  // result tells if the field has no edit that failed to save.
  private saveRemoteField(field: RemoteField): Promise<boolean> {
    const text = field.input.value.trim();
    if (!this.saved || !field.edit.edited) return Promise.resolve(true);
    if (field.sending?.text === text) return field.sending.saved;
    const visit = this.visits;
    const token = field.edit.begin();
    const finish = (error?: unknown): boolean => {
      if (field.sending === sending) field.sending = null;
      if (!field.edit.done(token, error === undefined)) {
        if (error !== undefined && visit !== this.visits) this.report(remoteNotSaved, errorMessage(error));
      } else if (error === undefined) {
        field.error.hidden = true;
      } else {
        field.error.textContent = errorMessage(error);
        field.error.hidden = false;
      }
      this.render();
      return error === undefined;
    };
    const sending = { text, saved: this.saves.saveRemoteValue(field.key, text).then(() => finish(), (error: unknown) => finish(error ?? new Error('Unknown error'))) };
    field.sending = sending;
    return sending.saved;
  }

  // The switch of remote access saves at once and alone. It keeps the saved host name and
  // login. The press keeps the focus in a field, so a field with an edit did not save yet.
  // Turning the switch off saves first, so that no change of a value comes before it.
  //
  // Turning it on uses the values that the card shows at the click: the text of a field
  // with an edit, else the saved value. It first saves each field with an edit, and it
  // waits for a running save of a field. When a field keeps an edit that did not save,
  // the switch stays off, and the error of the field stays in view. When the saved values
  // then differ from the values at the click, also after a change in another view, the
  // switch stays off too. The fields then show the new values, and the error names them.
  // A second click turns remote access on for them.
  private async switchRemote(): Promise<void> {
    if (!this.saved || this.switchBusy) return;
    const visit = this.visits;
    const on = !this.saved.remoteOn;
    const shown = Object.fromEntries(this.remoteFields.map(field => [field.key, field.edit.edited ? remoteValue(field.key, field.input.value) : this.saved![field.key]])) as RemoteValues;
    this.switchBusy = true;
    this.remoteError.hidden = true;
    this.render();
    let error: unknown;
    let fieldNotSaved = false;
    if (on) {
      const saved = await Promise.all(this.remoteFields.map(field => this.saveRemoteField(field)));
      fieldNotSaved = saved.includes(false) || (visit === this.visits && this.remoteFields.some(field => field.edit.edited));
      if (fieldNotSaved) error = new Error(remoteFieldNotSaved);
    }
    if (error === undefined) {
      error = await this.saves.saveRemoteSwitch(on, shown).then(() => undefined, (cause: unknown) => cause ?? new Error('Unknown error'));
    }
    this.switchBusy = false;
    if (error !== undefined && visit !== this.visits) {
      this.report(remoteNotSaved, errorMessage(error));
    } else if (error !== undefined && !(fieldNotSaved && this.remoteFields.some(field => !field.error.hidden))) {
      // The error of a field that did not save explains why the switch stays off.
      this.remoteError.textContent = errorMessage(error);
      this.remoteError.hidden = false;
    }
    this.render();
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
