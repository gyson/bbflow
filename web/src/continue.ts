import type { Tool } from './protocol.js';
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

// Prefer the tool that the session started with, if it still exists.
export function defaultContinueTool(tools: readonly Tool[], preferred: string | undefined, fallback: string): string {
  if (preferred !== undefined && (preferred === '' || tools.some(tool => tool.id === preferred))) return preferred;
  return tools.some(tool => tool.id === fallback) ? fallback : '';
}
