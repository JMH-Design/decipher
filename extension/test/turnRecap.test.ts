import { describe, expect, it } from 'vitest';
import type { ActivityStep, ExplainedStep, StepCategory, Turn, TurnStatus } from '../../shared/activity-schema';
import { LlmSummarizer, MAX_RECAP_CHARS, type LlmProvider } from '../src/explainer/llmSummarizer';
import { composeTurnRecap } from '../src/session/sessionBuilder';

function step(category: StepCategory, input: Record<string, unknown> = {}, status: ActivityStep['status'] = 'done'): ExplainedStep {
  return {
    id: '0',
    conversationId: 'c',
    turnIndex: 0,
    index: 0,
    toolName: 'x',
    category,
    input,
    status,
    source: 'transcript',
    explanation: { title: '', summary: '', whatHappened: '', technical: '', vocabulary: [], templateId: '', confidence: 1 },
    conceptIds: [],
  };
}

const turn = (status: TurnStatus = 'success', finalResponse?: string): Turn => ({ index: 0, status, stepIds: [], finalResponse });

describe('composeTurnRecap', () => {
  it('names the files that changed', () => {
    const recap = composeTurnRecap(turn(), [step('editing', { path: '/p/src/hero.ts' }), step('editing', { path: '/p/src/App.tsx' })]);
    expect(recap).toContain('It changed hero.ts and App.tsx.');
  });

  it('counts the overflow rather than listing every file', () => {
    const steps = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => step('editing', { path: `/p/${n}.ts` }));
    expect(composeTurnRecap(turn(), steps)).toContain('and 2 more files');
  });

  it('says nothing changed only when the turn could not have changed anything', () => {
    expect(composeTurnRecap(turn(), [step('reading'), step('searching')])).toContain('only looked around');
    // A command may well have changed something we cannot see, so we must not promise otherwise.
    expect(composeTurnRecap(turn(), [step('running', { command: 'npm test' })])).not.toContain('only looked around');
  });

  it('leads with the problem when the turn failed or was stopped', () => {
    expect(composeTurnRecap(turn('error'), [step('editing', { path: 'a.ts' })])).toMatch(/^Something went wrong/);
    expect(composeTurnRecap(turn('aborted'), [step('editing', { path: 'a.ts' })])).toMatch(/^The turn was stopped early/);
  });

  it('mentions steps that failed inside an otherwise successful turn', () => {
    expect(composeTurnRecap(turn(), [step('running', {}, 'error')])).toContain('One step failed');
    expect(composeTurnRecap(turn(), [step('running', {}, 'error'), step('running', {}, 'error')])).toContain('2 steps failed');
  });

  it('quotes one sentence of the agent’s closing note', () => {
    const recap = composeTurnRecap(turn('success', 'Fixed the loader. It now waits for the turn to finish.'), [step('editing', { path: 'a.ts' })]);
    expect(recap).toContain('It finished by telling you: “Fixed the loader.”');
  });

  it('explains a turn that took no actions', () => {
    expect(composeTurnRecap(turn('success', 'The file lives in src/app.'), [])).toContain('without touching your project');
    expect(composeTurnRecap(turn(), [])).toBe('The agent took no actions, so nothing in your project changed.');
  });
});

function summarizer(reply: string | undefined, over: { enabled?: boolean; alwaysExplainInDepth?: boolean } = {}) {
  const provider: LlmProvider = {
    available: async () => true,
    complete: async () => reply,
  };
  return new LlmSummarizer(provider, { enabled: over.enabled ?? true, alwaysExplainInDepth: over.alwaysExplainInDepth ?? false });
}

describe('LlmSummarizer recaps', () => {
  const input = (over: Partial<{ steps: ExplainedStep[]; turnStatus: TurnStatus }> = {}) => ({
    userRequest: 'make the loader wait',
    steps: over.steps ?? [step('editing', { path: 'a.ts' })],
    turnStatus: over.turnStatus ?? ('success' as TurnStatus),
  });

  it('recaps every finished turn that did something, not just complex ones', () => {
    expect(summarizer('ok').shouldSummarize(input())).toBe(true);
  });

  it('waits for the turn to finish', () => {
    expect(summarizer('ok').shouldSummarize(input({ turnStatus: 'active' }))).toBe(false);
  });

  it('skips turns with no steps unless the user asked for every turn in depth', () => {
    expect(summarizer('ok').shouldSummarize(input({ steps: [] }))).toBe(false);
    expect(summarizer('ok', { alwaysExplainInDepth: true }).shouldSummarize(input({ steps: [] }))).toBe(true);
    expect(summarizer('ok', { enabled: false }).shouldSummarize(input())).toBe(false);
  });

  it('accepts a paragraph-length recap but rejects a runaway one', async () => {
    const paragraph = 'The agent read the loader code and changed when it clears. '.repeat(4).trim();
    expect(paragraph.length).toBeLessThanOrEqual(MAX_RECAP_CHARS);
    await expect(summarizer(paragraph).summarizeTurn('c', 0, input())).resolves.toBe(paragraph);
    await expect(summarizer('x'.repeat(MAX_RECAP_CHARS + 1)).summarizeTurn('c', 0, input())).resolves.toBeUndefined();
  });
});
