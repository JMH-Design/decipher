import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Recommendation, SessionState } from '../../shared/activity-schema';
import type { LlmProvider } from '../src/explainer/llmSummarizer';
import { RecommendationCatalog, type CatalogEntry } from '../src/research/catalog';
import { ResearchService, goalPhrase, mergeRecommendations, parseRecommendations } from '../src/research/researchService';
import { resourceSheetMarkdown } from '../src/research/resourceSheet';
import { NoopSearchClient, sanitizeQuery } from '../src/research/webSearchClient';

const catalog = new RecommendationCatalog();

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'decipher-research-'));
}

function service(overrides: Partial<{ provider: LlmProvider; trigger: 'auto' | 'manual'; cacheDir: string }> = {}) {
  return new ResearchService({
    catalog,
    provider: overrides.provider,
    search: new NoopSearchClient(),
    cacheDir: overrides.cacheDir ?? tmpDir(),
    options: { enabled: true, webSearch: false, trigger: overrides.trigger ?? 'auto', maxResults: 6 },
  });
}

function state(over: Partial<SessionState> = {}): SessionState {
  return {
    conversationId: 'conv-1',
    conversations: [],
    turns: [{ index: 0, status: 'success', stepIds: [], userRequest: 'Add a scroll animation to the hero' }],
    steps: [],
    liveHeadline: 'Edited one file.',
    liveSummary: 'It changed hero.ts.',
    liveSummaryKind: 'turn',
    glossary: {},
    concepts: {},
    sessionConcepts: [],
    resources: [],
    recommendations: [],
    researchStatus: 'idle',
    webSearchConfigured: false,
    loadingPhase: 'ready',
    loadingRotateMs: 3500,
    mode: 'beginner',
    hooksInstalled: false,
    hooksSupported: true,
    llmAvailable: false,
    workspaceName: 'demo',
    host: 'cursor',
    agentSource: 'cursor',
    agentLabel: 'the Cursor agent',
    agentShortLabel: 'the agent',
    goal: 'Add a scroll animation to the hero',
    ...over,
  };
}

describe('recommendation catalog', () => {
  it('every entry has copy and at least one way to match', () => {
    for (const e of catalog.all()) {
      expect(e.title.length, e.id).toBeGreaterThan(1);
      expect(e.summary.endsWith('.'), `${e.id} summary`).toBe(true);
      expect(e.whyForYou.endsWith('.'), `${e.id} whyForYou`).toBe(true);
      // whyForYou completes "Worth a look because …", so it must read lowercase.
      expect(/^[a-z"“]/.test(e.whyForYou), `${e.id} whyForYou should start lowercase`).toBe(true);
      if (e.url) expect(e.url).toMatch(/^https:\/\//);
      const rules = e.match;
      expect(Boolean(rules.concepts?.length || rules.categories?.length || rules.keywords?.length || rules.packages?.length), `${e.id} has no match rules`).toBe(true);
    }
  });

  it('matches animation work on concept and keyword, strongest first', () => {
    const matches = catalog.match({
      requests: ['Implement a scroll animation for the homepage hero'],
      concepts: [
        { id: 'gsap-scrolltrigger', category: 'animation' },
        { id: 'gsap-core', category: 'animation' },
      ],
      packages: ['gsap'],
    });
    const ids = matches.map((m) => m.entry.id);
    expect(ids).toContain('scroll-driven-animations');
    expect(ids).toContain('rive');
    for (let i = 1; i < matches.length; i++) expect(matches[i - 1].score).toBeGreaterThanOrEqual(matches[i].score);
  });

  it('returns nothing when no signal matches', () => {
    expect(catalog.match({ requests: [], concepts: [], packages: [] })).toEqual([]);
  });

  it('respects word boundaries when matching request keywords', () => {
    const entries: CatalogEntry[] = [{ id: 'x', kind: 'tool', title: 'X', summary: 'S.', whyForYou: 'w.', match: { keywords: ['test'] } }];
    const small = new RecommendationCatalog(entries);
    expect(small.match({ requests: ['ship the latest build'], concepts: [], packages: [] })).toEqual([]);
    expect(small.match({ requests: ['write a test'], concepts: [], packages: [] })).toHaveLength(1);
  });
});

describe('merging and parsing', () => {
  const rec = (id: string, source: Recommendation['source'], url?: string): Recommendation => ({
    id,
    kind: 'tool',
    title: id,
    summary: 's',
    whyForYou: 'w',
    url,
    source,
  });

  it('reserves room for both sources and backfills from the longer list', () => {
    const curated = [rec('c1', 'curated'), rec('c2', 'curated'), rec('c3', 'curated'), rec('c4', 'curated')];
    const researched = [rec('r1', 'researched')];
    const merged = mergeRecommendations(curated, researched, 4);
    expect(merged.map((m) => m.id)).toEqual(['c1', 'c2', 'r1', 'c3']);
  });

  it('de-duplicates on host so the same tool never appears twice', () => {
    const merged = mergeRecommendations([rec('rive', 'curated', 'https://rive.app')], [rec('rive-app', 'researched', 'https://www.rive.app/pricing')], 6);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('curated');
  });

  it('recovers a JSON array from a fenced model response and drops invalid items', () => {
    const parsed = parseRecommendations(`Sure!\n\`\`\`json\n[
      {"kind":"mcp","title":"Figma MCP","summary":"Reads your designs.","whyForYou":"you are building from a mockup.","url":"https://figma.com"},
      {"kind":"nonsense","title":"Rive","summary":"Visual motion editor."},
      {"title":"","summary":"no title"},
      {"kind":"tool","summary":"no title either"}
    ]\n\`\`\``);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ kind: 'mcp', title: 'Figma MCP', source: 'researched' });
    // Unknown kinds fall back to "tool"; a missing whyForYou gets a safe default.
    expect(parsed[1].kind).toBe('tool');
    expect(parsed[1].whyForYou.length).toBeGreaterThan(0);
    expect(parsed[1].url).toBeUndefined();
  });

  it('rejects non-JSON and non-array replies', () => {
    expect(parseRecommendations('I cannot help with that.')).toEqual([]);
    expect(parseRecommendations('[not json')).toEqual([]);
    expect(parseRecommendations('{"a":1}')).toEqual([]);
  });

  it('drops invented non-http urls', () => {
    expect(parseRecommendations('[{"title":"X","summary":"Y.","url":"file:///etc/passwd"}]')[0].url).toBeUndefined();
  });
});

describe('search query hygiene', () => {
  it('strips local paths and credential-shaped tokens, and caps the length', () => {
    expect(sanitizeQuery('animate the hero in /Users/jane/Secret Project/src/app.tsx')).toBe('animate the hero in');
    expect(sanitizeQuery('deploy with token ghp_abcdefghijklmnop please')).toBe('deploy with token please');
    expect(sanitizeQuery('x'.repeat(500)).length).toBe(200);
  });

  it('turns a request into a short search phrase', () => {
    expect(goalPhrase('Can you add a scroll animation\nto the hero section')).toBe('add a scroll animation');
    expect(goalPhrase('')).toBe('');
  });
});

describe('ResearchService', () => {
  it('produces curated suggestions and explains why the list is limited', async () => {
    const svc = service();
    const result = await svc.run({
      conversationId: 'conv-1',
      signature: 'sig-1',
      goal: 'Add a scroll animation to the hero',
      requests: ['Add a scroll animation to the hero'],
      concepts: [{ id: 'gsap-scrolltrigger', label: 'GSAP ScrollTrigger', category: 'animation' }],
      packages: ['gsap'],
      mcpNamespaces: [],
    });
    expect(result.status).toBe('ready');
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations.every((r) => r.source === 'curated')).toBe(true);
    expect(result.note).toMatch(/built-in list/);
  });

  it('caches per turn and re-runs only when the signature changes', async () => {
    const cacheDir = tmpDir();
    const svc = service({ cacheDir });
    const s = state();
    expect(svc.shouldResearch(s)).toBe(true);
    const signature = svc.signatureFor(s);
    await svc.run({ conversationId: 'conv-1', signature, requests: [], concepts: [], packages: [], mcpNamespaces: [] });
    expect(svc.shouldResearch(s)).toBe(false);

    // A new turn changes the signature, so research runs again.
    const next = state({ turns: [...s.turns, { index: 1, status: 'success', stepIds: [], userRequest: 'now deploy it' }] });
    expect(svc.shouldResearch(next)).toBe(true);

    // The result survives a restart via the on-disk cache.
    expect(service({ cacheDir }).cached('conv-1', signature)).toBeDefined();
  });

  it('never researches an in-flight turn', () => {
    const svc = service();
    expect(svc.shouldResearch(state({ turns: [{ index: 0, status: 'active', stepIds: [], userRequest: 'go' }] }))).toBe(false);
  });

  it('waits for an explicit request in manual mode', async () => {
    const svc = service({ trigger: 'manual' });
    const s = state();
    expect(svc.shouldResearch(s)).toBe(false);
    svc.requestNow('conv-1');
    expect(svc.shouldResearch(s)).toBe(true);
    await svc.run({ conversationId: 'conv-1', signature: svc.signatureFor(s), requests: [], concepts: [], packages: [], mcpNamespaces: [] });
    expect(svc.shouldResearch(s)).toBe(false);
  });

  it('leaves the cache alone when a pass is superseded, so the newer pass redoes the work', async () => {
    const svc = service();
    const s = state();
    const aborted = new AbortController();
    aborted.abort();
    await svc.run({ conversationId: 'conv-1', signature: svc.signatureFor(s), goal: s.goal, requests: [s.goal!], concepts: [], packages: [], mcpNamespaces: [] }, aborted.signal).catch(() => undefined);
    expect(svc.cached('conv-1', svc.signatureFor(s))).toBeUndefined();
    expect(svc.shouldResearch(s)).toBe(true);
  });

  it('caches a result even when the model throws, so the caller cannot loop', async () => {
    const throwing: LlmProvider = {
      available: async () => true,
      complete: async () => {
        throw new Error('model exploded');
      },
    };
    const svc = service({ provider: throwing });
    const s = state();
    const result = await svc.run({ conversationId: 'conv-1', signature: svc.signatureFor(s), goal: s.goal, requests: [s.goal!], concepts: [], packages: [], mcpNamespaces: [] });
    expect(result.note).toMatch(/language model/);
    expect(svc.shouldResearch(s)).toBe(false);
  });

  it('merges model suggestions with curated ones', async () => {
    const provider: LlmProvider = {
      available: async () => true,
      complete: async () => '[{"kind":"tool","title":"Rive","summary":"Visual motion editor.","whyForYou":"you are hand-coding motion.","url":"https://rive.app"},{"kind":"kit","title":"Motion One","summary":"Small animation library.","whyForYou":"it is lighter than GSAP.","url":"https://motion.dev/one"}]',
    };
    const svc = service({ provider });
    const result = await svc.run({
      conversationId: 'conv-2',
      signature: 'sig',
      goal: 'Add a scroll animation',
      requests: ['Add a scroll animation'],
      concepts: [{ id: 'gsap-scrolltrigger', label: 'GSAP ScrollTrigger', category: 'animation' }],
      packages: [],
      mcpNamespaces: [],
    });
    expect(result.recommendations.some((r) => r.source === 'researched')).toBe(true);
    expect(result.recommendations.some((r) => r.source === 'curated')).toBe(true);
    // Rive is in the curated catalog, so the model's duplicate must not double up.
    expect(result.recommendations.filter((r) => r.title === 'Rive')).toHaveLength(1);
  });
});

describe('resource sheet export', () => {
  it('covers the request, the concepts, and the suggestions', () => {
    const md = resourceSheetMarkdown(
      state({
        sessionConcepts: [
          {
            concept: {
              id: 'gsap-core',
              label: 'GSAP',
              plainSummary: 'An animation library.',
              whyUsed: 'It animates the hero.',
              depth: 'intermediate',
              category: 'animation',
              prerequisites: [],
              topics: [{ id: 't', label: 'Tweens', minutes: 15 }],
              resources: [{ type: 'video', title: 'GSAP in 100 seconds', url: 'https://youtu.be/x' }],
              detection: {},
            },
            detected: { conceptId: 'gsap-core', evidence: [], relevance: 1 },
            files: ['/p/src/hero.ts'],
          },
        ],
        recommendations: [{ id: 'rive', kind: 'tool', title: 'Rive', summary: 'Visual motion editor.', whyForYou: 'you are hand-coding motion.', url: 'https://rive.app', source: 'curated' }],
      }),
    );
    expect(md).toContain('## What you asked for');
    expect(md).toContain('Add a scroll animation to the hero');
    expect(md).toContain('### GSAP');
    expect(md).toContain('[GSAP in 100 seconds](https://youtu.be/x)');
    expect(md).toContain('`hero.ts`');
    expect(md).toContain('## Tools that could help next time');
    expect(md).toContain('Worth a look because you are hand-coding motion.');
  });
});
