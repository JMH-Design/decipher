import { describe, expect, it } from 'vitest';
import type { HookEvent, Turn, TurnStatus } from '../../shared/activity-schema';
import { agentModelFromEvents } from '../src/loading/agentModel';
import { GENERIC_NOUNS, VERBS, loadingPhrase, nounsForModel, renderPhrase } from '../src/loading/loadingPhrases';
import { initialOverlayVisibility, nextOverlayVisibility } from '../src/loading/overlayVisibility';
import { resolveLoadingPhase } from '../src/loading/resolveLoadingPhase';
import { parseTranscript } from '../src/parser/transcriptParser';

const event = (over: Partial<HookEvent>): HookEvent => ({ ts: '2026-09-13T00:00:00Z', hook: 'sessionStart', conversationId: 'c', ...over });
const turns = (...statuses: TurnStatus[]): Turn[] => statuses.map((status, index) => ({ index, status, stepIds: [] }));
const nothingPending = { llm: false, research: false };

describe('loading phrases', () => {
  it('reads as "Verb the noun" and stays grammatical for possessive nouns', () => {
    expect(renderPhrase('Illuminating', { text: 'black box', article: true })).toBe('Illuminating the black box…');
    expect(renderPhrase('Illuminating', { text: "Claude's inner monologue", article: false })).toBe("Illuminating Claude's inner monologue…");
  });

  it('always builds a phrase from the pools, whatever the random source', () => {
    for (const r of [() => 0, () => 0.5, () => 0.999999]) {
      const phrase = loadingPhrase(undefined, r);
      expect(VERBS.some((v) => phrase.startsWith(v)), phrase).toBe(true);
      expect(phrase.endsWith('…')).toBe(true);
    }
  });

  it('mixes in model-specific jokes when the model is known', () => {
    expect(nounsForModel('claude-4.5-sonnet-thinking').some((n) => /Claude|Anthropic/.test(n.text))).toBe(true);
    expect(nounsForModel('gpt-5.5-medium').some((n) => /GPT|OpenAI/.test(n.text))).toBe(true);
    expect(nounsForModel('composer-2.5-fast').some((n) => /Composer|Cursor/.test(n.text))).toBe(true);
    expect(nounsForModel('cursor-grok-4.6-high-fast').some((n) => /Grok/.test(n.text))).toBe(true);
    // The generic pool is always still available, so phrases keep varying.
    for (const model of ['claude-4.5-sonnet', 'gpt-5.5', undefined]) expect(nounsForModel(model).length).toBeGreaterThan(GENERIC_NOUNS.length - 1);
  });

  it('falls back to the generic pool for an unknown or missing model', () => {
    expect(nounsForModel(undefined)).toEqual(GENERIC_NOUNS);
    expect(nounsForModel('')).toEqual(GENERIC_NOUNS);
    expect(nounsForModel('some-unreleased-model-9000')).toEqual(GENERIC_NOUNS);
  });

  it('never produces a double article', () => {
    for (const noun of GENERIC_NOUNS) expect(renderPhrase('Parsing', noun)).not.toMatch(/the the/);
  });
});

describe('loading phase', () => {
  it('holds the loader for the whole of the agent turn, whatever else is pending', () => {
    expect(resolveLoadingPhase(turns('success', 'active'), nothingPending)).toBe('working');
    expect(resolveLoadingPhase(turns('active'), { llm: true, research: true })).toBe('working');
  });

  it('keeps holding it after the turn while the recap and suggestions are written', () => {
    expect(resolveLoadingPhase(turns('success'), { llm: false, research: true })).toBe('research');
    expect(resolveLoadingPhase(turns('success'), { llm: true, research: false })).toBe('parsing');
  });

  it('is ready when a finished turn was inferred from a text-only tail (no turn_ended)', () => {
    const jsonl = [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>ship it</user_query>' }] } }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: 'git push' } }] },
      }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Pushed to main.' }] } }),
    ].join('\n');
    const { turns } = parseTranscript('c', jsonl);
    expect(turns[0].status).toBe('success');
    expect(resolveLoadingPhase(turns, nothingPending)).toBe('ready');
  });

  it('is ready once nothing is outstanding, including with no turns at all', () => {
    expect(resolveLoadingPhase(turns('success'), nothingPending)).toBe('ready');
    expect(resolveLoadingPhase(turns('error'), nothingPending)).toBe('ready');
    expect(resolveLoadingPhase([], nothingPending)).toBe('ready');
  });
});

describe('loading overlay', () => {
  it('starts hidden unless the panel is waiting on the agent or enrich', () => {
    expect(initialOverlayVisibility('ready')).toBe('hidden');
    expect(initialOverlayVisibility('boot')).toBe('hidden');
    expect(initialOverlayVisibility('working')).toBe('visible');
    expect(initialOverlayVisibility('parsing')).toBe('visible');
    expect(initialOverlayVisibility('research')).toBe('visible');
  });

  it('dissolves once, then stays gone', () => {
    expect(nextOverlayVisibility('visible', 'ready')).toBe('fading');
    expect(nextOverlayVisibility('fading', 'ready')).toBe('fading');
    expect(nextOverlayVisibility('hidden', 'ready')).toBe('hidden');
  });

  it('comes back for a new turn, cancelling a half-played fade', () => {
    expect(nextOverlayVisibility('fading', 'working')).toBe('visible');
    expect(nextOverlayVisibility('hidden', 'working')).toBe('visible');
    expect(nextOverlayVisibility('hidden', 'research')).toBe('visible');
  });
});

describe('agent model detection', () => {
  it('takes the most recent reported model', () => {
    expect(agentModelFromEvents([event({ model: 'claude-4.5-sonnet' }), event({ hook: 'beforeSubmitPrompt', model: 'gpt-5.5' })])).toBe('gpt-5.5');
  });

  it('falls back to modelId, then to undefined', () => {
    expect(agentModelFromEvents([event({ modelId: 'composer-2.5' })])).toBe('composer-2.5');
    expect(agentModelFromEvents([event({ model: '  ' }), event({})])).toBeUndefined();
    expect(agentModelFromEvents([])).toBeUndefined();
  });

  it('ignores later events with no model, keeping the last known one', () => {
    expect(agentModelFromEvents([event({ model: 'claude-4.5-sonnet' }), event({ hook: 'postToolUse', toolName: 'Read' })])).toBe('claude-4.5-sonnet');
  });
});
