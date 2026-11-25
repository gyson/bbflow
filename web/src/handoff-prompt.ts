import { element } from './dom.js';
import { errorMessage } from './protocol.js';
import type { Handoff } from './protocol.js';

// The dialog shows the handoff prompt of a session again after its new terminal started.
// The ＋ menu of the message editor opens it. The user can copy the prompt, or insert it
// at the cursor of the message editor. The dialog never sends input.
export class HandoffPrompt {
  private readonly dialog = element('handoff-dialog', HTMLDialogElement);
  private readonly folder = element('handoff-folder', HTMLElement);
  private readonly text = element('handoff-text', HTMLTextAreaElement);
  private readonly status = element('handoff-status', HTMLElement);
  private readonly copy = element('handoff-copy', HTMLButtonElement);
  private readonly insert = element('handoff-insert', HTMLButtonElement);

  // blocked tells why text cannot go into the message editor now. insert puts text at the
  // cursor of the editor, and problem shows a problem in the editor.
  constructor(private readonly host: { blocked(): string | undefined; insert(text: string): string | undefined; problem(text: string): void }) {
    element('handoff-close', HTMLButtonElement).onclick = () => this.dialog.close();
    this.copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(this.text.value);
        this.message('Copied the prompt to the clipboard.');
      } catch (error) { this.message(`Cannot copy the prompt: ${errorMessage(error)}`, true); }
    };
    // The editor is behind the modal dialog, so it cannot take the focus while the dialog
    // is open. Check the lock of the draft first, then close the dialog and insert. The
    // insert then has the focus and the undo history of the editor.
    this.insert.onclick = () => {
      const blocked = this.host.blocked();
      if (blocked) { this.message(blocked, true); return; }
      this.dialog.close();
      const problem = this.host.insert(this.text.value);
      if (problem) this.host.problem(problem);
    };
  }

  open(handoff: Handoff): void {
    this.folder.textContent = handoff.folder;
    this.text.value = handoff.prompt;
    this.message('');
    this.dialog.showModal();
  }

  private message(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('form-error', error);
  }
}
