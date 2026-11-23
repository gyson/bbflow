import { element } from './dom.js';
import { call, errorMessage } from './protocol.js';
import type { SentMessage, ServerInfo } from './protocol.js';
import type { MarkState } from './message-nav.js';

// A long message first shows foldLines lines. The first Show more adds foldStep lines.
// A message is not folded when fewer than foldMinimum lines would stay hidden.
const foldLines = 8, foldStep = 16, foldMinimum = 4;

// The Messages view of the workspace pane lists the messages that Send sent in one
// session. The newest message is at the bottom. The view only reads history. Show in
// terminal scrolls the session terminal to the message. Copy puts the message text on
// the clipboard, for use in any session.
export class SentHistory {
  private readonly list = element('sent-list', HTMLOListElement);
  private readonly status = element('sent-status', HTMLElement);
  private readonly more = element('sent-more', HTMLButtonElement);
  private session = '';
  private shown = false;
  private loaded = false; // The list shows the newest messages of the session.
  private oldest = 0;
  private request = 0; // Changes on each load and each session. A late reply is ignored.
  private readonly items = new Map<number, { item: HTMLLIElement; go: HTMLButtonElement }>();

  constructor(private readonly server: () => ServerInfo | null, private readonly marks: {
    // Whether the session terminal shows the message, and whether the view reads it.
    state(revision: number): MarkState;
    // Scroll the session terminal to the message.
    go(revision: number): boolean;
  }) {
    this.more.onclick = () => { void this.load(); };
  }

  // Select the session of the view. The list loads when the view shows.
  select(session: string): void {
    this.session = session;
    this.clear();
    if (this.shown) void this.load();
  }

  setShown(shown: boolean): void {
    this.shown = shown;
    if (shown && !this.loaded) void this.load();
  }

  // A message was sent. Read the newest messages again.
  refresh(): void {
    this.clear();
    if (this.shown) void this.load();
  }

  // Show which messages the session terminal shows, and the message that the view reads.
  mark(): void {
    for (const [revision, { item, go }] of this.items) {
      const state = this.marks.state(revision);
      const current = state === 'current';
      if (current && !item.classList.contains('current') && this.shown) item.scrollIntoView({ block: 'nearest' });
      item.classList.toggle('current', current);
      go.disabled = state === 'missing';
      go.title = go.disabled
        ? 'The terminal that this view shows does not show this message.'
        : 'Scroll the session terminal to this message. The position comes from the terminal text.';
    }
  }

  private clear(): void {
    this.request++;
    this.loaded = false;
    this.oldest = 0;
    this.items.clear();
    this.list.replaceChildren();
    this.more.hidden = true;
    this.message('');
  }

  private message(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('form-error', error);
  }

  // The server returns each page newest first. Each page goes above the messages that the
  // list already shows. The first page scrolls to the newest message. An older page keeps
  // the visible messages in place.
  private async load(): Promise<void> {
    const server = this.server();
    if (!server || !this.session) return;
    const request = ++this.request;
    const older = this.oldest !== 0;
    this.more.disabled = true;
    if (older) this.more.textContent = 'Loading…';
    else this.message('Loading sent messages…');
    try {
      const page = await call(server, { operation: 'composer-sent', session: this.session, ...(older ? { revision: this.oldest } : {}) });
      if (request !== this.request) return;
      this.loaded = true;
      const below = this.list.scrollHeight - this.list.scrollTop;
      const items = page.messages.map(message => this.item(message)).reverse();
      this.list.prepend(...items);
      for (const item of items) this.fold(item);
      this.oldest = page.messages.at(-1)?.revision ?? this.oldest;
      this.more.hidden = !page.more;
      this.list.scrollTop = this.list.scrollHeight - (older ? below : 0);
      this.message(this.list.childElementCount ? '' : 'Send has not sent a message in this session.');
      this.mark();
    } catch (error) {
      if (request === this.request) this.message(`Cannot load sent messages: ${errorMessage(error)}`, true);
    } finally {
      if (request === this.request) {
        this.more.disabled = false;
        this.more.textContent = 'Show older messages';
      }
    }
  }

  // A long message shows its first lines. Show more shows a step of lines, and each step
  // is double the previous one. Show less returns to the first lines. Call fold after the
  // item is in the list, because it measures the rendered text.
  private fold(item: HTMLLIElement): void {
    const text = item.querySelector<HTMLElement>('.sent-text');
    const fold = item.querySelector<HTMLElement>('.sent-fold');
    if (!text || !fold) return;
    const line = parseFloat(getComputedStyle(text).lineHeight) || 20;
    const lines = () => Math.round(text.scrollHeight / line);
    let shown = 0, step = 0;
    const more = document.createElement('button');
    const less = document.createElement('button');
    less.textContent = 'Show less';
    const show = (count: number) => {
      // Measure after the height change, because a new list scroll bar can change the wrap.
      text.style.maxHeight = `${count * line}px`;
      const total = lines();
      // Show all of the text when only a few lines stay hidden.
      shown = total - count < foldMinimum ? total : count;
      const hidden = total - shown;
      text.classList.toggle('folded', hidden > 0);
      text.style.maxHeight = hidden > 0 ? `${shown * line}px` : '';
      const next = hidden - step < foldMinimum ? hidden : step;
      more.hidden = hidden === 0;
      more.textContent = next === hidden ? `Show ${hidden} more lines` : `Show ${next} more lines (${hidden} hidden)`;
      less.hidden = shown <= foldLines;
      fold.hidden = more.hidden && less.hidden;
    };
    // When a click hides its button, the other button gets the keyboard focus.
    more.onclick = () => {
      const count = shown + step;
      step *= 2;
      show(count);
      if (more.hidden) less.focus();
    };
    less.onclick = () => {
      step = foldStep;
      show(foldLines);
      if (less.hidden) more.focus({ preventScroll: true });
      item.scrollIntoView({ block: 'nearest' });
    };
    fold.append(more, less);
    step = foldStep;
    show(foldLines);
  }

  private item(message: SentMessage): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'sent-item';
    const meta = document.createElement('div');
    meta.className = 'sent-meta';
    const state = document.createElement('span');
    state.className = message.confirmed ? 'badge' : 'badge unconfirmed';
    state.textContent = message.confirmed ? 'Sent' : 'Not confirmed';
    state.title = message.confirmed
      ? 'The terminal received this message. bbflow cannot confirm that the application accepted it.'
      : 'bbflow did not get a receipt for this message. Check the terminal output.';
    const time = document.createElement('time');
    time.dateTime = message.created;
    time.textContent = new Date(message.created).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.title = 'Copy the message text to the clipboard.';
    copy.disabled = !message.text;
    let reset: ReturnType<typeof setTimeout> | undefined;
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(message.text);
        copy.textContent = 'Copied';
        clearTimeout(reset);
        reset = setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      } catch (error) { this.message(`Cannot copy the message: ${errorMessage(error)}`, true); }
    };
    const go = document.createElement('button');
    go.textContent = 'Show in terminal';
    go.onclick = () => {
      if (!this.marks.go(message.revision)) this.mark();
    };
    this.items.set(message.revision, { item, go });
    meta.append(state, time, go, copy);
    const text = document.createElement('div');
    text.className = 'sent-text';
    text.textContent = message.text || 'No text';
    text.classList.toggle('empty', !message.text);
    const fold = document.createElement('div');
    fold.className = 'sent-fold';
    fold.hidden = true;
    item.append(meta, text, fold);
    if (message.attachments.length) {
      const files = document.createElement('div');
      files.className = 'sent-files';
      files.setAttribute('aria-label', 'Attached files');
      for (const file of message.attachments) {
        const chip = document.createElement('span');
        chip.className = 'composer-file';
        chip.title = file.path;
        chip.textContent = file.name;
        files.append(chip);
      }
      item.append(files);
    }
    return item;
  }
}
