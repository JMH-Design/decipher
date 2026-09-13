import type { ActivityStep, Explanation } from '../../../shared/activity-schema';
import type { GlossaryService } from '../glossary/glossaryService';

export interface TemplateContext {
  step: ActivityStep;
  toolName: string;
  input: Record<string, unknown>;
  /** Raw output captured by hooks, if any. */
  output?: string;
  /** Parsed `{exitCode, stdout, stderr}` when the output is Cursor's JSON envelope. */
  shellResult?: ShellResult;
  workspaceRoot?: string;
  glossary: GlossaryService;
  /** The user's request for this turn (for relevance wording). */
  userRequest?: string;
}

export interface ShellResult {
  exitCode?: number;
  stdout: string;
  stderr?: string;
}

export interface ShellContext extends TemplateContext {
  segment: string;
  program: string;
  args: string[];
  /** Pipeline stages after the first program. */
  filters: string[];
  /** Positional args (no leading dash). */
  positional: string[];
  has(flag: string | RegExp): boolean;
}

export interface Template<C extends TemplateContext = TemplateContext> {
  id: string;
  /** Return 0 for no match; higher wins. Typical: 1 exact, 0.6 partial. */
  match(ctx: C): number;
  explain(ctx: C): Explanation;
}

export function makeExplanation(partial: Partial<Explanation> & Pick<Explanation, 'title' | 'summary' | 'templateId'>): Explanation {
  return {
    whatHappened: partial.summary,
    technical: '',
    vocabulary: [],
    confidence: 0.9,
    ...partial,
  };
}
