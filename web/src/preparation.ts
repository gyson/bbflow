import { element } from './dom.js';
import { draftCommand, ModelPicker } from './model-choice.js';
import { call, errorMessage } from './protocol.js';
import { fillToolMenu } from './tool-menu.js';
import type { PreparedSession, ServerInfo, Tool } from './protocol.js';

export class PreparationEditor {
  private readonly panel = element('preparation', HTMLElement);
  private readonly form = element('launch-form', HTMLFormElement);
  private readonly name = element('launch-name', HTMLInputElement);
  private readonly tool = element('launch-tool', HTMLSelectElement);
  private readonly worktree = element('launch-worktree', HTMLInputElement);
  private readonly worktreeOption = element('launch-worktree-option', HTMLElement);
  private readonly heading = element('launch-heading', HTMLElement);
  // A sub-session draft chooses the workspace of its parent or a new worktree. Both
  // choices set the worktree checkbox, which the save reads.
  private readonly place = element('launch-place', HTMLElement);
  private readonly placeParent = element('launch-place-parent', HTMLInputElement);
  private readonly placeWorktree = element('launch-place-worktree', HTMLInputElement);
  private readonly parentPath = element('launch-parent-path', HTMLElement);
  private readonly base = element('launch-base', HTMLInputElement);
  private readonly branch = element('launch-branch', HTMLInputElement);
  private readonly options = element('worktree-options', HTMLElement);
  private readonly repository = element('launch-repository', HTMLElement);
  private readonly error = element('launch-error', HTMLElement);
  private readonly status = element('launch-saved', HTMLElement);
  private readonly submit = element('launch-submit', HTMLButtonElement);
  private readonly command = element('launch-command', HTMLElement);
  private readonly models: ModelPicker;
  // The tools of Settings when the draft opened.
  private tools: Tool[] = [];
  private session: PreparedSession | null = null;
  private edits = 0;
  private saved = 0;
  private saving: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inspecting = 0;
  private inspection: Promise<void> | undefined;
  private checking = false;
  private available = false;
  private blocked = false;
  private archived = false;
  // A sub-session can start in the parent workspace only after the first terminal of the
  // parent started. Before that, the parent has no launch workspace.
  private parentReady = true;

  constructor(private readonly host: {
    server(): ServerInfo | null;
    changed(session: PreparedSession): void;
    start(session: PreparedSession): Promise<void>;
  }) {
    // The draft shows no notes about the model list. Settings shows them.
    this.models = new ModelPicker('launch', { server: () => this.host.server(), changed: () => this.changed(), quiet: true, permission: true });
    this.form.oninput = () => this.changed();
    this.worktree.onchange = () => { this.options.hidden = !this.worktree.checked; this.changed(); };
    this.placeParent.onchange = this.placeWorktree.onchange = () => {
      this.worktree.checked = this.placeWorktree.checked;
      this.options.hidden = !this.worktree.checked;
      this.changed();
      this.controls();
    };
    this.form.onsubmit = event => {
      event.preventDefault();
      void (async () => {
        try {
          await this.flush();
          if (this.session && !this.submit.disabled) await this.host.start(this.session);
        } catch (error) { this.showError(error); }
      })();
    };
    window.addEventListener('beforeunload', event => { if (this.unsaved) event.preventDefault(); });
  }

  // True when the server has not saved the latest edit.
  get unsaved(): boolean { return this.edits !== this.saved; }

  get visible(): boolean { return !this.panel.hidden; }

  async open(session: PreparedSession): Promise<void> {
    await this.flush();
    const server = this.host.server(); if (!server || !session.preparation) return;
    const settings = await call(server, { operation: 'settings-get' });
    this.session = session; this.edits = this.saved = 0;
    this.error.hidden = true; this.status.textContent = 'Draft saved to project';
    const p = session.preparation;
    this.name.value = session.title;
    // A tool that is off is not a choice. A draft that chose it before keeps its copy. The
    // built-in tools come first, then a line, then the custom tools.
    const tools = settings.tools.filter(tool => tool.enabled);
    fillToolMenu(this.tool, settings.tools, !settings.shellOff);
    if (p.toolId && !tools.some(tool => tool.id === p.toolId)) {
      const saved = new Option(`${p.toolName} (saved command)`, p.toolId);
      saved.disabled = true;
      this.tool.add(saved);
    } else if (!p.toolId && settings.shellOff) {
      const shell = new Option('Shell (off)', '');
      shell.disabled = true;
      this.tool.add(shell);
    }
    this.tool.value = p.toolId;
    this.tools = tools;
    this.models.set(p.toolType, p.model, p.effort, p.permission);
    // A newly selected tool brings its default model, effort, and permission mode.
    this.tool.onchange = () => {
      const tool = this.selectedTool();
      this.models.set(tool?.type ?? '', tool?.model ?? '', tool?.effort ?? '', tool?.permission ?? '');
      this.changed();
    };
    this.worktree.checked = p.worktree;
    const sub = !!session.parentId;
    this.heading.textContent = sub ? 'Prepare a sub-session.' : 'Prepare a session.';
    this.worktreeOption.hidden = sub;
    this.place.hidden = !sub;
    this.placeParent.checked = !p.worktree;
    this.placeWorktree.checked = p.worktree;
    this.parentReady = true;
    this.parentPath.textContent = '';
    if (sub) {
      const parent = await call(server, { operation: 'session-config', session: session.parentId! });
      this.parentReady = !!parent.run;
      this.parentPath.textContent = !this.parentReady ? 'Start the parent session first. Its workspace is not set yet.'
        : parent.worktree ? `⑂ ${parent.worktree.branch} · ${parent.workspace}` : parent.workspace;
    }
    this.base.value = p.base;
    this.branch.value = p.branch;
    this.options.hidden = !p.worktree;
    this.panel.hidden = false;
    this.preview();
    await this.inspect();
    this.controls();
  }

  async close(): Promise<void> {
    await this.flush(); this.panel.hidden = true; this.session = null; this.inspecting++;
  }

  controls(blocked = this.blocked, archived = this.archived): void {
    this.blocked = blocked;
    this.archived = archived;
    for (const field of this.form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')) field.disabled = blocked;
    this.models.disabled = blocked;
    this.worktree.disabled = this.placeWorktree.disabled = blocked || !this.available;
    this.placeParent.disabled = blocked || !this.parentReady;
    this.submit.disabled = blocked || archived || this.checking || !this.session || (this.worktree.checked && !this.available) ||
      (!!this.session.parentId && !this.worktree.checked && !this.parentReady);
    this.submit.textContent = archived ? 'Restore before starting' : 'Start session ↗';
  }

  private inspect(): Promise<void> {
    return this.inspection = this.inspectWorkspace();
  }

  private async inspectWorkspace(): Promise<void> {
    const token = ++this.inspecting, server = this.host.server();
    if (!server) return;
    this.checking = true; this.available = false; this.controls(); this.repository.textContent = 'Checking workspace…';
    try {
      const info = await call(server, { operation: 'workspace-inspect', workspace: this.session?.workspace ?? '' });
      if (token !== this.inspecting) return;
      this.available = info.available;
      this.repository.textContent = info.available ?
        `${info.branch || 'Detached HEAD'} · ${info.head.slice(0, 8)}. A worktree gets only committed files.` : info.reason;
    } catch (error) { if (token === this.inspecting) this.repository.textContent = errorMessage(error); }
    if (token === this.inspecting) { this.checking = false; this.controls(); }
  }

  // The tool of the tool menu. A removed tool has only the snapshot of the draft.
  private selectedTool(): Tool | undefined {
    return this.tools.find(tool => tool.id === this.tool.value);
  }

  // preview shows the command that the launch submits.
  private preview(): void {
    const p = this.session?.preparation;
    if (!p) return;
    this.command.textContent = draftCommand(p, this.tool.value, this.tools, this.models.model, this.models.effort, this.models.permission) || '(no startup command)';
  }

  private changed(): void {
    this.preview();
    this.edits++; this.status.textContent = 'Saving project draft…';
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 400);
  }

  // Show why the draft cannot save or start. The app also uses it after a start fails.
  showError(error: unknown): void { this.error.textContent = errorMessage(error); this.error.hidden = false; }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    const inspection = this.inspection;
    await inspection;
    if (inspection !== this.inspection) return this.flush();
    if (this.saving) { await this.saving; return this.flush(); }
    if (this.edits === this.saved) return;
    const session = this.session, server = this.host.server();
    if (!session?.preparation || !server) throw new Error('Cannot save launch settings while disconnected.');
    this.saving = (async () => {
      while (this.edits !== this.saved) {
        const version = this.edits;
        const preparation = { revision: session.preparation!.revision, toolId: this.tool.value,
          model: this.models.model, effort: this.models.effort, permission: this.models.permission,
          worktree: this.worktree.checked, base: this.base.value, branch: this.branch.value };
        const updated = await call(server, { operation: 'session-config', session: session.id,
          preparation, name: this.name.value });
        if (!updated.preparation) throw new Error("Session preparation is missing.");
        session.preparation = updated.preparation;
        session.title = updated.title; session.workspace = updated.workspace; session.projectId = updated.projectId;
        this.saved = version; this.host.changed(updated);
      }
      this.error.hidden = true; this.status.textContent = 'Draft saved to project';
    })();
    try { await this.saving; }
    catch (error) { this.status.textContent = 'Launch settings not saved'; this.showError(error); throw error; }
    finally { this.saving = undefined; }
  }
}
