import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { call, encodeBytes, errorMessage } from './protocol.js';
import type { ServerInfo, Size } from './protocol.js';
import { SessionConnection } from './session-connection.js';
import { element } from './dom.js';

function boundedSize(value: { rows: number; cols: number }): Size {
  return { rows: Math.max(1, Math.min(256, value.rows)), cols: Math.max(2, Math.min(512, value.cols)) };
}

// SideTerminal is the Terminal view of the workspace pane. It shows an interactive
// shell in the workspace of the selected session, for ad hoc commands. The server owns
// the shell and does not record it. A hidden view keeps its connection until the page
// selects another session.
export class SideTerminal {
  private readonly screen = element('side-screen', HTMLElement);
  private readonly status = element('side-status', HTMLElement);
  private readonly dimensions = element('side-dimensions', HTMLElement);
  private readonly startButton = element('side-start', HTMLButtonElement);
  private readonly stopButton = element('side-stop', HTMLButtonElement);

  private session = '';
  private isOpen = false;
  private live = false;
  private pending = false; // A request waits for its session message.
  private shell = ''; // The ID of the shown shell. Stop and reconnection use only this shell.
  private view: Terminal | null = null;
  private fit: FitAddon | null = null;
  private connection: SessionConnection | null = null;

  constructor(private readonly server: () => ServerInfo | null, private readonly theme: () => ITheme) {
    this.startButton.onclick = () => this.connect(true);
    this.stopButton.onclick = () => void this.stop();
    new ResizeObserver(() => this.requestFit()).observe(this.screen);
    window.addEventListener('pagehide', () => this.connection?.close());
    this.show();
  }

  // Select the session of this view. An empty session, for a draft, Settings, or the
  // home page, has no terminal. A shown view joins the shell of the new session. It does
  // not start a shell.
  select(session: string): void {
    if (session === this.session) return;
    this.session = session;
    this.disconnect();
    this.setStatus(session ? 'No shell runs in this session.' : '');
    this.show();
    if (this.isOpen && session) this.connect(false);
  }

  // The workspace pane shows or hides this view. With start, a click of the user showed
  // the view. Then the server starts a shell when the session has none.
  setShown(shown: boolean, start: boolean): void {
    this.isOpen = shown;
    if (!shown || !this.session) return;
    if (!this.connection) this.connect(start);
    else if (start) this.view?.focus();
  }

  updateTheme(): void {
    if (this.view) this.view.options.theme = this.theme();
  }

  private show(): void {
    this.startButton.hidden = !this.session || this.live || this.pending;
    this.stopButton.hidden = !this.live;
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
  }

  // With start, the server starts a shell when the session has none. Without start, the
  // view only joins a live shell.
  private connect(start: boolean): void {
    const server = this.server();
    if (!server || !this.session || !this.isOpen) return;
    this.disconnect();
    const view = this.makeTerminal();
    const session = this.session;
    this.pending = true;
    // Only the click of the user moves the focus, once. A reconnection keeps the focus.
    let focus = start;
    this.setStatus(start ? 'Starting shell…' : 'Connecting…');
    const connection = this.connection = new SessionConnection(server, view, {
      operation: start ? 'side-terminal-open' : 'side-terminal-resume', session, size: boundedSize(view),
    }, {
      size: () => boundedSize(view),
      ready: () => {
        if (this.connection !== connection) return;
        view.options.disableStdin = !connection.peer?.active;
        this.requestFit();
        this.show();
      },
      message: message => {
        if (this.connection !== connection) return;
        switch (message.type) {
          case 'session': {
            this.pending = false;
            // A reconnection that finds no live shell with this ID shows that the shell ended.
            const ended = !message.active && !!this.shell;
            this.live = !!message.active;
            if (message.shell) this.shell = message.shell;
            this.setStatus(this.live ? 'Not recorded. Runs in the session workspace.' : ended ? 'The shell ended.' : 'No shell runs in this session.');
            if (this.live && focus) view.focus();
            focus = false;
            break;
          }
          case 'exit':
            this.live = false;
            view.options.disableStdin = true;
            this.setStatus(`Shell ended with exit code ${message.code ?? 'unknown'}.`);
            if (message.error) this.setStatus(`Shell ended: ${message.error}`);
            break;
        }
        this.show();
      },
      disconnected: (error, retrying) => {
        if (this.connection !== connection) return;
        view.options.disableStdin = true;
        if (!retrying) this.live = this.pending = false;
        this.setStatus(retrying ? 'Connection lost. Reconnecting…' : errorMessage(error));
        this.show();
      },
    });
    connection.connect().catch(() => {});
    this.show();
  }

  private disconnect(): void {
    this.connection?.close();
    this.connection = null;
    this.live = this.pending = false;
    this.shell = '';
    this.view?.dispose();
    this.view = this.fit = null;
    this.screen.replaceChildren();
    this.dimensions.textContent = '';
  }

  private async stop(): Promise<void> {
    const server = this.server();
    if (!server || !this.session || !this.shell) return;
    this.stopButton.disabled = true;
    try {
      const connection = this.connection;
      const { stopped } = await call(server, { operation: 'side-terminal-stop', session: this.session, shell: this.shell });
      // Another view can replace an ended shell. This view does not stop the new shell.
      if (!stopped && this.connection === connection) {
        this.live = false;
        this.setStatus('The shell ended.');
        this.show();
      }
    } catch (error) {
      this.setStatus(`Cannot stop the shell: ${errorMessage(error)}`);
    } finally {
      this.stopButton.disabled = false;
    }
  }

  private makeTerminal(): Terminal {
    const view = this.view = new Terminal({
      cursorBlink: true, fontSize: 12, lineHeight: 1.2, scrollback: 10000,
      fontFamily: 'Menlo, Monaco, Consolas, monospace', disableStdin: true, screenReaderMode: true,
      theme: this.theme(),
      // Terminal output must not open links, read the browser clipboard, or write to it.
      linkHandler: { activate() {} },
    });
    const fit = this.fit = new FitAddon();
    view.loadAddon(fit);
    const host = document.createElement('div');
    host.className = 'terminal-host';
    this.screen.replaceChildren(host);
    view.open(host);
    fit.fit();
    this.dimensions.textContent = `${view.cols} × ${view.rows}`;
    view.onResize(({ rows, cols }) => { this.dimensions.textContent = `${cols} × ${rows}`; });
    view.onData(data => {
      const peer = this.connection?.ready ? this.connection.peer : null;
      if (!peer?.active) return;
      const bytes = new TextEncoder().encode(data);
      for (let start = 0; start < bytes.length; start += 16384) {
        if (!peer.send({ type: 'input', data: encodeBytes(bytes.subarray(start, start + 16384)) })) break;
      }
    });
    view.onBinary(data => {
      const peer = this.connection?.ready ? this.connection.peer : null;
      if (peer?.active) peer.send({ type: 'input', data: btoa(data) });
    });
    return view;
  }

  // The server sets the terminal size in its frames. Send the size that fits the panel.
  private requestFit(): void {
    const connection = this.connection;
    const view = this.view;
    if (!view || !connection?.ready || !connection.peer?.active || connection.resizing) return;
    // A hidden view has no size. Keep the PTY size until the view shows again.
    if (!this.screen.clientWidth || !this.screen.clientHeight) return;
    const proposed = this.fit?.proposeDimensions();
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
    const size = boundedSize(proposed);
    if (size.cols !== view.cols || size.rows !== view.rows) {
      connection.peer.send({ type: 'resize', size });
    }
  }
}
