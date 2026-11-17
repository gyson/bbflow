import type { Tool } from './protocol.js';

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

// Prefer the tool that the session started with, if it still exists.
export function defaultContinueTool(tools: readonly Tool[], preferred: string | undefined, fallback: string): string {
  if (preferred !== undefined && (preferred === '' || tools.some(tool => tool.id === preferred))) return preferred;
  return tools.some(tool => tool.id === fallback) ? fallback : '';
}
