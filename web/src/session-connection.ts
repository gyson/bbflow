import type { Terminal } from '@xterm/xterm';
import { ConnectionError, Peer, retryLimit } from './protocol.js';
import type { ServerInfo, ServerMessage, Size, StreamRequest } from './protocol.js';
import { TerminalStream } from './terminal-stream.js';

const rejoins = (request: StreamRequest) => request.operation === 'session-resume' || request.operation === 'side-terminal-resume';

// After the ID is known, retries can only rejoin that session. A view of an earlier
// terminal keeps showing that terminal. A side terminal retry never starts a new shell.
// It rejoins only the shell that it showed, not a later shell of the session.
function rejoin(request: StreamRequest, message: { session: string; shell?: string }, size: Size): StreamRequest {
  const session = message.session;
  if (request.operation === 'side-terminal-open' || request.operation === 'side-terminal-resume') {
    const shell = message.shell ?? (request.operation === 'side-terminal-resume' ? request.shell : undefined);
    return { operation: 'side-terminal-resume', session, size, ...(shell ? { shell } : {}) };
  }
  const run = request.operation === 'session-resume' ? request.run : undefined;
  return { operation: 'session-resume', session, size, ...(run ? { run } : {}) };
}

// One selected session owns its connection, frame baseline, and reconnect timer. When
// it closes, it cancels retries and ignores callbacks from the old view.
export class SessionConnection {
  peer: Peer | null = null;
  ready = false;
  private stream: TerminalStream | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;

  constructor(
    private readonly server: ServerInfo,
    private readonly view: Pick<Terminal, 'write' | 'resize' | 'reset'>,
    private request: StreamRequest,
    private readonly host: {
      size(): Size;
      message(message: ServerMessage): void;
      ready(): void;
      disconnected(error: Error, retrying: boolean): void;
    },
  ) {}

  get resizing(): boolean { return this.stream?.resizing ?? false; }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Session view is closed.'));
    clearTimeout(this.timer);
    this.stream?.stop();
    this.peer?.close();
    this.ready = false;
    if (rejoins(this.request)) this.request = { ...this.request, size: this.host.size() };
    return new Promise<void>((resolve, reject) => {
      const stream = this.stream = new TerminalStream(this.view, {
        current: () => !this.closed && this.peer === peer,
        acknowledge: revision => peer.acknowledgeFrame(revision),
        ready: () => {
          this.ready = true;
          this.attempt = 0;
          this.host.ready();
        },
        fail: message => peer.fail(message),
      });
      const peer = this.peer = new Peer(this.server, this.request, {
        message: message => {
          if (this.closed || this.peer !== peer) return;
          if (message.type === 'session') {
            this.request = rejoin(this.request, message, this.host.size());
            resolve();
          }
          stream.push(message);
          this.host.message(message);
        },
        error: error => {
          reject(error);
          if (this.closed || this.peer !== peer) return;
          stream.stop();
          this.ready = false;
          const retrying = error instanceof ConnectionError && error.retryable && rejoins(this.request);
          if (retrying) {
            const delay = Math.min(retryLimit, 500 * 2 ** Math.min(this.attempt++, 6));
            this.timer = setTimeout(() => { this.connect().catch(() => {}); }, delay);
          }
          this.host.disconnected(error, retrying);
        },
      });
    });
  }

  close(): void {
    this.closed = true;
    this.ready = false;
    clearTimeout(this.timer);
    this.stream?.stop();
    this.peer?.close();
  }
}
