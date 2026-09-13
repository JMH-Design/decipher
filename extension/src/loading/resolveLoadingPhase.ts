import type { LoadingPhase, Turn } from '../../../shared/activity-schema';

export interface PendingWork {
  /** A recent finished turn still needs an LLM recap. */
  llm: boolean;
  /** Tool suggestions for the finished turn have not been computed yet. */
  research: boolean;
}

/**
 * Decides how long the loader stays up. Kept free of `vscode` and of `SessionBuilder` so the
 * rule can be read and tested on its own — it is the only place that answers "is the panel
 * ready to be seen?".
 *
 * The agent's turn comes first: while it is still running the timeline is growing under the
 * loader, and revealing it would show a panel that changes as the user reads it.
 */
export function resolveLoadingPhase(turns: Turn[], pending: PendingWork): LoadingPhase {
  const last = turns[turns.length - 1];
  if (last?.status === 'active') return 'working';
  if (pending.research) return 'research';
  if (pending.llm) return 'parsing';
  return 'ready';
}
