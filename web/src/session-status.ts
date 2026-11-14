// The server derives one status for each session: draft, running, idle, or ended.
// Running and idle sessions have a live terminal. Idle means only that the terminal had
// no recent output. It does not mean that the application is ready for input.
export function live(status: string | undefined): boolean {
  return status === 'running' || status === 'idle';
}

// Return the status text of the session view. An ended session adds the reason for its
// end, for example the status of its latest run or an exit code.
export function statusText(status: string, reason = ''): string {
  if (status === 'ended' && reason) return `Ended · ${reason}`;
  return status.charAt(0).toUpperCase() + status.slice(1);
}
