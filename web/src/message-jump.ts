import type { SeekResult } from './message-nav.js';
import type { TerminalInfo } from './protocol.js';

// The parts of the page that a jump to another terminal uses. app.ts supplies them.
export interface JumpHost {
  // The selected session, or empty.
  session(): string;
  // Whether an action of the page runs, other than the open of a jump.
  busy(): boolean;
  // The number of opens of a session view. Each open adds one.
  opens(): number;
  // Read the terminal list of the session again. A failed read keeps the known list.
  loadTerminals(session: string): Promise<void>;
  // The terminals of the selected session in start order.
  terminals(): readonly TerminalInfo[];
  // The run of the terminal that the session view shows, or empty.
  shownRun(): string;
  // Show the session in place of the workspace pane, when the pane covers it.
  reveal(): void;
  // Open a run of the session. Resolve with the number of that open, or null when the
  // open did not occur or failed.
  open(session: string, run: string): Promise<number | null>;
  // Scroll the shown terminal to a message when the view finds it. See MessageNav.seek.
  seek(revision: number): Promise<SeekResult>;
  // The error of the last read of sent messages.
  readError(): string;
  // Show an error toast for a jump to terminal number, or to the shown terminal when the
  // number is unknown.
  failed(number: number | undefined, detail: string): void;
}

// MessageJump opens another terminal of the selected session, then scrolls it to a sent
// message. Another view can have started a terminal since this view read the list. Thus
// the jump reads the list again, and it opens the run of the message. An empty run would
// give the latest terminal at the time of the request.
//
// A newer click stops an older one, also a click during the open of the older click. The
// newer click waits until that open ends. A move in the shown terminal also stops an
// older click: a jump there, a step, or Latest output. See cancel. Another open of the
// session view, for example from the terminal selector, also stops it. Thus an older
// click cannot act after a newer choice of the user.
export class MessageJump {
  private clicks = 0;
  private opening: Promise<unknown> = Promise.resolve(); // The open of the last click.

  constructor(private readonly host: JumpHost) {}

  // Stop each click that did not seek yet. Call it when the user moves the shown
  // terminal to a message or to the latest output.
  cancel(): void { this.clicks++; }

  // Read the sent messages of the shown terminal again after a failed read, then scroll
  // to a message. A click on a message of the shown terminal uses it.
  async retry(revision: number): Promise<void> {
    const run = this.host.shownRun();
    const number = this.host.terminals().find(item => !!item.run && item.run === run)?.number;
    this.report(await this.host.seek(revision), number);
  }

  async show(revision: number, target: TerminalInfo): Promise<void> {
    const click = ++this.clicks;
    const session = this.host.session();
    if (!session) return;
    const opens = this.host.opens();
    // Stop when a newer click, a move, or another open came, or the session changed.
    const stale = () => click !== this.clicks || this.host.session() !== session;
    await this.host.loadTerminals(session);
    // The open of an older click can still run. Wait for it, so that the page does not
    // refuse this open. The older click then stops before its seek.
    await this.opening;
    if (stale() || this.host.opens() !== opens || this.host.busy()) return;
    const terminal = this.host.terminals().find(item => !!item.run && item.run === target.run);
    if (!terminal) {
      this.host.failed(target.number, 'The list of the terminals of this session is not available.');
      return;
    }
    this.host.reveal();
    const opening = this.opening = this.host.open(session, terminal.run);
    const open = await opening;
    if (open === null || click !== this.clicks || this.host.opens() !== open || this.host.shownRun() !== terminal.run) return;
    this.report(await this.host.seek(revision), terminal.number);
  }

  private report(result: SeekResult, number: number | undefined): void {
    if (result === 'missing') {
      this.host.failed(number, 'The terminal does not show this message. The terminal can have dropped its rows from the scrollback, or the application can show the message in another form.');
    } else if (result === 'failed') {
      this.host.failed(number, `Cannot read the sent messages: ${this.host.readError()}`);
    }
  }
}
