import type { Update } from './protocol.js';
import { restartedMessage } from './restart.js';

export interface PageBar { kind: '' | 'info' | 'warning'; text: string; reload: boolean }

// The page bar shows one state of the whole page. A restart of the server replaces an
// update in progress. The status watch sends the update state to each view. Thus the bar
// does not depend on the order of the start reply and the status messages.
export function pageBar(restarted: boolean, update: Update | undefined): PageBar {
  if (restarted) return { kind: 'warning', text: restartedMessage, reload: true };
  if (update?.state === 'updating') {
    return { kind: 'info', text: `bbflow updates to ${update.available}. This page reloads when the new server starts.`, reload: false };
  }
  return { kind: '', text: '', reload: false };
}
