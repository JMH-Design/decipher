import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ActivityStep } from '../../shared/activity-schema';
import { ConceptDetector } from '../src/knowledge/conceptDetector';
import { DebtTracker } from '../src/knowledge/debtTracker';
import { KnowledgeGraph } from '../src/knowledge/knowledgeGraph';
import { ProfileStore, emptyProfile } from '../src/knowledge/profileStore';

const graph = new KnowledgeGraph();
const detector = new ConceptDetector(graph);
const tracker = new DebtTracker(graph);

function step(toolName: string, input: Record<string, unknown>, id = 's'): ActivityStep {
  return { id, conversationId: 'c', turnIndex: 0, index: 0, toolName, category: 'other', input, status: 'done', source: 'transcript' };
}

describe('knowledge graph integrity', () => {
  it('has ~50 concepts with valid prerequisites and resources', () => {
    const all = graph.all();
    expect(all.length).toBeGreaterThanOrEqual(50);
    for (const c of all) {
      for (const p of c.prerequisites) expect(graph.get(p), `${c.id} → ${p}`).toBeDefined();
      expect(c.topics.length, c.id).toBeGreaterThan(0);
      expect(c.resources.length, c.id).toBeGreaterThan(0);
      for (const r of c.resources) expect(Boolean(r.url || r.path), `${c.id} resource ${r.title}`).toBe(true);
    }
  });

  it('has no prerequisite cycles', () => {
    for (const c of graph.all()) expect(graph.prerequisitesOf(c.id)).not.toContain(c.id);
  });
});

describe('ConceptDetector', () => {
  it('detects GSAP + ScrollTrigger from an edit (the plan example)', () => {
    const s = step('StrReplace', {
      path: '/p/src/scripts/home-field.ts',
      old_string: '',
      new_string: `import gsap from 'gsap';\nimport { ScrollTrigger } from 'gsap/ScrollTrigger';\ngsap.registerPlugin(ScrollTrigger);\ngsap.to('.hf-word', { y: 0, stagger: 0.05, scrollTrigger: { trigger: '.hero' } });`,
    });
    const ids = detector.detectStep(s).map((d) => d.conceptId);
    expect(ids).toEqual(expect.arrayContaining(['gsap-core', 'gsap-scrolltrigger', 'typescript']));
    const gsap = detector.detectStep(s).find((d) => d.conceptId === 'gsap-core')!;
    expect(gsap.evidence.some((e) => e.kind === 'import')).toBe(true);
    expect(gsap.evidence.some((e) => e.kind === 'symbol' && e.detail === 'gsap.to(')).toBe(true);
  });

  it('detects package installs, skill reads and MCP usage', () => {
    expect(detector.detectStep(step('Shell', { command: 'npm install gsap @gsap/react' })).map((d) => d.conceptId)).toEqual(expect.arrayContaining(['gsap-core', 'gsap-react', 'npm-packages']));
    expect(detector.detectStep(step('Read', { path: '/Users/me/.claude/skills/gsap-scrolltrigger/SKILL.md' })).map((d) => d.conceptId)).toContain('gsap-scrolltrigger');
    expect(detector.detectStep(step('CallDynamicTool', { namespace: 'plugin-figma-figma', toolName: 'get_design_context' })).map((d) => d.conceptId)).toContain('figma-to-code');
  });

  it('ignores node_modules and lock files', () => {
    expect(detector.detectStep(step('Read', { path: '/p/node_modules/gsap/index.js' }))).toEqual([]);
    expect(detector.detectStep(step('Read', { path: '/p/package-lock.json' }))).toEqual([]);
  });

  it('boosts relevance for concepts central to the request and caps incidental ones', () => {
    const steps = [
      step('StrReplace', { path: '/p/a.ts', old_string: '', new_string: "import gsap from 'gsap'; gsap.to(x, {})" }, 'a'),
      step('Shell', { command: 'git status' }, 'b'),
    ];
    const detected = detector.detectAll(steps, ['Implement a scroll animation for the homepage hero']);
    const gsap = detected.find((d) => d.conceptId === 'gsap-core')!;
    const git = detected.find((d) => d.conceptId === 'git-basics')!;
    expect(gsap.relevance).toBeGreaterThan(git.relevance);
    expect(git.relevance).toBeLessThanOrEqual(0.7);
  });

  it('matches request keywords on word boundaries', () => {
    const detected = detector.detectAll([step('Shell', { command: 'git status' })], ['build a prototype']);
    // "pr" (pull request) must not match "prototype"
    expect(detected.find((d) => d.conceptId === 'git-basics')!.relevance).toBeLessThanOrEqual(0.7);
  });
});

describe('DebtTracker', () => {
  it('reproduces the plan worked example: new intermediate central concept = 8 points', () => {
    const scored = tracker.score({ conceptId: 'gsap-core', evidence: [], relevance: 1.0 }, emptyProfile())!;
    expect(scored.debt).toBe(8);
    expect(scored.novelty).toBe(1);
    expect(scored.minutes).toBe(45);
  });

  it('drops to 0 when learned and to review when seen twice', () => {
    const profile = emptyProfile();
    profile.concepts['gsap-core'] = { exposures: 5, status: 'learned', firstSeen: '2026-09-01', lastSeen: '2026-09-10', learnedAt: '2026-09-10' };
    profile.concepts['css-animations'] = { exposures: 2, status: 'learning', firstSeen: '2026-09-01', lastSeen: '2026-09-10' };
    expect(tracker.score({ conceptId: 'gsap-core', evidence: [], relevance: 1 }, profile)!.debt).toBe(0);
    const review = tracker.score({ conceptId: 'css-animations', evidence: [], relevance: 1.5 }, profile)!;
    expect(review.novelty).toBe(0.3);
    expect(review.debt).toBe(2);
    expect(review.minutes).toBe(5);
  });

  it('summarises a session and caps the queue', () => {
    const detected = ['gsap-core', 'gsap-scrolltrigger', 'css-animations', 'git-basics', 'terminal-basics', 'astro', 'typescript'].map((id) => ({ conceptId: id, evidence: [], relevance: 1 }));
    const s = tracker.summarize('c', detected, emptyProfile(), 5);
    expect(s.queue).toHaveLength(5);
    for (let i = 1; i < s.queue.length; i++) expect(s.queue[i - 1].debt).toBeGreaterThanOrEqual(s.queue[i].debt);
    expect(s.queue.map((q) => q.concept.id)).toContain('gsap-core');
    expect(s.totalDebt).toBeGreaterThan(0);
    expect(s.newConcepts).toBe(7);
  });

  it('exports markdown', () => {
    const s = tracker.summarize('c', [{ conceptId: 'gsap-core', evidence: [{ kind: 'import', detail: 'gsap', stepId: 's', file: '/p/home-field.ts' }], relevance: 1 }], emptyProfile());
    const md = tracker.toMarkdown(s, ['Implement a scroll animation']);
    expect(md).toContain('# Learning plan');
    expect(md).toContain('## 1. GSAP');
    expect(md).toContain('gsap.com');
  });
});

describe('ProfileStore', () => {
  it('counts exposures once per conversation and persists status', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'decipher-test-')), 'profile.json');
    const store = new ProfileStore(file);
    store.recordExposures('conv-1', ['gsap-core']);
    store.recordExposures('conv-1', ['gsap-core']);
    store.recordExposures('conv-2', ['gsap-core']);
    expect(store.get().concepts['gsap-core'].exposures).toBe(2);
    store.setStatus('gsap-core', 'learned', 8);
    expect(store.get().totalDebtPaid).toBe(8);
    await new Promise((r) => setTimeout(r, 250));
    const reloaded = new ProfileStore(file);
    expect(reloaded.get().concepts['gsap-core'].status).toBe('learned');
    expect(reloaded.get().sessionsReviewed).toBe(2);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
