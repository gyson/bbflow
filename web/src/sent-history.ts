import { element } from './dom.js';
import { messageTerminal } from './message-marks.js';
import { call, errorMessage } from './protocol.js';
import type { SentMessage, ServerInfo, TerminalInfo } from './protocol.js';
import type { MarkState } from './message-nav.js';
import { isLive, terminalTimes } from './terminal-picker.js';

// A long message first shows foldLines lines. The first Show more adds foldStep lines.
// A message is not folded when fewer than foldMinimum lines would stay hidden.
const foldLines = 8, foldStep = 16, foldMinimum = 4;

// The Messages view of the workspace pane lists the messages that Send sent in one
// session. The newest message is at the bottom. The view only reads history. A session
// with several terminals shows a heading above the messages of each terminal. Show in
// terminal scrolls the shown terminal to the message. For a message of another terminal,
// the button names that terminal, and a click opens that terminal first. Copy puts the
// message text on the clipboard, for use in any session.
export class SentHistory {
  private readonly list = element('sent-list', HTMLOListElement);
  private readonly status = element('sent-status', HTMLElement);
  private readonly more = element('sent-more', HTMLButtonElement);
  private session = '';
  private shown = false;
  private loaded = false; // The list shows the newest messages of the session.
  private oldest = 0;
  private request = 0; // Changes on each load and each session. A late reply is ignored.
  private readonly items = new Map<number, { item: HTMLLIElement; go: HTMLButtonElement; created: string }>();
  private grouped = ''; // The terminals and messages of the shown headings. See group.

  constructor(private readonly server: () => ServerInfo | null, private readonly host: {
    // Whether the shown terminal shows the message, and whether the view reads it.
    state(revision: number): MarkState;
    // Scroll the shown terminal to the message.
    go(revision: number): boolean;
    // The terminals of the session in start order.
    terminals(): readonly TerminalInfo[];
    // The terminal that the session view shows.
    shown(): TerminalInfo | undefined;
    // Open another terminal of the session and scroll it to the message.
    open(revision: number, terminal: TerminalInfo): void;
  }) {
    this.more.onclick = () => { void this.load(); };
  }

  // Select the session of the view. The list loads when the view shows. A change of the
  // shown terminal keeps the list, because the list has the messages of all terminals.
  select(session: string): void {
    if (session === this.session) return;
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

  // Show which messages the shown terminal shows, and the message that the view reads. A
  // message of another terminal gets a button that names its terminal.
  mark(): void {
    const terminals = this.host.terminals();
    const shown = this.host.shown();
    this.group(terminals, shown);
    for (const [revision, { item, go, created }] of this.items) {
      const state = this.host.state(revision);
      const current = state === 'current';
      if (current && !item.classList.contains('current') && this.shown) item.scrollIntoView({ block: 'nearest' });
      item.classList.toggle('current', current);
      const button = showButton(state, terminals, shown, created);
      go.disabled = button.disabled;
      go.textContent = button.text;
      go.title = button.title;
    }
  }

  // A session with several terminals shows a heading above the messages of each
  // terminal. The heading of the shown terminal says that the view shows it. The
  // headings change only when the terminals or the messages change.
  private group(terminals: readonly TerminalInfo[], shown: TerminalInfo | undefined): void {
    const key = terminals.length < 2 ? '' : [shown?.number ?? 0, this.items.size,
      ...terminals.map(terminal => `${terminal.number}|${terminal.tool}|${terminal.status}|${terminal.started}|${terminal.ended}`)].join(' ');
    if (key === this.grouped) return;
    this.grouped = key;
    this.list.classList.toggle('grouped', !!key);
    for (const heading of this.list.querySelectorAll('.sent-terminal')) heading.remove();
    if (!key) return;
    let last: TerminalInfo | null | undefined = null;
    for (const item of this.list.querySelectorAll<HTMLLIElement>('.sent-item')) {
      const terminal = messageTerminal(terminals, item.dataset.created ?? '');
      if (terminal === last) continue;
      last = terminal;
      item.before(terminalHeading(terminal, !!terminal && terminal.number === shown?.number));
    }
  }

  private clear(): void {
    this.request++;
    this.loaded = false;
    this.oldest = 0;
    this.items.clear();
    this.grouped = '';
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
      // An older page keeps the first visible message in place. A heading above it can
      // move to the new messages, so the view measures the message itself.
      const anchor = older ? this.list.querySelector('.sent-item') : null;
      const top = anchor?.getBoundingClientRect().top ?? 0;
      const items = page.messages.map(message => this.item(message)).reverse();
      this.list.prepend(...items);
      for (const item of items) this.fold(item);
      this.oldest = page.messages.at(-1)?.revision ?? this.oldest;
      this.more.hidden = !page.more;
      this.group(this.host.terminals(), this.host.shown());
      if (anchor) this.list.scrollTop += anchor.getBoundingClientRect().top - top;
      else this.list.scrollTop = this.list.scrollHeight;
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

  // Scroll the shown terminal to the message. A message of another terminal first opens
  // that terminal.
  private show(message: SentMessage): void {
    if (this.host.go(message.revision)) return;
    const other = elsewhere(this.host.terminals(), this.host.shown(), message.created);
    if (other) this.host.open(message.revision, other);
    else this.mark();
  }

  private item(message: SentMessage): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'sent-item';
    item.dataset.created = message.created;
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
    go.onclick = () => this.show(message);
    this.items.set(message.revision, { item, go, created: message.created });
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

// showButton returns the Show in terminal button of a message. The button scrolls the
// shown terminal to a message that it shows. For a message of another terminal, the
// button names that terminal. Otherwise the button is off.
export function showButton(state: MarkState, terminals: readonly TerminalInfo[], shown: TerminalInfo | undefined, created: string): { text: string; title: string; disabled: boolean } {
  const other = state === 'missing' ? elsewhere(terminals, shown, created) : undefined;
  if (other) {
    return {
      text: `Show in terminal ${other.number}`,
      title: other === terminals.at(-1) && isLive(other)
        ? `Open terminal ${other.number}, the live terminal, and scroll it to this message.`
        : `Open the saved final screen of terminal ${other.number} and scroll it to this message. Input and Send are off in that view.`,
      disabled: false,
    };
  }
  return state === 'missing'
    ? { text: 'Show in terminal', title: 'The terminal that this view shows does not show this message.', disabled: true }
    : { text: 'Show in terminal', title: 'Scroll the session terminal to this message. The position comes from the terminal text.', disabled: false };
}

// terminalHeadingText names a terminal, its tool, and its status for the heading above
// its messages.
export function terminalHeadingText(terminal: TerminalInfo | undefined): string {
  return terminal ? `Terminal ${terminal.number} · ${terminal.tool || 'Unknown tool'} · ${terminal.status}` : 'Unknown terminal';
}

// elsewhere returns the terminal of a message when it is not the shown terminal, or
// undefined.
function elsewhere(terminals: readonly TerminalInfo[], shown: TerminalInfo | undefined, created: string): TerminalInfo | undefined {
  const terminal = messageTerminal(terminals, created);
  return terminal && shown && terminal.number !== shown.number ? terminal : undefined;
}

// The heading above the messages of one terminal. It names the terminal, its tool, its
// status, and its times.
function terminalHeading(terminal: TerminalInfo | undefined, shown: boolean): HTMLLIElement {
  const row = document.createElement('li');
  row.className = 'sent-terminal';
  const name = document.createElement('span');
  name.className = 'sent-terminal-name';
  name.textContent = terminalHeadingText(terminal);
  row.append(name);
  if (terminal) {
    const times = document.createElement('span');
    times.className = 'sent-terminal-times';
    times.textContent = terminalTimes(terminal);
    row.append(times);
  }
  if (shown) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Shown';
    badge.title = 'The session view shows this terminal.';
    row.append(badge);
  }
  return row;
}
