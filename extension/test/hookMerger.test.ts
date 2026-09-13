import { describe, expect, it } from 'vitest';
import type { ActivityStep, HookEvent, Turn } from '../../shared/activity-schema';
import { mergeHookEvents } from '../src/session/hookMerger';
import { composeTurn } from '../src/session/sessionBuilder';

const step = (id: string, toolName: string, input: Record<string, unknown>): ActivityStep => ({ id, conversationId: 'c', turnIndex: 0, index: Number(id), toolName, category: 'other', input, status: 'running', source: 'transcript' });

describe('mergeHookEvents', () => {
  it('attaches shell output to the matching transcript step', () => {
    const steps = [step('0', 'Shell', { command: 'git status --short' })];
    const turns: Turn[] = [{ index: 0, status: 'active', stepIds: ['0'] }];
    const events: HookEvent[] = [{ ts: new Date().toISOString(), hook: 'afterShellExecution', conversationId: 'c', command: 'git status --short', output: ' M a.ts', durationMs: 40 }];
    const { steps: merged } = mergeHookEvents('c', steps, turns, events);
    expect(merged[0].output).toBe(' M a.ts');
    expect(merged[0].status).toBe('done');
    expect(merged[0].source).toBe('hook');
  });

  it('creates hook-only steps when the transcript has not caught up and marks failures', () => {
    const turns: Turn[] = [{ index: 0, status: 'active', stepIds: [] }];
    const events: HookEvent[] = [
      { ts: new Date().toISOString(), hook: 'postToolUseFailure', conversationId: 'c', toolName: 'Shell', toolInput: { command: 'npm test' }, errorMessage: 'timeout', status: 'timeout' },
      { ts: new Date().toISOString(), hook: 'stop', conversationId: 'c', status: 'completed' },
    ];
    const { steps, turns: t } = mergeHookEvents('c', [], turns, events);
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe('error');
    expect(steps[0].errorMessage).toBe('timeout');
    expect(t[0].status).toBe('success');
  });

  it('fills user requests from beforeSubmitPrompt', () => {
    const turns: Turn[] = [{ index: 0, status: 'active', stepIds: [] }];
    const { turns: t } = mergeHookEvents('c', [], turns, [{ ts: new Date().toISOString(), hook: 'beforeSubmitPrompt', conversationId: 'c', prompt: 'fix the hero' }]);
    expect(t[0].userRequest).toBe('fix the hero');
  });
});

describe('composeTurn', () => {
  it('writes a readable one-liner', () => {
    const mk = (category: ActivityStep['category'], input: Record<string, unknown> = {}) => ({ ...step('0', 'x', input), category, explanation: { title: '', summary: '', whatHappened: '', technical: '', vocabulary: [], templateId: '', confidence: 1 }, conceptIds: [] });
    const text = composeTurn([mk('searching'), mk('editing', { path: 'a' }), mk('editing', { path: 'b' }), mk('saving', { command: 'git commit && git push' })]);
    expect(text).toBe('Searched the project, edited 2 files, and saved a checkpoint and uploaded it.');
  });
});
