import type { ServerInfo } from './protocol.js';

// A restart or an update starts a new server for the same instance directory, usually on
// the same port. The new server has a new instance ID and can use a newer protocol. This
// page cannot use it, so the page reloads to get the UI of the new server.

// A reload sooner than this after an automatic reload can be a loop. Then the page waits
// for the user.
export const reloadInterval = 10000;
const reloadKey = 'bbflow-automatic-reload';

// Each failed request and the page show this text after a replacement. A page with
// edits that were not saved stays open with it.
export const restartedMessage = 'bbflow restarted. Copy any edits that were not saved, then reload this page.';

let replaced: (() => void) | undefined;

// The greeting of a different server for the same instance directory shows a restart.
// A server for a different directory is not a replacement.
export function replaces(current: ServerInfo, next: Partial<ServerInfo> | undefined): boolean {
  return !!next && next.dataDir === current.dataDir &&
    (next.instance !== current.instance || next.protocol !== current.protocol || next.port !== current.port);
}

// The page sets one handler. Other users of the protocol, such as tests, set none.
export function onServerReplaced(handler: () => void): void { replaced = handler; }

export function serverReplaced(): void { replaced?.(); }

export type ReloadPlan = 'reload' | 'unsaved' | 'repeated';

// Never reload over edits that the old server did not save. The new page cannot recover
// them.
export function reloadPlan(unsaved: boolean, lastReload: number, now: number): ReloadPlan {
  if (unsaved) return 'unsaved';
  if (now >= lastReload && now - lastReload < reloadInterval) return 'repeated';
  return 'reload';
}

// Session storage keeps the time across the reload of this tab only. Storage can be
// unavailable. Then the page reloads without the loop check.
export function lastReload(): number {
  try { return Number(sessionStorage.getItem(reloadKey)) || 0; } catch { return 0; }
}

export function recordReload(now: number): void {
  try { sessionStorage.setItem(reloadKey, String(now)); } catch { /* The loop check is optional. */ }
}
