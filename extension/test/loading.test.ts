import { describe, expect, it } from 'vitest';
import type { HookEvent } from '../../shared/activity-schema';
import { agentModelFromEvents } from '../src/loading/agentModel';
import { GENERIC_NOUNS, VERBS, loadingPhrase, nounsForModel, renderPhrase } from '../src/loading/loadingPhrases';

const event = (over: Partial<HookEvent>): HookEvent => ({ ts: '2026-09-13T00:00:00Z', hook: 'sessionStart', conversationId: 'c', ...over });

describe('loading phrases', () => {
  it('reads as "Verb the noun" and stays grammatical for possessive nouns', () => {
    expect(renderPhrase('Deciphering', { text: 'black box', article: true })).toBe('Deciphering the black box…');
    expect(renderPhrase('Deciphering', { text: "Claude's inner monologue", article: false })).toBe("Deciphering Claude's inner monologue…");
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
