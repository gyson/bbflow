import { element, revealCard } from './dom.js';
import { errorMessage } from './protocol.js';
import type { Prompt } from './protocol.js';
import { promptEdit, promptMove, promptProblem, promptRemoval, samePrompts } from './settings-model.js';
import type { SettingsChange, SettingsSaves } from './settings-model.js';

interface Host {
  saves: SettingsSaves;
  // The number of times that the user left Settings. A reply after a close has no entry
  // in the view any more, so its error goes to a toast.
  visits(): number;
  hidden(): boolean;
  report(title: string, detail: string): void;
  // status shows the status of Settings again after an edit.
  status(): void;
}

// The Prompts card of Settings lists the saved prompts in the order of the ＋ menu. One
// editor dialog adds a prompt or edits a saved prompt. The fields save only with the
// button of the dialog. A removal asks first, because it has no undo.
export class PromptSettings {
  private readonly card = element('settings-prompts', HTMLElement);
  private readonly heading = element('settings-prompts-title', HTMLElement);
  private readonly rows = element('settings-prompt-rows', HTMLElement);
  private readonly add = element('prompt-add', HTMLButtonElement);
  private readonly error = element('prompt-error', HTMLElement);
  private readonly dialog = element('prompt-editor-dialog', HTMLDialogElement);
  private readonly editor = element('prompt-editor', HTMLFormElement);
  private readonly title = element('prompt-editor-title', HTMLElement);
  private readonly name = element('prompt-name', HTMLInputElement);
  private readonly text = element('prompt-text', HTMLTextAreaElement);
  private readonly editorError = element('prompt-editor-error', HTMLElement);
  private readonly submit = element('prompt-submit', HTMLButtonElement);
  private readonly cancel = element('prompt-cancel', HTMLButtonElement);
  private readonly closeButton = element('prompt-close', HTMLButtonElement);
  private readonly removeDialog = element('prompt-remove-dialog', HTMLDialogElement);
  private readonly removeForm = element('prompt-remove-form', HTMLFormElement);
  private readonly removeSummary = element('prompt-remove-summary', HTMLElement);
  private readonly removeCancel = element('cancel-prompt-remove', HTMLButtonElement);
  private rendered: Prompt[] | null = null;
  // The editor holds a new prompt, or an edit of editing.
  private adding = false;
  private editing: Prompt | null = null;
  // The ID of the new prompt. It stays for each attempt of the same entry.
  private newId = '';
  private removing: Prompt | null = null;
  private busy = false;

  constructor(private readonly host: Host) {
    this.add.onclick = () => this.openEditor(null);
    this.cancel.onclick = this.closeButton.onclick = () => this.closeEditor();
    this.name.oninput = this.text.oninput = () => this.host.status();
    this.editor.onsubmit = event => { event.preventDefault(); this.save(); };
    // Escape is Cancel. The dialog stays open while a save runs.
    this.dialog.oncancel = event => {
      event.preventDefault();
      if (!this.busy) this.closeEditor();
    };
    this.removeCancel.onclick = () => this.removeDialog.close();
    this.removeForm.onsubmit = event => { event.preventDefault(); this.remove(); };
  }

  private get prompts(): Prompt[] { return this.host.saves.saved?.prompts ?? []; }

  editorOpen(): boolean { return this.adding || !!this.editing; }

  // The entries that are not saved, by the names that the status of Settings shows.
  unsaved(): string[] {
    if (this.adding && (this.name.value.trim() || this.text.value)) return ['New prompt'];
    if (this.editing && (this.name.value.trim() !== this.editing.name || this.text.value !== this.editing.text)) return [`Edit of ${this.editing.name}`];
    return [];
  }

  // reveal scrolls to the card and moves the focus to its heading. Manage prompts in the
  // ＋ menu opens Settings here.
  reveal(): void { revealCard(this.card, this.heading); }

  // close discards the entries of the card when the user leaves Settings. A running save
  // continues.
  close(): void {
    this.removing = null;
    if (this.removeDialog.open) this.removeDialog.close();
    if (this.editorOpen()) this.discardEditor();
    this.error.hidden = true;
  }

  // render shows the saved prompts. Without force, it changes nothing when the prompts
  // are the same as at the last render.
  render(force = false): void {
    const prompts = this.prompts;
    if (!force && this.rendered && samePrompts(prompts, this.rendered)) return;
    this.rendered = prompts;
    // The buttons of the rows wait while the editor dialog is open or a change saves.
    const locked = this.busy || this.editorOpen();
    const focused = document.activeElement instanceof HTMLButtonElement && this.rows.contains(document.activeElement) ? document.activeElement.id : '';
    const rows = prompts.map((prompt, index) => {
      const row = document.createElement('tr');
      row.dataset.promptId = prompt.id;
      if (prompt.id === this.editing?.id) row.className = 'editing';
      const name = document.createElement('td');
      name.className = 'tool-name';
      name.textContent = prompt.name;
      const text = document.createElement('td');
      text.className = 'prompt-text-cell';
      // The text shows on two lines at most, with its lines joined, as in the ＋ menu.
      const preview = document.createElement('div');
      preview.textContent = prompt.text.replace(/\s+/g, ' ').trim();
      text.append(preview);
      const actions = document.createElement('td');
      actions.className = 'tool-actions';
      const action = (label: string, symbol: string, click: () => void, disabled = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.id = `prompt-${label.toLowerCase().replace(' ', '-')}-${prompt.id}`;
        button.textContent = symbol;
        button.setAttribute('aria-label', `${label} ${prompt.name}`);
        button.disabled = locked || disabled;
        button.onclick = click;
        actions.append(button);
      };
      action('Edit', 'Edit', () => this.openEditor(prompt));
      action('Move up', '↑', () => this.move(prompt, -1), index === 0);
      action('Move down', '↓', () => this.move(prompt, 1), index === prompts.length - 1);
      action('Remove', 'Remove', () => this.confirmRemove(prompt));
      row.append(name, text, actions);
      return row;
    });
    if (!rows.length) {
      const row = document.createElement('tr');
      const empty = document.createElement('td');
      empty.className = 'tool-empty';
      empty.colSpan = 3;
      empty.textContent = 'None';
      row.append(empty);
      rows.push(row);
    }
    this.rows.replaceChildren(...rows);
    this.add.disabled = locked;
    if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  }

  // openEditor shows the editor with a saved prompt, or empty for a new prompt.
  private openEditor(original: Prompt | null): void {
    if (!this.host.saves.saved || this.editorOpen() || this.busy) return;
    this.editing = original;
    this.adding = !original;
    if (!original) this.newId = '';
    this.title.textContent = original ? `Edit of ${original.name}` : 'New prompt';
    this.submit.textContent = original ? 'Save' : 'Add prompt';
    this.name.value = original?.name ?? '';
    this.text.value = original?.text ?? '';
    this.editorError.hidden = true;
    this.error.hidden = true;
    if (!this.dialog.open) this.dialog.showModal();
    this.render(true);
    this.host.status();
    this.name.focus({ preventScroll: true });
  }

  // discardEditor hides the editor and forgets its entry.
  private discardEditor(): void {
    this.editing = null;
    this.adding = false;
    this.newId = '';
    if (this.dialog.open) this.dialog.close();
    this.editorError.hidden = true;
    this.render(true);
  }

  // closeEditor hides the editor and moves the focus to Edit of the prompt, or to Add
  // prompt.
  private closeEditor(focusId = this.editing?.id): void {
    this.discardEditor();
    this.host.status();
    const edit = focusId ? document.getElementById(`prompt-edit-${focusId}`) : null;
    (edit ?? this.add).focus({ preventScroll: true });
  }

  private save(): void {
    if (!this.host.saves.saved || this.busy || !this.editorOpen()) return;
    const original = this.editing;
    const name = this.name.value.trim();
    const text = this.text.value.replace(/\r\n?/g, '\n');
    const id = original?.id ?? (this.newId ||= crypto.randomUUID());
    // This check gives the error without a request. The change checks the name again
    // against the latest settings, which can have a prompt from another view.
    const problem = promptProblem(this.prompts, name, text, id);
    if (problem) {
      this.editorError.textContent = problem.message;
      this.editorError.hidden = false;
      (problem.field === 'name' ? this.name : this.text).focus();
      return;
    }
    const failure = original ? `The edit of “${original.name}” did not save.` : `The new prompt “${name}” did not save.`;
    void this.change(promptEdit({ id, name, text }, original ?? undefined), failure, this.editorError, () => this.closeEditor(id));
  }

  private confirmRemove(prompt: Prompt): void {
    if (this.busy) return;
    this.removing = prompt;
    this.error.hidden = true;
    this.removeSummary.textContent = `“${prompt.name}” leaves the ＋ menu of every session. Drafts and sent messages keep their text. A removal has no undo.`;
    this.removeDialog.showModal();
  }

  // The close of the dialog returns the focus to Remove of the row. The change then moves
  // the focus to the nearest row.
  private remove(): void {
    const prompt = this.removing;
    this.removing = null;
    this.removeDialog.close();
    if (prompt) void this.change(promptRemoval(prompt.id), `The removal of “${prompt.name}” did not save.`);
  }

  private move(prompt: Prompt, offset: number): void {
    void this.change(promptMove(prompt.id, offset), `The move of “${prompt.name}” did not save.`);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.name.disabled = this.text.disabled = this.submit.disabled = this.cancel.disabled = this.closeButton.disabled = busy;
  }

  // Save a change of the prompts. failure names the action for the error toast. The
  // toast shows when the user left Settings before the reply. Otherwise the error shows
  // in error.
  private async change(change: SettingsChange, failure: string, error = this.error, done?: () => void): Promise<void> {
    if (this.busy) return;
    const visit = this.host.visits();
    const focused = document.activeElement;
    const promptId = focused instanceof HTMLElement ? focused.closest<HTMLElement>('[data-prompt-id]')?.dataset.promptId : undefined;
    const index = this.prompts.findIndex(prompt => prompt.id === promptId);
    this.setBusy(true);
    error.hidden = true;
    this.render(true);
    let saved = false;
    try {
      await this.host.saves.enqueue(() => this.host.saves.save(change));
      saved = true;
    } catch (cause) {
      if (visit !== this.host.visits()) this.host.report(failure, errorMessage(cause));
      else {
        error.textContent = errorMessage(cause);
        error.hidden = false;
      }
    } finally {
      this.setBusy(false);
      this.render(true);
      if (saved && done && visit === this.host.visits()) done();
      else if (focused instanceof HTMLButtonElement && index >= 0 && document.activeElement === document.body && !this.host.hidden()) {
        this.restoreFocus(focused.id, index);
      }
    }
  }

  // restoreFocus moves the focus back to the button of the change. After a removal, or
  // at the end of the list, it moves the focus to Edit of the nearest prompt.
  private restoreFocus(buttonId: string, index: number): void {
    const button = document.getElementById(buttonId);
    if (button instanceof HTMLButtonElement && !button.disabled) {
      button.focus();
      return;
    }
    const prompts = this.prompts;
    const id = buttonId.replace(/^prompt-(edit|move-up|move-down|remove)-/, '');
    const prompt = prompts.find(candidate => candidate.id === id) ?? prompts[Math.min(index, prompts.length - 1)];
    const edit = prompt ? document.getElementById(`prompt-edit-${prompt.id}`) : null;
    (edit ?? this.add).focus();
  }
}
