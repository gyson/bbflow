import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { element } from './dom.js';
import { call, errorMessage } from './protocol.js';
import type { SentMessage, ServerInfo, TerminalInfo } from './protocol.js';
import { addPage, barState, emptyCache, locate, messageTime, sentText, stepMark, wantsOlder } from './message-marks.js';

// The shortest time between two searches of the terminal rows, in milliseconds. A
// search of many rows waits longer, so that it takes a small part of the time.
const searchDelay = 300, searchShare = 10;
const flashTime = 1200;

export type MarkState = 'current' | 'found' | 'missing';
// The result of a seek. cancelled means that the view changed before the seek ended.
// failed means that the view could not read the sent messages. See readError.
export type SeekResult = 'found' | 'missing' | 'cancelled' | 'failed';

interface Mark { message: SentMessage; row: number; marker?: IMarker; decoration?: IDecoration | undefined }

// MessageNav finds the sent messages of the selected session in the rows of the session
// terminal. The bar above the terminal gives the number and the time of the message that
// the view reads. The tooltip of that label has the text of the message. The bar
// buttons step to the earlier message, the later message, and the latest output. Each
// found message has a mark on its row and in the scroll bar.
//
// The positions are derived from the text that the terminal shows. They are searched
// again after new output, so they follow an application that draws its output again.
// The view reads only the messages that Send sent. See message-marks.ts for the search.
export class MessageNav {
  private readonly bar = element('message-bar', HTMLElement);
  private readonly open = element('message-open', HTMLButtonElement);
  private readonly previous = element('message-previous', HTMLButtonElement);
  private readonly next = element('message-next', HTMLButtonElement);
  private readonly latest = element('message-latest', HTMLButtonElement);
  private view: Terminal | null = null;
  private listeners: IDisposable[] = [];
  private session = '';
  private terminal: TerminalInfo | undefined;
  private cache = emptyCache(); // The sent messages of the shown terminal.
  private loading = false;
  private loaded = false; // The view read the newest page for the shown terminal.
  private failure = ''; // The error of the last read of sent messages, or empty.
  private drawn = false; // The terminal of the view drew a frame.
  // A jump that waits until the view can find its message. See seek.
  private seeking: { revision: number; done(result: SeekResult): void } | null = null;
  // The newest page of sent messages that the view read last, as text. A reload with a
  // different page tells the host that the sent messages changed.
  private newest: string | null = null;
  private reading = false; // A read of the newest page is active.
  private again = false; // A reload came during that read.
  private request = 0; // Changes on each session and each reload. A late reply is ignored.
  private marks: Mark[] = [];
  // The last jump target while the view did not scroll. See currentMark.
  private pinned: { revision: number; top: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cost = 0;
  private shown = ''; // The bar that render showed last.
  private reported = ''; // The message states that the host saw last.

  constructor(private readonly host: {
    server(): ServerInfo | null;
    // The color of the marks, for the color scheme of the terminal.
    color(): string;
    // Show the session terminal when the workspace pane takes its place.
    reveal(): void;
    // Open the list of the sent messages.
    list(): void;
    // The user moved the view to a message or to the latest output: a jump, a step, or
    // Latest output.
    moved(): void;
    // The state of a message changed.
    changed(): void;
    // The newest sent messages of the session changed.
    sent(): void;
  }) {
    this.previous.onclick = () => this.step(-1);
    this.next.onclick = () => this.step(1);
    this.latest.onclick = () => this.end();
    this.open.onclick = () => this.host.list();
    // No session is selected yet, and the host is not ready for a report.
    this.bar.hidden = true;
  }

  // Use the terminal of the view. A new terminal has no marks.
  attach(view: Terminal): void {
    for (const listener of this.listeners) listener.dispose();
    this.view = view;
    this.drawn = false;
    view.element?.style.setProperty('--message-mark', this.host.color());
    this.marks = [];
    this.pinned = null;
    this.listeners = [view.onScroll(() => this.render()), view.onRender(() => this.render())];
    this.render();
    this.schedule(0);
  }

  // Leave the terminal of the view, before the host disposes it. No later search reads
  // that terminal.
  detach(): void {
    for (const listener of this.listeners) listener.dispose();
    this.listeners = [];
    this.select('');
    this.view = null;
  }

  // Select the session of the view and read its sent messages. An empty session, for a
  // draft, hides the bar.
  select(session: string): void {
    this.session = session;
    this.terminal = undefined;
    this.newest = null;
    this.reset();
    if (session) void this.load(false);
  }

  // Limit the messages to the terminal that the view shows. Without it, an earlier
  // terminal could show the position of a message from a later terminal.
  window(terminal: TerminalInfo | undefined): void {
    if (terminal?.run === this.terminal?.run && terminal?.started === this.terminal?.started && terminal?.ended === this.terminal?.ended) return;
    if (terminal?.run !== this.terminal?.run) this.finish('cancelled');
    this.terminal = terminal;
    this.loaded = false;
    this.failure = '';
    // The cache keeps only the messages of one terminal. Read them again. The marks stay
    // until the next search.
    this.cache = emptyCache();
    if (this.session) void this.load(false);
  }

  // The terminal drew a frame. A seek searches at once.
  rendered(): void {
    this.drawn = true;
    this.schedule(this.seeking ? 0 : undefined);
  }

  // The sent messages can have changed. Read the newest page again. Calls during a read
  // cause one more read after it.
  reload(): void {
    if (!this.session) return;
    if (this.reading) this.again = true;
    else void this.load(false);
  }

  // Draw the marks again in the color of the changed color scheme.
  restyle(): void {
    this.view?.element?.style.setProperty('--message-mark', this.host.color());
    this.clear();
    this.schedule(0);
  }

  state(revision: number): MarkState {
    const index = this.marks.findIndex(mark => mark.message.revision === revision);
    return index < 0 ? 'missing' : index === this.position().current ? 'current' : 'found';
  }

  // Scroll the terminal to a message. Return false when the terminal does not show it.
  go(revision: number): boolean {
    this.host.moved();
    this.finish('cancelled');
    // The rows can be older than the output. Search again before the jump.
    this.search();
    const index = this.marks.findIndex(mark => mark.message.revision === revision);
    if (index < 0) return false;
    this.jump(index);
    return true;
  }

  // The error of the last read of sent messages, or empty.
  get readError(): string { return this.failure; }

  // Scroll to a message after the view opened another terminal. The view jumps when a
  // search finds the message. The seek ends without a jump when the terminal drew its
  // first frame, and the view read every message that it can find, without the message.
  // A read of the sent messages that fails also ends the seek. When the newest page
  // failed before the seek, the seek reads it again first. Another jump, a step, and a
  // change of the session or the terminal cancel the seek.
  seek(revision: number): Promise<SeekResult> {
    this.finish('cancelled');
    if (!this.session || !this.view) return Promise.resolve('cancelled');
    return new Promise(done => {
      this.seeking = { revision, done };
      if (this.failure && !this.loading && !this.loaded) void this.load(false);
      this.schedule(0);
    });
  }

  // Step to the earlier (-1) or the later (1) message. A step after the last message
  // shows the latest output.
  step(direction: -1 | 1): void {
    const view = this.view;
    if (!view) return;
    this.host.moved();
    this.finish('cancelled');
    this.search();
    const target = stepMark(this.rows(), view.buffer.active.viewportY, this.pin(), direction);
    if (target === 'end') this.end();
    else if (target !== null) this.jump(target);
  }

  // Show the latest output.
  private end(): void {
    this.host.moved();
    this.finish('cancelled');
    this.host.reveal();
    this.view?.scrollToBottom();
    this.focus();
  }

  private reset(): void {
    this.finish('cancelled');
    this.request++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.cache = emptyCache();
    this.loading = this.reading = this.again = this.loaded = false;
    this.failure = '';
    this.pinned = null;
    this.clear();
    this.marks = [];
    this.render();
    this.host.changed();
  }

  // Read the newest messages, or one more page of older messages.
  private async load(older: boolean): Promise<void> {
    const server = this.host.server();
    const session = this.session;
    if (!server || !session || (older && this.loading)) return;
    const request = older ? this.request : ++this.request;
    this.loading = true;
    this.failure = '';
    if (!older) this.reading = true;
    try {
      const page = await call(server, { operation: 'composer-sent', session, ...(older ? { revision: this.cache.cursor } : {}) });
      if (request !== this.request) return;
      this.cache = addPage(this.cache, page, older, this.terminal);
      this.schedule(0);
      if (older) return;
      this.loaded = true;
      const newest = page.messages.map(message => `${message.revision}:${message.confirmed}`).join(' ');
      const changed = this.newest !== null && this.newest !== newest;
      this.newest = newest;
      if (changed) this.host.sent();
    } catch (error) {
      // Without the messages, the bar shows no position. The list reports the failure,
      // and a seek reports it too.
      if (request === this.request) this.failure = errorMessage(error);
    } finally {
      if (request === this.request) {
        this.loading = false;
        if (!older) {
          this.reading = false;
          if (this.again) { this.again = false; void this.load(false); }
        }
        if (this.failure) this.settle();
      }
    }
  }

  private schedule(delay = Math.max(searchDelay, this.cost * searchShare)): void {
    if (delay === 0) clearTimeout(this.timer);
    else if (this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.search(); }, delay);
  }

  // Find the messages in the rows of the terminal, then show the marks.
  private search(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const view = this.view;
    const started = performance.now();
    const buffer = view?.buffer.active;
    const candidates = this.cache.messages;
    let rows: number[] = [];
    // The frames of the server draw an alternate screen on the screen rows of the normal
    // buffer, below its scrollback. Thus the view always reads the normal buffer.
    if (buffer && candidates.length) {
      const lines: string[] = [];
      for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
      rows = locate(lines, candidates.map(sentText));
    }
    const found = candidates.flatMap((message, index) => (rows[index] ?? -1) >= 0 ? [{ message, row: rows[index] ?? 0 }] : []);
    this.mark(found);
    this.cost = performance.now() - started;
    const oldest = candidates[0];
    if (!this.loading && wantsOlder(this.cache, !!oldest && found[0]?.message === oldest, this.terminal)) void this.load(true);
    this.settle();
  }

  // Jump to the message of the seek, or end the seek when the view cannot find it.
  private settle(): void {
    const seeking = this.seeking;
    if (!seeking) return;
    const index = this.marks.findIndex(mark => mark.message.revision === seeking.revision);
    if (index >= 0) {
      this.finish('found');
      this.jump(index);
    } else if (this.loading) {
      // Wait for the read.
    } else if (this.failure) {
      this.finish('failed');
    } else if (this.drawn && this.loaded) {
      this.finish('missing');
    }
  }

  private finish(result: SeekResult): void {
    const seeking = this.seeking;
    this.seeking = null;
    seeking?.done(result);
  }

  // The row of each mark. A marker moves when the scrollback drops its oldest rows, so
  // its line is newer than the row of the last search.
  private rows(): number[] {
    return this.marks.map(mark => mark.marker && !mark.marker.isDisposed && mark.marker.line >= 0 ? mark.marker.line : mark.row);
  }

  // Keep the marks when each message is still on its row. Otherwise, draw them again.
  private mark(found: Mark[]): void {
    const same = found.length === this.marks.length && found.every((mark, index) => {
      const old = this.marks[index];
      // A terminal reset removes the decorations and can keep the markers.
      return !!old && old.message.revision === mark.message.revision && old.marker?.isDisposed === false &&
        old.decoration?.isDisposed === false && old.marker.line === mark.row;
    });
    if (same) {
      // A marker moves when the scrollback drops its oldest rows. Keep its new row.
      found.forEach((mark, index) => { const old = this.marks[index]; if (old) old.row = mark.row; });
      this.render();
      return;
    }
    this.clear();
    this.marks = found;
    const view = this.view;
    if (view) {
      const buffer = view.buffer.active;
      const color = this.host.color();
      for (const mark of this.marks) {
        // A marker keeps its row while output scrolls the rows.
        mark.marker = view.registerMarker(mark.row - buffer.baseY - buffer.cursorY);
        mark.decoration = view.registerDecoration({ marker: mark.marker, overviewRulerOptions: { color, position: 'full' } });
        mark.decoration?.onRender(node => node.classList.add('message-mark'));
      }
    }
    this.render();
    this.host.changed();
  }

  private clear(): void {
    for (const mark of this.marks) {
      mark.decoration?.dispose();
      mark.marker?.dispose();
      delete mark.decoration;
      delete mark.marker;
    }
  }

  // The index of the pinned mark, or -1 after the view scrolled.
  private pin(): number {
    const top = this.view?.buffer.active.viewportY;
    if (!this.pinned || this.pinned.top !== top) return -1;
    return this.marks.findIndex(mark => mark.message.revision === this.pinned?.revision);
  }

  // The message that the view reads and the available buttons, for the view position.
  private position() {
    const buffer = this.view?.buffer.active;
    const top = buffer?.viewportY ?? 0;
    return barState(this.rows(), top, this.pin(), !buffer || top >= buffer.baseY);
  }

  private jump(index: number): void {
    const view = this.view, mark = this.marks[index], row = this.rows()[index];
    if (!view || !mark || row === undefined) return;
    this.host.reveal();
    view.scrollToLine(row);
    this.pinned = { revision: mark.message.revision, top: view.buffer.active.viewportY };
    // Show the row for a moment, because a row near the end is not at the top.
    const buffer = view.buffer.active;
    const marker = view.registerMarker(row - buffer.baseY - buffer.cursorY);
    const flash = view.registerDecoration({ marker, width: view.cols });
    flash?.onRender(node => node.classList.add('message-flash'));
    setTimeout(() => { flash?.dispose(); marker.dispose(); }, flashTime);
    this.focus();
    this.render();
  }

  // Give the keyboard focus to the terminal, so that the step keys work. A touch device
  // would open its on-screen keyboard, so it keeps the focus.
  private focus(): void {
    if (matchMedia('(pointer: fine)').matches) this.view?.focus();
  }

  // Show the bar for the message that the view reads.
  private render(): void {
    // A jump target applies only until the view scrolls. A later return to the same
    // position by hand must not make it the current message again.
    if (this.pinned && this.pinned.top !== this.view?.buffer.active.viewportY) this.pinned = null;
    const count = this.marks.length;
    const bar = this.position();
    const mark = this.marks[bar.current];
    let label: string;
    if (mark) label = `Message ${bar.current + 1} of ${count} · ${messageTime(mark.message.created)}`;
    // The view is above the first message, or the terminal shows no sent message.
    else label = count ? `${count} sent ${count === 1 ? 'message' : 'messages'} below` : 'No sent message in this terminal';
    const state = `${this.session}|${count}|${bar.current}|${mark?.message.revision ?? 0}`;
    // Each value that the bar shows is part of this text. An equal text needs no change.
    const shown = `${state}|${label}|${bar.previous}|${bar.next}|${bar.latest}`;
    if (shown === this.shown) return;
    this.shown = shown;
    this.bar.hidden = !this.session;
    this.open.textContent = label;
    this.open.title = mark ? `${sentText(mark.message)}\n\nShow the sent messages.` : 'Show the sent messages.';
    this.previous.disabled = !bar.previous;
    this.next.disabled = !bar.next;
    this.latest.disabled = !bar.latest;
    if (state !== this.reported) {
      this.reported = state;
      this.host.changed();
    }
  }
}
