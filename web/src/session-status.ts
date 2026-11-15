// The server derives one status for each session: draft, running, idle, or ended.
// A running or idle session is live: it starts or it has a live terminal. Idle means
// only that the terminal had no recent output. It does not mean that the application is
// ready for input.
export function live(status: string | undefined): boolean {
  return status === 'running' || status === 'idle';
}

// A session that creates its worktree shows running, but it has no terminal yet.
export function hasTerminal(session: { status: string; preparation?: { state: string } } | null | undefined): boolean {
  return live(session?.status) && session?.preparation?.state !== 'creating';
}

// Return the status that the session list shows. The status watch pushes the statuses
// of the live terminals. A pushed status is newer than the status in the list.
export function listStatus(session: { id: string; status: string }, pushed: Record<string, string>): string {
  return pushed[session.id] ?? session.status;
}

// Report whether a pushed set of statuses has a different set of live terminals.
export function terminalsChanged(before: Record<string, string>, after: Record<string, string>): boolean {
  const ids = Object.keys(after);
  return ids.length !== Object.keys(before).length || ids.some(id => !(id in before));
}

// Return the reason that an exit message gives for the end of a terminal. A normal exit
// shows its code. Other ends show the recorded run status, for example stopped.
export function exitReason(code = 0, status = ''): string {
  return status && status !== 'exited' ? status : `exit ${code}`;
}

// Return the status text of the session view. An ended session adds the reason for its
// end, for example the status of its latest run or an exit code.
export function statusText(status: string, reason = ''): string {
  if (status === 'ended' && reason) return `Ended · ${reason}`;
  return status.charAt(0).toUpperCase() + status.slice(1);
}
