import { ConnectionError, Peer } from './protocol.js';
import type { ServerInfo, ServerMessage, WatchRequest } from './protocol.js';

// A watch keeps one stream of pushed messages open. It reconnects after transport
// failures, and the server then sends its latest state again. The watch stops after
// closure or after an identity or protocol error.
export class Watch {
  private peer: Peer | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;

  constructor(
    private readonly server: ServerInfo,
    private readonly request: WatchRequest,
    private readonly host: {
      message(message: ServerMessage): void;
      failed(error: Error, retrying: boolean): void;
    },
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const peer = this.peer = new Peer(this.server, this.request, {
      message: message => {
        if (this.closed || this.peer !== peer) return;
        this.attempt = 0;
        this.host.message(message);
      },
      error: error => {
        if (this.closed || this.peer !== peer) return;
        const retrying = error instanceof ConnectionError && error.retryable;
        if (retrying) {
          const delay = Math.min(30000, 500 * 2 ** Math.min(this.attempt++, 6));
          this.timer = setTimeout(() => this.connect(), delay);
        }
        this.host.failed(error, retrying);
      },
    });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.peer?.close();
  }
}
