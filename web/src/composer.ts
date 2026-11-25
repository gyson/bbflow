import { element } from './dom.js';
import { DraftWatch } from './draft-watch.js';
import { call, encodeBytes, errorMessage } from './protocol.js';
import type { Attachment, ComposerState, Draft, Peer, ServerInfo } from './protocol.js';

const encoder = new TextEncoder();
const empty = (): ComposerState => ({ draft: { revision: 0, text: '', attachments: [], pending: false }, attachments: [] });
const sentElsewhere = 'A message was sent from another view. Your last edit here was not saved.';

// Decide whether a pushed draft replaces the draft in this view. The latest save wins,
// so this view keeps its own unsaved edits. A pushed pending draft always applies,
// because it records a send from another view.
export function acceptPushed(local: { revision: number; dirty: boolean }, pushed: Draft): boolean {
  return pushed.revision > local.revision && (!local.dirty || pushed.pending);
}

// This sends terminal paste through the PTY. It does not use a provider API. Do not
// infer readiness from output.
export function composeInput(text: string, files: Attachment[], bracketed: boolean): string {
  if (encoder.encode(text).length > 64 * 1024) throw new Error('The message limit is 64 KiB.');
  if (!text.trim() && !files.length) throw new Error('Write a message or attach a file first.');
  const paths = files.map(file => "'" + file.path.replaceAll("'", "'\\''") + "'");
  const message = (text + (text && paths.length ? '\n\n' : '') + paths.join('\n')).replace(/\r\n?/g, '\n');
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(message)) {
    throw new Error('Remove terminal control characters from the message before submitting.');
  }
  if (/[\n\t]/.test(message) && !bracketed) {
    throw new Error('This terminal has not enabled bracketed paste. Use direct terminal input for multiline messages, tabs, or multiple files.');
  }
  const paste = message.replaceAll('\n', '\r');
  return (bracketed ? `\x1b[200~${paste}\x1b[201~` : paste) + '\r';
}

// Command-Enter or Ctrl+Enter sends. Plain Enter adds a line. A key that completes an
// input method composition does not send.
export function sendShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean }): boolean {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !event.isComposing;
}

// Text goes into the editor at the cursor, or in place of the selected text. The rest of
// the draft and its files stay. No text goes in while a send is pending, because the
// draft is locked until the user checks the terminal.
export function insertProblem(state: { loaded: boolean; pending: boolean }): string | undefined {
  if (!state.loaded) return 'The message editor is not ready.';
  if (state.pending) return 'A send may have reached the terminal. Check the terminal and unlock the draft first.';
  return undefined;
}

interface Host {
  server(): ServerInfo | null;
  peer(): Peer | null;
  bracketed(): boolean;
  action(work: () => Promise<void>): Promise<void>;
  // The sent messages of the session can have changed: this view sent a message, or
  // another view saved a draft.
  sent(): void;
}

export class Composer {
  private readonly panel = element('composer', HTMLElement);
  private readonly text = element('composer-text', HTMLTextAreaElement);
  private readonly status = element('composer-status', HTMLElement);
  private readonly files = element('composer-files', HTMLElement);
  private readonly picker = element('composer-picker', HTMLInputElement);
  private readonly attach = element('composer-attach', HTMLButtonElement);
  private readonly submit = element('composer-submit', HTMLButtonElement);
  private readonly review = element('composer-review', HTMLButtonElement);
  private session = '';
  private state = empty();
  private edits = 0;
  private saved = 0;
  private saving: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private blocked = false;
  private active = false;
  private loaded = false;
  private watch: DraftWatch | null = null;
  private loading: (() => void) | undefined;
  private remote: ComposerState | undefined; // The newest pushed draft not yet applied.
  private generation = 0; // Changes when a draft from the server replaces this view's draft.
  private sending = false;
  private syncLost = false;

  constructor(private readonly host: Host) {
    this.text.oninput = () => this.edited();
    this.text.onkeydown = event => {
      if (!sendShortcut(event)) return;
      event.preventDefault();
      if (event.repeat || this.submit.disabled) return;
      // The send disables the editor, so the browser moves the focus to the page. Then
      // give the focus back to the editor, unless the user moved it to another control.
      void this.host.action(() => this.send()).then(() => {
        if (!document.activeElement || document.activeElement === document.body) this.text.focus();
      });
    };
    this.attach.onclick = () => this.picker.click();
    this.picker.onchange = () => {
      const files = Array.from(this.picker.files || []);
      this.picker.value = '';
      this.addFiles(files);
    };
    this.panel.onpaste = event => {
      const files = Array.from(event.clipboardData?.files || []);
      if (files.length) { event.preventDefault(); this.addFiles(files); }
    };
    this.panel.ondragover = event => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    this.panel.ondrop = event => {
      event.preventDefault();
      this.addFiles(Array.from(event.dataTransfer?.files || []));
    };
    this.submit.onclick = () => this.host.action(() => this.send());
    this.review.onclick = () => {
      this.state.draft.pending = false;
      this.changed();
      this.text.focus();
    };
    window.addEventListener('beforeunload', event => {
      if (this.unsaved) event.preventDefault();
    });
  }

  // True when the server has not saved the latest edit.
  get unsaved(): boolean { return this.edits !== this.saved; }

  controls(blocked = this.blocked, active = this.active): void {
    this.blocked = blocked;
    this.active = active;
    const unavailable = blocked || !this.loaded;
    this.text.disabled = this.attach.disabled = unavailable || this.state.draft.pending;
    this.submit.disabled = unavailable || !active || this.state.draft.pending || (!this.text.value.trim() && !this.state.attachments.length);
    this.review.hidden = !this.state.draft.pending;
    this.review.disabled = unavailable;
    for (const button of this.files.querySelectorAll('button')) button.disabled = unavailable || this.state.draft.pending;
  }

  // insertBlocked tells why text cannot go into the editor now, or undefined.
  insertBlocked(): string | undefined {
    return this.blocked ? 'Wait for the current action to finish.' : insertProblem({ loaded: this.loaded, pending: this.state.draft.pending });
  }

  // Put text in the editor at the cursor, or in place of the selected text, as a normal
  // edit. The editor keeps its cursor while another control has the focus. The browser
  // command keeps the edit in the undo history of the editor. The user still decides
  // when to send the message.
  insert(text: string): string | undefined {
    const problem = this.insertBlocked();
    if (problem) return problem;
    const start = this.text.selectionStart, end = this.text.selectionEnd;
    this.text.focus();
    this.text.setSelectionRange(start, end);
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, text); } catch { inserted = false; }
    // The command gives an input event, which saves the edit. Without the command, the
    // text goes in directly.
    if (!inserted) {
      this.text.setRangeText(text, start, end, 'end');
      this.edited();
    }
    return undefined;
  }

  private edited(): void {
    this.state.draft.text = this.text.value;
    this.changed();
  }

  // Show a problem of a message editor action, such as a handoff prompt that is not
  // available. The next edit replaces it.
  problem(text: string): void { this.message(text, true); }

  private message(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('form-error', error);
  }

  private savedMessage(): string {
    return this.state.draft.pending ? 'Submission may have reached the terminal. Check it before editing and submitting again.' : 'Draft saved';
  }

  private changed(): void {
    this.edits++;
    this.message('Saving draft…');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.flush().catch(() => {}); }, 400);
    this.controls();
  }

  // Serialize saves with the server revision from the previous save. Edits during an
  // active save get another revision. Session changes wait for all saves. The server
  // rejects a save only to keep a send from another view. This view then shows the
  // latest draft.
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.saving) {
      await this.saving;
      return this.flush();
    }
    if (this.saved === this.edits) return;
    const server = this.host.server();
    if (!server || !this.session) throw new Error('Cannot save this draft until the server is connected.');
    this.saving = (async () => {
      while (this.saved !== this.edits) {
        const version = this.edits;
        const result = await call(server, { operation: 'composer-draft', session: this.session,
          draft: { ...this.state.draft, attachments: [...this.state.draft.attachments] } });
        if (result.rejected) {
          // The server rejects a save only after a send from another view. The watch
          // gives the same draft later, so report the send here.
          this.apply(result, sentElsewhere);
          this.host.sent();
          return;
        }
        this.state.draft.revision = result.draft.revision;
        this.saved = version;
      }
      this.message(this.savedMessage());
    })();
    try { await this.saving; }
    catch (error) { this.message(`Draft not saved: ${errorMessage(error)}`, true); throw error; }
    finally {
      this.saving = undefined;
      this.reconcile();
    }
  }

  // Each selected session has one draft watch. The first pushed draft loads the editor.
  async select(session: string): Promise<void> {
    await this.flush();
    this.finishLoading();
    this.watch?.close();
    this.watch = null;
    this.session = session;
    this.loaded = this.syncLost = false;
    this.state = empty();
    this.remote = undefined;
    this.edits = this.saved = 0;
    this.generation++;
    this.text.value = '';
    this.renderFiles();
    this.controls();
    if (!session) { this.message(''); return; }
    this.message('Loading draft…');
    const server = this.host.server();
    if (!server) return;
    await new Promise<void>(resolve => {
      this.loading = resolve;
      this.watch = new DraftWatch(server, session, {
        draft: state => {
          this.receive(state);
          this.finishLoading();
        },
        failed: (error, retrying) => {
          this.syncLost = true;
          if (!this.loaded) this.message(`Cannot load draft: ${errorMessage(error)}`, true);
          else if (retrying) this.message('Draft sync paused. Reconnecting…', true);
          else this.message(`Draft sync stopped: ${errorMessage(error)}`, true);
          this.finishLoading();
          this.controls();
        },
      });
    });
  }

  private finishLoading(): void {
    this.loading?.();
    this.loading = undefined;
  }

  private receive(next: ComposerState): void {
    if (this.syncLost) {
      this.syncLost = false;
      if (this.loaded && !this.saving && this.edits === this.saved) this.message(this.savedMessage());
    }
    if (!this.loaded) { this.apply(next); return; }
    if (next.draft.revision <= this.state.draft.revision) return;
    // A send from another view saves a pending draft and then a clear draft. The watch
    // keeps only the latest draft, also for a connected view, so a newer draft of any
    // kind can follow a send. The host reads the sent messages to find out.
    this.host.sent();
    if (!this.remote || next.draft.revision > this.remote.draft.revision) this.remote = next;
    this.reconcile();
  }

  // Wait for an active save. Its reply decides which draft is newer.
  private reconcile(): void {
    const next = this.remote;
    if (!next || this.saving) return;
    if (next.draft.revision <= this.state.draft.revision) { this.remote = undefined; return; }
    const dirty = this.sending || this.edits !== this.saved;
    if (!acceptPushed({ revision: this.state.draft.revision, dirty }, next.draft)) return;
    this.apply(next, dirty ? sentElsewhere : undefined);
  }

  // Replace the whole draft with a draft from the server. Keep the cursor position when
  // this view has focus.
  private apply(next: ComposerState, note?: string): void {
    this.generation++;
    clearTimeout(this.timer);
    this.remote = undefined;
    const focused = document.activeElement === this.text;
    const { selectionStart, selectionEnd } = this.text;
    this.state = { draft: next.draft, attachments: next.attachments };
    this.saved = this.edits;
    this.loaded = true;
    if (this.text.value !== next.draft.text) {
      this.text.value = next.draft.text;
      const length = next.draft.text.length;
      if (focused) this.text.setSelectionRange(Math.min(selectionStart, length), Math.min(selectionEnd, length));
    }
    this.renderFiles();
    this.message(note ?? this.savedMessage(), !!note);
    this.controls();
  }

  private renderFiles(): void {
    this.files.replaceChildren();
    for (const file of this.state.attachments) {
      const chip = document.createElement('span');
      chip.className = 'composer-file';
      chip.title = file.path;
      const name = document.createElement('span');
      name.textContent = file.name;
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.onclick = () => {
        this.state.attachments = this.state.attachments.filter(item => item.id !== file.id);
        this.state.draft.attachments = this.state.attachments.map(item => item.id);
        this.changed();
        this.renderFiles();
        this.controls();
      };
      chip.append(name, remove);
      this.files.append(chip);
    }
  }

  private addFiles(files: File[]): void {
    if (!files.length || this.blocked || !this.loaded || this.state.draft.pending) return;
    this.host.action(async () => {
      const server = this.host.server();
      if (!server) return;
      try {
        if (files.length + this.state.attachments.length > 8) throw new Error('Attach up to 8 files per message.');
        if (files.some(file => file.size > 4 * 1024 * 1024)) throw new Error('Each file must be 4 MiB or smaller.');
        await this.flush();
        for (const file of files) {
          this.message(`Copying ${file.name}…`);
          const attachment = await call(server, { operation: 'composer-attach', session: this.session,
            upload: { name: file.name, mediaType: file.type, data: encodeBytes(new Uint8Array(await file.arrayBuffer())) } });
          this.state.attachments.push(attachment);
          this.state.draft.attachments.push(attachment.id);
          this.changed();
          this.renderFiles();
          await this.flush();
        }
      } catch (error) { this.message(errorMessage(error), true); }
    });
  }

  // Stop when a draft from another view replaces this draft during the send.
  private async send(): Promise<void> {
    const peer = this.host.peer();
    if (!this.loaded || !this.active || !peer?.active || this.state.draft.pending) return;
    const generation = this.generation;
    this.sending = true;
    // The archive has the pending revision of this send. The list of the sent messages
    // then has the message, also when its receipt is lost.
    let recorded = false;
    try {
      await this.flush();
      if (generation !== this.generation) return;
      const input = composeInput(this.state.draft.text, this.state.attachments, this.host.bracketed());
      // Save the uncertainty marker before any bytes leave this browser.
      this.state.draft.pending = true;
      this.changed();
      await this.flush();
      if (generation !== this.generation) return;
      recorded = true;
      this.message('Submitting to terminal…');
      // The input ID names the pending revision. Its receipt can start the title job.
      await peer.writeInput(encodeBytes(encoder.encode(input)), `draft-${this.state.draft.revision}`);
      if (generation !== this.generation) {
        this.message('Submitted to terminal. Another view changed the draft, so this view did not clear it.', true);
        return;
      }
      this.state.draft.text = '';
      this.state.draft.attachments = [];
      this.state.draft.pending = false;
      this.state.attachments = [];
      this.text.value = '';
      this.renderFiles();
      this.changed();
      await this.flush();
      this.message('Submitted to terminal');
    } catch (error) { this.message(errorMessage(error), true); }
    finally {
      this.sending = false;
      this.reconcile();
      // Report the send after the draft is clear, so that the list shows its receipt.
      // After a lost receipt, the list shows the message as not confirmed.
      if (recorded) this.host.sent();
    }
  }
}
