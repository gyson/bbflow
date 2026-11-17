import type { Tool } from './protocol.js';

export interface ContinueTarget { status: string; archived?: boolean; run?: { id: string }; worktree?: { state: string } }

// An empty run selects the latest terminal.
export function continueAction(session: ContinueTarget | null, live: boolean, shownRun = ''): { visible: boolean; problem: string } {
  if (shownRun || !session?.run || session.archived || live || session.status !== 'ended') return { visible: false, problem: '' };
  if (session.worktree?.state === 'removed') return { visible: true, problem: 'Worktree removed. A new terminal cannot start here.' };
  if (session.worktree && session.worktree.state !== 'ready') return { visible: true, problem: 'Worktree unavailable. A new terminal cannot start here.' };
  return { visible: true, problem: '' };
}

// Prefer the tool that the session started with, if it still exists.
export function defaultContinueTool(tools: readonly Tool[], preferred: string | undefined, fallback: string): string {
  if (preferred !== undefined && (preferred === '' || tools.some(tool => tool.id === preferred))) return preferred;
  return tools.some(tool => tool.id === fallback) ? fallback : '';
}

// Explain what Start submits to the new shell. bbflow never sends the prompt on its own
// without a continue command, because it cannot detect when an agent is ready.
export function continueHint(tool: Tool | undefined): string {
  if (!tool) return 'Shell starts an interactive shell and submits no command. Start an agent, then send the prompt when it is ready. Handoff prompt in the message editor shows it again.';
  if (tool.continueCommand) return `bbflow submits “${tool.continueCommand}” once, with the quoted prompt below in place of {prompt}.`;
  return `${tool.name || 'This tool'} has no continue command, so bbflow submits “${tool.command}” and does not send the prompt. When the agent is ready, send the prompt. Handoff prompt in the message editor shows it again. To send it automatically, add a continue command in Settings.`;
}
