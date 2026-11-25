import { restartedMessage } from './restart.js';

export interface ContinueTarget { status: string; archived?: boolean; run?: { id: string }; worktree?: { state: string } }
interface ContinueAction { visible: boolean; problem: string }

// An empty run selects the latest terminal.
export function continueAction(session: ContinueTarget | null, live: boolean, shownRun = ''): ContinueAction {
  if (shownRun || !session?.run || session.archived || live || session.status !== 'ended') return { visible: false, problem: '' };
  if (session.worktree?.state === 'removed') return { visible: true, problem: 'Worktree removed. A new terminal cannot start here.' };
  if (session.worktree && session.worktree.state !== 'ready') return { visible: true, problem: 'Worktree unavailable. A new terminal cannot start here.' };
  return { visible: true, problem: '' };
}

export function continueDialogProblem(action: ContinueAction, run: string | undefined, openedRun = run): string {
  if (action.problem) return action.problem;
  if (!action.visible || run !== openedRun) return 'This session changed. Open Continue in new terminal again when it is available.';
  return '';
}

export interface DialogError { text: string; hidden: boolean }

// Return the error line and the start state of the open Continue dialog. A restart of
// the server comes first, because this page must reload before it can start a terminal.
// Otherwise a session change shows its reason and blocks the start. When continuation is
// available again, that reason goes. Another error, such as a failed copy, stays. shown
// is the session change reason that the dialog shows now, or empty.
export function continueDialogError(error: DialogError, shown: string, problem: string, restarted: boolean): { error: DialogError; shown: string; blocked: boolean } {
  if (restarted) return { error: { text: restartedMessage, hidden: false }, shown: '', blocked: true };
  if (problem) return { error: { text: problem, hidden: false }, shown: problem, blocked: true };
  if (shown && error.text === shown) return { error: { text: shown, hidden: true }, shown: '', blocked: false };
  return { error, shown: '', blocked: false };
}

// Return the first preferred tool that is still a choice. The view prefers the tool of
// the latest terminal, then the tool that the session started with, then the default
// tool. An undefined ID is unknown. tools are the tools that are on, in the order of the
// menu. shell tells that Shell, the empty ID, is on. Without a choice, the first tool is
// the answer.
export function defaultContinueTool(tools: readonly { id: string }[], preferred: readonly (string | undefined)[], shell = true): string {
  const choice = (id: string | undefined) => id !== undefined && (id === '' ? shell : tools.some(tool => tool.id === id));
  const found = preferred.find(choice);
  if (found !== undefined) return found;
  return shell ? '' : tools[0]?.id ?? '';
}
