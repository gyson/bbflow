import type { ComposerState, ServerInfo } from './protocol.js';
import { Watch } from './watch.js';

// One watch follows the saved draft of one session. The server sends the latest draft
// first and then each newer saved draft.
export class DraftWatch {
  private readonly watch: Watch;

  constructor(
    server: ServerInfo,
    session: string,
    host: {
      draft(state: ComposerState): void;
      failed(error: Error, retrying: boolean): void;
    },
  ) {
    this.watch = new Watch(server, { operation: 'composer-watch', session }, {
      message: message => {
        if (message.type === 'draft' && message.session === session) host.draft(message.composer);
      },
      failed: (error, retrying) => host.failed(error, retrying),
    });
  }

  close(): void {
    this.watch.close();
  }
}
