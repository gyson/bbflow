import { element, revealCard } from './dom.js';
import { errorMessage } from './protocol.js';
import type { Prompt, PromptGroup } from './protocol.js';
import { groupEdit, groupMove, groupProblem, groupPrompts, groupRemoval, promptEdit, promptMove, promptProblem, promptRemoval, samePromptGroups, samePrompts } from './settings-model.js';
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

// The value of New group… in the Group list of the prompt editor. A group ID is never
// this value, because the client makes the IDs with crypto.randomUUID.
const newGroupChoice = '\u0000new';
// The removal of a group lists this many names of its prompts.
const listedNames = 6;

const count = (n: number) => `${n} ${n === 1 ? 'prompt' : 'prompts'}`;

// The Prompts card of Settings shows the prompts at the top level of the ＋ menu, then
// one block for each group, in the order of the menu. One editor dialog adds a prompt
// or edits a saved prompt. Another dialog adds or renames a group. The fields save only
// with the button of the dialog. A removal asks first, because it has no undo.
export class PromptSettings {
  private readonly card = element('settings-prompts', HTMLElement);
  private readonly heading = element('settings-prompts-title', HTMLElement);
  private readonly blocks = element('settings-prompt-groups', HTMLElement);
  private readonly addGroup = element('prompt-group-add', HTMLButtonElement);
  private readonly error = element('prompt-error', HTMLElement);
  private readonly dialog = element('prompt-editor-dialog', HTMLDialogElement);
  private readonly editor = element('prompt-editor', HTMLFormElement);
  private readonly title = element('prompt-editor-title', HTMLElement);
  private readonly name = element('prompt-name', HTMLInputElement);
  private readonly group = element('prompt-group', HTMLSelectElement);
  private readonly newGroupField = element('prompt-new-group-field', HTMLElement);
  private readonly newGroup = element('prompt-new-group', HTMLInputElement);
  private readonly text = element('prompt-text', HTMLTextAreaElement);
  private readonly editorError = element('prompt-editor-error', HTMLElement);
  private readonly submit = element('prompt-submit', HTMLButtonElement);
  private readonly cancel = element('prompt-cancel', HTMLButtonElement);
  private readonly closeButton = element('prompt-close', HTMLButtonElement);
  private readonly removeDialog = element('prompt-remove-dialog', HTMLDialogElement);
  private readonly removeForm = element('prompt-remove-form', HTMLFormElement);
  private readonly removeSummary = element('prompt-remove-summary', HTMLElement);
  private readonly removeCancel = element('cancel-prompt-remove', HTMLButtonElement);
  private readonly groupDialog = element('prompt-group-dialog', HTMLDialogElement);
  private readonly groupForm = element('prompt-group-form', HTMLFormElement);
  private readonly groupTitle = element('prompt-group-title', HTMLElement);
  private readonly groupName = element('prompt-group-name', HTMLInputElement);
  private readonly groupError = element('prompt-group-error', HTMLElement);
  private readonly groupSubmit = element('prompt-group-submit', HTMLButtonElement);
  private readonly groupCancel = element('prompt-group-cancel', HTMLButtonElement);
  private readonly groupClose = element('prompt-group-close', HTMLButtonElement);
  private readonly groupRemoveDialog = element('prompt-group-remove-dialog', HTMLDialogElement);
  private readonly groupRemoveForm = element('prompt-group-remove-form', HTMLFormElement);
  private readonly groupRemoveTitle = element('prompt-group-remove-title', HTMLElement);
  private readonly groupRemoveChoice = element('prompt-group-remove-choice', HTMLElement);
  private readonly groupKeep = element('prompt-group-keep', HTMLInputElement);
  private readonly groupKeepText = element('prompt-group-keep-text', HTMLElement);
  private readonly groupDestination = element('prompt-group-destination', HTMLSelectElement);
  private readonly groupDrop = element('prompt-group-drop', HTMLInputElement);
  private readonly groupDropText = element('prompt-group-drop-text', HTMLElement);
  private readonly groupDropNames = element('prompt-group-drop-names', HTMLElement);
  private readonly groupRemoveSubmit = element('prompt-group-remove-submit', HTMLButtonElement);
  private readonly groupRemoveCancel = element('cancel-prompt-group-remove', HTMLButtonElement);
  private rendered: { prompts: Prompt[]; groups: PromptGroup[] } | null = null;
  // The editor holds a new prompt, or an edit of editing.
  private adding = false;
  private editing: Prompt | null = null;
  // The group of a new prompt when the editor opened.
  private addGroupId = '';
  // The IDs of the new prompt and of a new group of the editor. They stay for each
  // attempt of the same entry.
  private newId = '';
  private newGroupId = '';
  private removing: Prompt | null = null;
  // The group dialog holds a new group, or a rename of renaming.
  private groupAdding = false;
  private renaming: PromptGroup | null = null;
  private groupDialogId = '';
  // The group that the removal dialog asks about, and the prompts that it lists.
  private removingGroup: { group: PromptGroup; prompts: Prompt[] } | null = null;
  private busy = false;

  constructor(private readonly host: Host) {
    this.addGroup.onclick = () => this.openGroupEditor(null);
    this.cancel.onclick = this.closeButton.onclick = () => this.closeEditor();
    this.name.oninput = this.text.oninput = this.newGroup.oninput = () => this.host.status();
    this.group.onchange = () => {
      const isNew = this.group.value === newGroupChoice;
      this.newGroupField.hidden = !isNew;
      if (isNew) this.newGroup.focus();
      this.host.status();
    };
    this.editor.onsubmit = event => { event.preventDefault(); this.save(); };
    // Escape is Cancel. The dialog stays open while a save runs.
    this.dialog.oncancel = event => {
      event.preventDefault();
      if (!this.busy) this.closeEditor();
    };
    this.removeCancel.onclick = () => this.removeDialog.close();
    this.removeForm.onsubmit = event => { event.preventDefault(); this.remove(); };
    this.groupCancel.onclick = this.groupClose.onclick = () => this.closeGroupEditor();
    this.groupName.oninput = () => this.host.status();
    this.groupForm.onsubmit = event => { event.preventDefault(); this.saveGroup(); };
    this.groupDialog.oncancel = event => {
      event.preventDefault();
      if (!this.busy) this.closeGroupEditor();
    };
    this.groupKeep.onchange = this.groupDrop.onchange = () => this.syncGroupRemoval();
    // A choice of a destination selects Keep.
    this.groupDestination.onchange = () => {
      this.groupKeep.checked = true;
      this.groupDrop.checked = false;
      this.syncGroupRemoval();
    };
    this.groupRemoveCancel.onclick = () => this.groupRemoveDialog.close();
    this.groupRemoveForm.onsubmit = event => { event.preventDefault(); this.removeGroup(); };
  }

  private get prompts(): Prompt[] { return this.host.saves.saved?.prompts ?? []; }
  private get promptGroups(): PromptGroup[] { return this.host.saves.saved?.promptGroups ?? []; }

  editorOpen(): boolean { return this.adding || !!this.editing || this.groupAdding || !!this.renaming; }

  // The entries that are not saved, by the names that the status of Settings shows.
  unsaved(): string[] {
    const names: string[] = [];
    if (this.adding && (this.name.value.trim() || this.text.value || this.group.value !== this.addGroupId)) names.push('New prompt');
    if (this.editing && (this.name.value.trim() !== this.editing.name || this.text.value !== this.editing.text || this.group.value !== this.editing.group)) names.push(`Edit of ${this.editing.name}`);
    if (this.groupAdding && this.groupName.value.trim()) names.push('New group');
    if (this.renaming && this.groupName.value.trim() !== this.renaming.name) names.push(`Rename of ${this.renaming.name}`);
    return names;
  }

  // reveal scrolls to the card and moves the focus to its heading. Manage prompts in the
  // ＋ menu opens Settings here.
  reveal(): void { revealCard(this.card, this.heading); }

  // close discards the entries of the card when the user leaves Settings. A running save
  // continues.
  close(): void {
    this.removing = null;
    this.removingGroup = null;
    if (this.removeDialog.open) this.removeDialog.close();
    if (this.groupRemoveDialog.open) this.groupRemoveDialog.close();
    if (this.adding || this.editing) this.discardEditor();
    if (this.groupAdding || this.renaming) this.discardGroupEditor();
    this.error.hidden = true;
  }

  // render shows the saved prompts. Without force, it changes nothing when the prompts
  // and the groups are the same as at the last render.
  render(force = false): void {
    const prompts = this.prompts, groups = this.promptGroups;
    if (!force && this.rendered && samePrompts(prompts, this.rendered.prompts) && samePromptGroups(groups, this.rendered.groups)) return;
    this.rendered = { prompts, groups };
    // The buttons wait while a dialog is open or a change saves.
    const locked = this.busy || this.editorOpen();
    const focused = document.activeElement instanceof HTMLButtonElement && this.blocks.contains(document.activeElement) ? document.activeElement.id : '';
    const button = (id: string, text: string, label: string, click: () => void, disabled = false) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.id = id;
      item.textContent = text;
      item.setAttribute('aria-label', label);
      item.disabled = locked || disabled;
      item.onclick = click;
      return item;
    };
    const row = (prompt: Prompt, index: number, list: Prompt[]) => {
      const item = document.createElement('div');
      item.className = prompt.id === this.editing?.id ? 'prompt-row editing' : 'prompt-row';
      item.dataset.promptId = prompt.id;
      const name = document.createElement('div');
      name.className = 'prompt-row-name';
      name.textContent = prompt.name;
      // The text shows on two lines at most, with its lines joined, as in the ＋ menu.
      const text = document.createElement('div');
      text.className = 'prompt-row-text';
      text.textContent = prompt.text.replace(/\s+/g, ' ').trim();
      const actions = document.createElement('div');
      actions.className = 'prompt-actions';
      actions.append(
        button(`prompt-edit-${prompt.id}`, 'Edit', `Edit ${prompt.name}`, () => this.openEditor(prompt)),
        button(`prompt-move-up-${prompt.id}`, '↑', `Move up ${prompt.name}`, () => this.move(prompt, -1), index === 0),
        button(`prompt-move-down-${prompt.id}`, '↓', `Move down ${prompt.name}`, () => this.move(prompt, 1), index === list.length - 1),
        button(`prompt-remove-${prompt.id}`, 'Remove', `Remove ${prompt.name}`, () => this.confirmRemove(prompt)),
      );
      item.append(name, text, actions);
      return item;
    };
    const block = (group: PromptGroup | null, index: number) => {
      const list = groupPrompts(prompts, group?.id ?? '');
      const label = group?.name ?? 'Top level';
      const section = document.createElement('section');
      section.className = 'prompt-group';
      section.dataset.groupId = group?.id ?? '';
      const head = document.createElement('div');
      head.className = 'prompt-group-head';
      const name = document.createElement('h4');
      name.textContent = label;
      head.append(name);
      if (group) {
        const actions = document.createElement('div');
        actions.className = 'prompt-actions';
        actions.append(
          button(`prompt-group-rename-${group.id}`, 'Rename', `Rename the group ${group.name}`, () => this.openGroupEditor(group)),
          button(`prompt-group-move-up-${group.id}`, '↑', `Move up the group ${group.name}`, () => this.moveGroup(group, -1), index === 0),
          button(`prompt-group-move-down-${group.id}`, '↓', `Move down the group ${group.name}`, () => this.moveGroup(group, 1), index === groups.length - 1),
          button(`prompt-group-remove-${group.id}`, 'Remove', `Remove the group ${group.name}`, () => this.confirmRemoveGroup(group)),
        );
        head.append(actions);
      }
      section.append(head, ...list.map(row));
      const add = button(group ? `prompt-add-group-${group.id}` : 'prompt-add-top-level', '＋ Add prompt', `Add a prompt to ${label}`, () => this.openEditor(null, group?.id ?? ''));
      add.className = 'prompt-add-row';
      section.append(add);
      return section;
    };
    this.blocks.replaceChildren(block(null, -1), ...groups.map((group, index) => block(group, index)));
    this.addGroup.disabled = locked;
    if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  }

  // openEditor shows the editor with a saved prompt, or empty for a new prompt of group.
  private openEditor(original: Prompt | null, group = ''): void {
    if (!this.host.saves.saved || this.editorOpen() || this.busy) return;
    this.editing = original;
    this.adding = !original;
    if (!original) this.newId = '';
    this.newGroupId = '';
    this.addGroupId = group;
    this.title.textContent = original ? `Edit of ${original.name}` : 'New prompt';
    this.submit.textContent = original ? 'Save' : 'Add prompt';
    this.name.value = original?.name ?? '';
    this.text.value = original?.text ?? '';
    this.group.replaceChildren(new Option('None (top level)', ''), ...this.promptGroups.map(item => new Option(item.name, item.id)), new Option('New group…', newGroupChoice));
    this.group.value = original?.group ?? group;
    this.newGroup.value = '';
    this.newGroupField.hidden = true;
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
    this.newId = this.newGroupId = '';
    if (this.dialog.open) this.dialog.close();
    this.editorError.hidden = true;
    this.render(true);
  }

  // closeEditor hides the editor and moves the focus to Edit of the prompt, or to Add
  // prompt of the group of the new prompt.
  private closeEditor(focusId = this.editing?.id): void {
    const group = this.addGroupId;
    this.discardEditor();
    this.host.status();
    const edit = focusId ? document.getElementById(`prompt-edit-${focusId}`) : null;
    (edit ?? this.addButton(group)).focus({ preventScroll: true });
  }

  private addButton(group: string): HTMLElement {
    return document.getElementById(group ? `prompt-add-group-${group}` : 'prompt-add-top-level') ?? this.addGroup;
  }

  private showEditorError(message: string, field: HTMLElement): void {
    this.editorError.textContent = message;
    this.editorError.hidden = false;
    field.focus();
  }

  private save(): void {
    if (!this.host.saves.saved || this.busy || !(this.adding || this.editing)) return;
    const original = this.editing;
    const name = this.name.value.trim();
    const text = this.text.value.replace(/\r\n?/g, '\n');
    const id = original?.id ?? (this.newId ||= crypto.randomUUID());
    // These checks give the error without a request. The change checks the names again
    // against the latest settings, which can have a prompt or a group from another view.
    const problem = promptProblem(this.prompts, name, text, id);
    if (problem?.field === 'name') return this.showEditorError(problem.message, this.name);
    let group = this.group.value;
    let newGroup: PromptGroup | undefined;
    if (group === newGroupChoice) {
      newGroup = { id: this.newGroupId ||= crypto.randomUUID(), name: this.newGroup.value.trim() };
      const groupError = groupProblem(this.promptGroups, newGroup.name, newGroup.id);
      if (groupError) return this.showEditorError(groupError, this.newGroup);
      group = newGroup.id;
    }
    if (problem) return this.showEditorError(problem.message, this.text);
    const failure = original ? `The edit of “${original.name}” did not save.` : `The new prompt “${name}” did not save.`;
    void this.change(promptEdit({ id, name, text, group }, original ?? undefined, newGroup), failure, this.editorError, () => this.closeEditor(id));
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

  // openGroupEditor shows the group dialog with a saved group to rename, or empty for a
  // new group.
  private openGroupEditor(original: PromptGroup | null): void {
    if (!this.host.saves.saved || this.editorOpen() || this.busy) return;
    this.renaming = original;
    this.groupAdding = !original;
    if (!original) this.groupDialogId = '';
    this.groupTitle.textContent = original ? `Rename of ${original.name}` : 'New group';
    this.groupSubmit.textContent = original ? 'Rename' : 'Add group';
    this.groupName.value = original?.name ?? '';
    this.groupError.hidden = true;
    this.error.hidden = true;
    if (!this.groupDialog.open) this.groupDialog.showModal();
    this.render(true);
    this.host.status();
    this.groupName.focus({ preventScroll: true });
  }

  private discardGroupEditor(): void {
    this.renaming = null;
    this.groupAdding = false;
    this.groupDialogId = '';
    if (this.groupDialog.open) this.groupDialog.close();
    this.groupError.hidden = true;
    this.render(true);
  }

  // closeGroupEditor hides the group dialog and moves the focus to Rename of the group.
  // A new group has no prompts yet, so the focus goes to its Add prompt.
  private closeGroupEditor(saved?: string): void {
    const renamed = this.renaming?.id;
    this.discardGroupEditor();
    this.host.status();
    const target = renamed ? document.getElementById(`prompt-group-rename-${renamed}`) : saved ? document.getElementById(`prompt-add-group-${saved}`) : null;
    (target ?? this.addGroup).focus({ preventScroll: true });
  }

  private saveGroup(): void {
    if (!this.host.saves.saved || this.busy || !(this.groupAdding || this.renaming)) return;
    const original = this.renaming;
    const name = this.groupName.value.trim();
    const id = original?.id ?? (this.groupDialogId ||= crypto.randomUUID());
    const problem = groupProblem(this.promptGroups, name, id);
    if (problem) {
      this.groupError.textContent = problem;
      this.groupError.hidden = false;
      this.groupName.focus();
      return;
    }
    const failure = original ? `The rename of the group “${original.name}” did not save.` : `The new group “${name}” did not save.`;
    void this.change(groupEdit({ id, name }, original ?? undefined), failure, this.groupError, () => this.closeGroupEditor(id));
  }

  private moveGroup(group: PromptGroup, offset: number): void {
    void this.change(groupMove(group.id, offset), `The move of the group “${group.name}” did not save.`);
  }

  // confirmRemoveGroup asks what happens to the prompts of the group. Keep is selected
  // first, so that Enter never removes prompts.
  private confirmRemoveGroup(group: PromptGroup): void {
    if (this.busy) return;
    const prompts = groupPrompts(this.prompts, group.id);
    this.removingGroup = { group, prompts };
    this.error.hidden = true;
    this.groupRemoveTitle.textContent = `Remove “${group.name}”?`;
    this.groupRemoveChoice.hidden = !prompts.length;
    this.groupKeep.checked = true;
    this.groupDrop.checked = false;
    this.groupKeepText.textContent = `Move its ${count(prompts.length)} to`;
    this.groupDestination.replaceChildren(new Option('Top level', ''), ...this.promptGroups.filter(item => item.id !== group.id).map(item => new Option(item.name, item.id)));
    this.groupDestination.value = '';
    this.groupDropText.textContent = `Remove its ${count(prompts.length)}`;
    const names = prompts.slice(0, listedNames).map(prompt => prompt.name).join(', ');
    this.groupDropNames.textContent = prompts.length > listedNames ? `${names}, and ${prompts.length - listedNames} more` : names;
    this.syncGroupRemoval();
    this.groupRemoveDialog.showModal();
    (prompts.length ? this.groupKeep : this.groupRemoveSubmit).focus();
  }

  // The button shows the danger style only when the prompts go too.
  private syncGroupRemoval(): void {
    const prompts = this.removingGroup?.prompts ?? [];
    const drop = prompts.length > 0 && this.groupDrop.checked;
    this.groupRemoveSubmit.className = drop ? 'primary danger-action' : 'primary';
  }

  private removeGroup(): void {
    const removal = this.removingGroup;
    this.removingGroup = null;
    this.groupRemoveDialog.close();
    if (!removal) return;
    const drop = removal.prompts.length > 0 && this.groupDrop.checked;
    const destination = drop ? '' : this.groupDestination.value;
    const remove = drop ? removal.prompts.map(prompt => prompt.id) : [];
    void this.change(groupRemoval(removal.group.id, destination, remove), `The removal of the group “${removal.group.name}” did not save.`);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    for (const control of [this.name, this.group, this.newGroup, this.text, this.submit, this.cancel, this.closeButton, this.groupName, this.groupSubmit, this.groupCancel, this.groupClose]) control.disabled = busy;
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
      else if (focused instanceof HTMLButtonElement && document.activeElement === document.body && !this.host.hidden()) this.restoreFocus(focused.id, index);
    }
  }

  // restoreFocus moves the focus back to the button of the change. After a removal, or
  // at the end of a group, it moves the focus to Edit of the nearest prompt, or to Add
  // group.
  private restoreFocus(buttonId: string, index: number): void {
    const button = document.getElementById(buttonId);
    if (button instanceof HTMLButtonElement && !button.disabled) {
      button.focus();
      return;
    }
    const prompts = this.prompts;
    const id = buttonId.replace(/^prompt-(edit|move-up|move-down|remove)-/, '');
    const prompt = prompts.find(candidate => candidate.id === id) ?? (index >= 0 ? prompts[Math.min(index, prompts.length - 1)] : undefined);
    const edit = prompt ? document.getElementById(`prompt-edit-${prompt.id}`) : null;
    (edit ?? this.addGroup).focus();
  }
}
