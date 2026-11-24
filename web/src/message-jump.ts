import type { SeekResult } from './message-nav.js';
import type { TerminalInfo } from './protocol.js';

// The parts of the page that a jump to another terminal uses. app.ts supplies them.
export interface JumpHost {
  // The selected session, or empty. It is empty while another action runs.
  session(): string;
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
  // Show an error toast for a jump to terminal number.
  failed(number: number, detail: string): void;
}

// MessageJump opens another terminal of the selected session, then scrolls it to a sent
// message. Another view can have started a terminal since this view read the list. Thus
// the jump reads the list again, and it opens the run of the message. An empty run would
// give the latest terminal at the time of the request.
//
// A newer click stops an older one. Another open of the session view, for example from
// the terminal selector, also stops it. Thus an older click cannot act after a newer
// choice of the user.
export class MessageJump {
  private clicks = 0;

  constructor(private readonly host: JumpHost) {}

  async show(revision: number, target: TerminalInfo): Promise<void> {
    const session = this.host.session();
    if (!session) return;
    const click = ++this.clicks;
    const opens = this.host.opens();
    // Stop when a newer click or another open came, or the session changed.
    const stale = () => click !== this.clicks || this.host.session() !== session;
    await this.host.loadTerminals(session);
    if (stale() || this.host.opens() !== opens) return;
    const terminal = this.host.terminals().find(item => !!item.run && item.run === target.run);
    if (!terminal) {
      this.host.failed(target.number, 'The list of the terminals of this session is not available.');
      return;
    }
    this.host.reveal();
    const open = await this.host.open(session, terminal.run);
    if (open === null || click !== this.clicks || this.host.opens() !== open || this.host.shownRun() !== terminal.run) return;
    const result = await this.host.seek(revision);
    if (result === 'missing') {
      this.host.failed(terminal.number, 'The terminal does not show this message. The terminal can have dropped its rows from the scrollback, or the application can show the message in another form.');
    } else if (result === 'failed') {
      this.host.failed(terminal.number, `Cannot read the sent messages: ${this.host.readError()}`);
    }
  }
}
