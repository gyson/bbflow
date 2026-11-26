// The server derives one status for each session: draft, running, idle, or ended.
// A running or idle session is live: it starts or it has a live terminal. Idle means
// only that the screen of the terminal had no recent change. It does not mean that the
// application is ready for input.
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

// Return the icon of a status in the list: running, idle, draft, ended, or failed. A
// failed or interrupted latest run has its own icon.
export function statusIcon(status: string, runStatus = ''): string {
  return status === 'ended' && (runStatus === 'failed' || runStatus === 'interrupted') ? 'failed' : status;
}

const meanings: Record<string, string> = {
  running: 'Running: a screen change in the last 10 seconds',
  idle: 'Idle: live, with no screen change in the last 10 seconds',
  draft: 'Draft: not started',
};

type ListedStatus = { archived?: boolean; viewers?: number; runStatus?: string };

function extras(session: ListedStatus, place: string): string {
  const views = session.viewers ? ` · ${session.viewers} view${session.viewers === 1 ? '' : 's'}` : '';
  return (session.archived ? ' · Archived' : '') + views + (place ? ` · ${place}` : '');
}

// Return the status text of a session in the list. The list shows it when the pointer is
// on the status icon. place tells where a sub-session works.
export function listStatusText(status: string, session: ListedStatus, place = ''): string {
  const text = meanings[status] ?? (status === 'ended' ? `Ended${session.runStatus ? ` · ${session.runStatus}` : ''}` : status);
  return text + extras(session, place);
}

// Return the short status of a session in the list for screen readers.
export function listStatusLabel(status: string, session: ListedStatus, place = ''): string {
  return (statusIcon(status, session.runStatus) === 'failed' ? `ended, ${session.runStatus}` : status) + extras(session, place).replaceAll(' · ', ', ');
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

// The reason that a view saw for the end of one run. The run is empty when the terminal
// failed before its run started.
export interface EndReason { run: string; text: string }

const endedRun = new Set(['exited', 'stopped', 'failed', 'interrupted']);

// Return the reason for the end of a session. The reason that a view saw applies only to
// its own run. After a later run, the session shows the stored status of that run.
export function endReasonText(seen: EndReason | null, latest: { id: string; status: string } | undefined): string {
  if (seen && seen.run === (latest?.id ?? '')) return seen.text;
  return latest && endedRun.has(latest.status) ? latest.status : '';
}

// Return the status text of the session view. An ended session adds the reason for its
// end, for example the status of its latest run or an exit code.
export function statusText(status: string, reason = ''): string {
  if (status === 'ended' && reason) return `Ended · ${reason}`;
  return status.charAt(0).toUpperCase() + status.slice(1);
}

type Member = { title: string; autoTitle?: string; status: string; preparation?: { state: string } };

// Split the sessions of a stop from the sidebar. A session with a live terminal stops. A
// session that creates its worktree has no terminal yet, so it cannot stop.
export function stopMembers<T extends Member>(members: T[]): { stop: T[]; starting: T[] } {
  return {
    stop: members.filter(member => hasTerminal(member)),
    starting: members.filter(member => live(member.status) && !hasTerminal(member)),
  };
}

// Tell whether a stop item of the sidebar shows. members holds the sessions that the item
// can stop. For Stop family, family is true and members holds the top-level session first.
// Stop session shows while its session has a live terminal. Stop family shows while a
// sub-session has a live terminal. Otherwise it stops only what Stop session stops.
export function stopShows(members: Member[], family: boolean): boolean {
  return (family ? members.slice(1) : members).some(member => hasTerminal(member));
}

const title = (member: Member) => member.title || member.autoTitle || 'Untitled session';
const quoted = (member: Member) => `“${title(member)}”`;

function names(members: Member[]): string {
  const all = members.map(quoted);
  return all.length < 3 ? all.join(' and ') : `${all.slice(0, -1).join(', ')}, and ${all.at(-1)}`;
}

// The text of the stop dialog. lines has one line for each session that stops. It is
// empty for Stop session, because the summary names the session. note names the sessions
// that cannot stop, or it is empty.
export interface StopText { title: string; summary: string; lines: string[]; note: string; submit: string }

// Return the text of the stop dialog. family is true for Stop family, which stops the
// sessions in stop, and then session is the top-level session. Otherwise the dialog is for
// Stop session, and stop holds session only.
export function stopText(session: Member, stop: Member[], starting: Member[], family: boolean): StopText {
  if (!family) {
    return { title: 'Stop this session?', summary: `This stops ${quoted(session)}. It is ${session.status}.`, lines: [], note: '', submit: 'Stop session' };
  }
  const count = stop.length === 1 ? '1 session' : `${stop.length} sessions`;
  let note = '';
  if (starting.length === 1) note = `${names(starting)} creates its worktree and has no terminal yet. It does not stop.`;
  else if (starting.length) note = `${names(starting)} create their worktrees and have no terminals yet. They do not stop.`;
  return {
    title: 'Stop this family?',
    summary: `This stops ${count} of the family ${quoted(session)}:`,
    lines: stop.map(member => `${title(member)} · ${statusText(member.status)}`),
    note,
    submit: 'Stop family',
  };
}
