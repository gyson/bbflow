import { element } from './dom.js';
import { errorMessage } from './protocol.js';
import type { Update } from './protocol.js';

// The dialog names at most this number of live sessions.
const namedSessions = 5;

// The sidebar text of an offer. An update in progress cannot start again.
export function updateLabel(update: Update): { text: string; enabled: boolean } {
  switch (update.state) {
    case 'updating': return { text: `Updating to ${update.available}…`, enabled: false };
    case 'failed': return { text: `Update to ${update.available} failed`, enabled: true };
    default: return { text: update.installed ? `Restart to use ${update.available}` : `Update available: ${update.available}`, enabled: true };
  }
}

// The dialog text of an offer. An installed release needs only a restart.
export function updateDialog(update: Update): { title: string; help: string; submit: string; notes: string } {
  return {
    title: update.installed ? 'Restart bbflow' : 'Update bbflow',
    help: update.installed
      ? `This executable already has bbflow ${update.available}. bbflow downloads nothing and restarts the server with it.`
      : `bbflow downloads and verifies ${update.available} while the server continues. Then it replaces the executable and restarts the server with the new version.`,
    submit: update.installed ? 'Restart' : 'Update and restart',
    notes: `https://github.com/gyson/bbflow/releases/tag/v${encodeURIComponent(update.available)}`,
  };
}

// Tell which sessions the restart stops. names has the titles of the live sessions in
// the list. count also includes live sessions that the list does not show.
export function restartWarning(names: readonly string[], count: number): string {
  if (count === 0) return 'No session is live now. The restart also stops the terminals of the workspace pane.';
  const shown = names.slice(0, namedSessions);
  const others = count - shown.length;
  const items = others > 0 ? [...shown, `${others} more`] : shown;
  const list = items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
  const sessions = count === 1 ? '1 live session' : `${count} live sessions`;
  return `The restart stops ${sessions}: ${list}. ${count === 1 ? 'Its' : 'Their'} recorded history stays. The restart also stops the terminals of the workspace pane.`;
}

// The sidebar shows the release offer of the server. The dialog asks before the server
// stops its sessions for the update. A confirmation applies only to the offer that the
// dialog shows, so the view sends its revision.
export class UpdateNotice {
  private readonly button = element('update-open', HTMLButtonElement);
  private readonly dialog = element('update-dialog', HTMLDialogElement);
  private readonly form = element('update-form', HTMLFormElement);
  private readonly title = element('update-title', HTMLElement);
  private readonly versions = element('update-versions', HTMLElement);
  private readonly help = element('update-help', HTMLElement);
  private readonly sessions = element('update-sessions', HTMLElement);
  private readonly notes = element('update-notes', HTMLAnchorElement);
  private readonly error = element('update-error', HTMLElement);
  private readonly submit = element('update-submit', HTMLButtonElement);
  private update: Update | undefined;
  // The offer that the open dialog shows.
  private shown: Update | undefined;
  // The IDs of the live sessions, from the same status message as the offer.
  private live: readonly string[] = [];
  private busy = false;
  private starting = false;
  // The error of a start from this dialog. It stays until the dialog opens again.
  private startError = '';

  constructor(private readonly host: {
    // The title of a session in the list, or undefined when the list does not show it.
    title(id: string): string | undefined;
    start(offer: Update): Promise<void>;
  }) {
    this.button.onclick = () => this.open();
    element('update-cancel', HTMLButtonElement).onclick = element('update-close', HTMLButtonElement).onclick = () => this.dialog.close();
    this.form.onsubmit = event => { event.preventDefault(); void this.start(); };
  }

  // The status watch sends the offer and the live sessions together, after each change.
  // Without an offer, the notice and the dialog close. A new offer also closes the
  // dialog, because the user confirmed only the earlier offer.
  show(update: Update | undefined, live: readonly string[]): void {
    this.update = update;
    this.live = live;
    this.renderButton();
    if (!this.dialog.open || this.starting) return;
    // Another view started the update. The sidebar shows its progress.
    if (!update || update.state === 'updating' || update.revision !== this.shown?.revision) this.dialog.close();
    else this.fill(update);
  }

  // The session list changed, for example after a rename. An open dialog reads the
  // titles again.
  sessionsChanged(): void {
    if (this.dialog.open && this.shown) this.fill(this.shown);
  }

  // Without the status watch, the offer and the live sessions are unknown. Then the
  // notice and the dialog close until the watch sends them again. An update in progress
  // stays, because it cannot start again.
  lost(): void {
    if (this.update?.state !== 'updating') this.show(undefined, []);
  }

  // A page action in progress disables the notice.
  controls(busy: boolean): void {
    this.busy = busy;
    this.renderButton();
  }

  private renderButton(): void {
    const update = this.update;
    this.button.hidden = !update;
    if (!update) return;
    const label = updateLabel(update);
    this.button.textContent = label.text;
    this.button.title = `bbflow ${update.version} runs now.`;
    this.button.disabled = this.busy || !label.enabled;
    this.button.classList.toggle('failed', update.state === 'failed');
  }

  private fill(update: Update): void {
    this.shown = update;
    const text = updateDialog(update);
    this.title.textContent = text.title;
    this.versions.textContent = `bbflow ${update.version} → ${update.available}`;
    this.help.textContent = text.help;
    const names = this.live.flatMap(id => {
      const title = this.host.title(id);
      return title === undefined ? [] : [title];
    });
    this.sessions.textContent = restartWarning(names, this.live.length);
    this.notes.href = text.notes;
    this.submit.textContent = text.submit;
    this.error.textContent = this.startError || (update.state === 'failed' ? `The last attempt failed: ${update.error || 'unknown error'}` : '');
    this.error.hidden = !this.error.textContent;
  }

  private open(): void {
    const update = this.update;
    if (!update || update.state === 'updating') return;
    this.startError = '';
    this.fill(update);
    this.submit.disabled = false;
    this.dialog.showModal();
  }

  private async start(): Promise<void> {
    const offer = this.shown;
    if (!offer || this.starting) return;
    this.starting = true;
    this.startError = '';
    this.submit.disabled = true;
    try {
      await this.host.start(offer);
      this.dialog.close();
    } catch (error) {
      this.startError = this.error.textContent = errorMessage(error);
      this.error.hidden = false;
    } finally {
      this.starting = false;
      this.submit.disabled = false;
    }
  }
}
