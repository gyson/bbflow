import { element, revealCard } from './dom.js';
import { errorMessage } from './protocol.js';
import type { Release, Update } from './protocol.js';

// The dialog names at most this number of live sessions.
const namedSessions = 5;

// The time of the last check, such as "10:41 AM". A check on another day also names the
// day: the weekday within 6 days, else the date. locale is the locale of the time
// formats. Tests set it. The page uses the locale of the browser.
export function checkedTime(checked: string, now: Date, locale?: string): string {
  const date = new Date(checked);
  if (Number.isNaN(date.getTime())) return '';
  const clock = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return clock;
  return now.getTime() - date.getTime() < 6 * 86400000
    ? `${date.toLocaleDateString(locale, { weekday: 'short' })} ${clock}`
    : `${date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}, ${clock}`;
}

// The text of the Updates card for the release check state of the server. action is the
// label of the button that opens the update dialog. It is empty when no update can
// start.
export function releaseText(release: Release | undefined, now: Date, locale?: string): { version: string; status: string; problem: string; action: string } {
  if (!release) return { version: '', status: 'Waiting for the server.', problem: '', action: '' };
  const version = `bbflow ${release.version}`;
  if (!release.canUpdate) {
    return { version, status: 'This build cannot check for a new version. Only a release build on macOS can check and update.', problem: '', action: '' };
  }
  const offer = release.offer;
  const checked = release.checked ? checkedTime(release.checked, now, locale) : '';
  let status = '';
  if (offer?.state === 'updating') status = `Updating to ${offer.available}…`;
  else if (offer) status = offer.installed ? `bbflow ${offer.available} is installed. A restart starts it.` : `bbflow ${offer.available} is available.`;
  else if (release.checking) status = 'Checking for a new version…';
  else if (!release.checked) status = 'No check since the server started.';
  else if (!release.error) status = 'This is the newest version.';
  if (status && checked && !release.checking && !release.error && offer?.state !== 'updating') status += ` Last checked ${checked}.`;
  const problems: string[] = [];
  if (offer?.state === 'failed') problems.push(`The update to ${offer.available} failed: ${offer.error || 'unknown error'}`);
  if (release.error && !release.checking) problems.push(`The check at ${checked} failed: ${release.error}`);
  const action = !offer || offer.state === 'updating' ? '' : offer.installed ? 'Restart…' : 'Update…';
  return { version, status, problem: problems.join(' '), action };
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

// The Updates card of Settings shows the release check state of the server. Check now
// asks the server to check at once. A dot on Settings in the sidebar tells of an offer.
// The dialog asks before the server stops its sessions for the update. A confirmation
// applies only to the offer that the dialog shows, so the view sends its revision.
export class UpdatePanel {
  private readonly card = element('settings-updates', HTMLElement);
  private readonly heading = element('settings-updates-title', HTMLElement);
  private readonly version = element('release-version', HTMLElement);
  private readonly status = element('release-status', HTMLElement);
  private readonly problem = element('release-problem', HTMLElement);
  private readonly check = element('release-check', HTMLButtonElement);
  private readonly button = element('update-open', HTMLButtonElement);
  private readonly releaseNotes = element('release-notes', HTMLAnchorElement);
  private readonly settings = element('settings-open', HTMLButtonElement);
  private readonly dialog = element('update-dialog', HTMLDialogElement);
  private readonly form = element('update-form', HTMLFormElement);
  private readonly title = element('update-title', HTMLElement);
  private readonly versions = element('update-versions', HTMLElement);
  private readonly help = element('update-help', HTMLElement);
  private readonly sessions = element('update-sessions', HTMLElement);
  private readonly notes = element('update-notes', HTMLAnchorElement);
  private readonly error = element('update-error', HTMLElement);
  private readonly submit = element('update-submit', HTMLButtonElement);
  private release: Release | undefined;
  // The offer that the open dialog shows.
  private shown: Update | undefined;
  // The IDs of the live sessions, from the same status message as the offer.
  private live: readonly string[] = [];
  private busy = false;
  private starting = false;
  // The offer or the live sessions changed while a start was pending. The dialog then
  // shows data that is not current, so it allows no other attempt.
  private stale = false;
  // The error of a start from this dialog. It stays until the dialog opens again.
  private startError = '';
  // The check time that the view knew when it asked for a check. The card shows the
  // check as running until the status watch reports it or a later check.
  private pending: string | undefined;
  // The error of the last check request from this view. A later check removes it.
  private checkError = '';
  // The dot on Settings shows.
  private dot = false;

  constructor(private readonly host: {
    // The title of a session in the list, or undefined when the list does not show it.
    title(id: string): string | undefined;
    start(offer: Update): Promise<void>;
    check(): Promise<void>;
  }) {
    this.button.onclick = () => this.open();
    this.check.onclick = () => void this.checkNow();
    element('update-cancel', HTMLButtonElement).onclick = element('update-close', HTMLButtonElement).onclick = () => this.dialog.close();
    this.form.onsubmit = event => { event.preventDefault(); void this.start(); };
    this.render();
  }

  // The status watch sends the release check state and the live sessions together,
  // after each change. Without an offer, the dialog closes. A new offer also closes the
  // dialog, because the user confirmed only the earlier offer. Another view can also
  // start the update. Then the card shows its progress. During a pending start, the
  // dialog becomes stale instead, so that it can still show the result of the start.
  show(release: Release | undefined, live: readonly string[]): void {
    if (release?.checking || release?.checked !== this.release?.checked) this.checkError = '';
    this.release = release;
    this.live = live;
    if (!release || release.checking || (release.checked ?? '') !== this.pending) this.pending = undefined;
    this.render();
    const update = release?.offer;
    if (!this.dialog.open || this.stale) return;
    if (update && update.state !== 'updating' && update.revision === this.shown?.revision) this.fill(update);
    else if (this.starting) this.stale = true;
    else this.dialog.close();
  }

  // The latest offer of the status watch. A lost watch keeps only an update in progress.
  get current(): Update | undefined { return this.release?.offer; }

  // attention tells if the dot on Settings shows. Then Settings opens at this card.
  get attention(): boolean { return this.dot; }

  // The session list changed, for example after a rename. An open dialog reads the
  // titles again.
  sessionsChanged(): void {
    if (this.dialog.open && this.shown && !this.stale) this.fill(this.shown);
  }

  // Without the status watch, the offer and the live sessions are unknown. Then the
  // card waits and the dialog closes until the watch sends them again. An update in
  // progress stays, because it cannot start again.
  lost(): void {
    if (this.release?.offer?.state !== 'updating') this.show(undefined, []);
  }

  // A page action in progress disables the buttons.
  controls(busy: boolean): void {
    this.busy = busy;
    this.render();
  }

  // reveal scrolls to the card and moves the focus to its heading.
  reveal(): void { revealCard(this.card, this.heading); }

  private render(): void {
    const release = this.release;
    const offer = release?.offer;
    const text = releaseText(release, new Date());
    this.version.textContent = text.version;
    this.version.hidden = !text.version;
    this.status.textContent = text.status;
    this.status.hidden = !text.status;
    this.problem.textContent = [text.problem, this.checkError].filter(Boolean).join(' ');
    this.problem.hidden = !this.problem.textContent;
    const checking = !!release?.checking || this.pending !== undefined;
    this.check.hidden = !release?.canUpdate;
    this.check.textContent = checking ? 'Checking…' : 'Check now';
    this.check.disabled = this.busy || checking || offer?.state === 'updating';
    this.button.hidden = !text.action;
    this.button.textContent = text.action;
    this.button.disabled = this.busy;
    this.releaseNotes.hidden = !offer;
    if (offer) this.releaseNotes.href = updateDialog(offer).notes;
    // The dot shows an offer that the user can start. The page bar shows an update in
    // progress.
    this.dot = !!offer && offer.state !== 'updating';
    this.settings.classList.toggle('has-update', this.dot);
    this.settings.classList.toggle('failed', offer?.state === 'failed');
    if (this.dot && offer) {
      const label = offer.state === 'failed' ? `The update to ${offer.available} failed` : offer.installed ? `Restart to use ${offer.available}` : `Update available: ${offer.available}`;
      this.settings.title = `${label}. bbflow ${offer.version} runs now.`;
      this.settings.setAttribute('aria-label', `Settings, ${label}`);
    } else {
      this.settings.title = '';
      this.settings.removeAttribute('aria-label');
    }
  }

  private async checkNow(): Promise<void> {
    if (this.pending !== undefined || this.release?.checking) return;
    this.pending = this.release?.checked ?? '';
    this.checkError = '';
    this.render();
    try {
      await this.host.check();
    } catch (error) {
      this.pending = undefined;
      this.checkError = `Could not check: ${errorMessage(error)}`;
      this.render();
    }
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
    const update = this.release?.offer;
    if (!update || update.state === 'updating') return;
    this.startError = '';
    this.stale = false;
    this.fill(update);
    this.submit.disabled = false;
    this.dialog.showModal();
  }

  private async start(): Promise<void> {
    const offer = this.shown;
    if (!offer || this.starting || this.stale) return;
    this.starting = true;
    this.startError = '';
    this.submit.disabled = true;
    try {
      await this.host.start(offer);
      this.dialog.close();
    } catch (error) {
      this.startError = errorMessage(error);
      if (this.stale) this.startError += ' The offer or the live sessions changed during the start. Close this dialog, then open the update again.';
      this.error.textContent = this.startError;
      this.error.hidden = false;
    } finally {
      this.starting = false;
      this.submit.disabled = this.stale;
    }
  }
}
