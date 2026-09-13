import { describe, expect, it } from 'vitest';
import type { ActivityStep, ExplainedStep, SessionConcept } from '../../shared/activity-schema';
import { ConceptDetector } from '../src/knowledge/conceptDetector';
import { KnowledgeGraph } from '../src/knowledge/knowledgeGraph';
import { collectResources, installedPackages, mcpNamespaces } from '../src/session/sessionBuilder';

const graph = new KnowledgeGraph();
const detector = new ConceptDetector(graph);

function step(toolName: string, input: Record<string, unknown>, id = 's'): ActivityStep {
  return { id, conversationId: 'c', turnIndex: 0, index: 0, toolName, category: 'other', input, status: 'done', source: 'transcript' };
}

const explained = (s: ActivityStep): ExplainedStep => ({
  ...s,
  conceptIds: [],
  explanation: { title: '', summary: '', whatHappened: '', technical: '', vocabulary: [], templateId: 't', confidence: 1 },
});

describe('learning catalog integrity', () => {
  it('has ~50 concepts with valid prerequisites and reachable resources', () => {
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

  it('offers video, course, or workshop resources on the busiest concepts', () => {
    const watchable = new Set(['video', 'course', 'workshop']);
    for (const id of ['gsap-core', 'gsap-scrolltrigger', 'react-basics', 'react-hooks', 'typescript', 'git-basics', 'css-flexbox', 'css-grid']) {
      const concept = graph.get(id);
      expect(concept, id).toBeDefined();
      expect(concept!.resources.some((r) => watchable.has(r.type)), `${id} has nothing to watch`).toBe(true);
    }
  });
});

describe('ConceptDetector', () => {
  it('detects GSAP + ScrollTrigger from an edit', () => {
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

  it('ranks concepts central to the request above incidental ones', () => {
    const steps = [
      step('StrReplace', { path: '/p/a.ts', old_string: '', new_string: "import gsap from 'gsap'; gsap.to(x, {})" }, 'a'),
      step('Shell', { command: 'git status' }, 'b'),
    ];
    const detected = detector.detectAll(steps, ['Implement a scroll animation for the homepage hero']);
    const gsap = detected.find((d) => d.conceptId === 'gsap-core')!;
    const git = detected.find((d) => d.conceptId === 'git-basics')!;
    expect(gsap.relevance).toBeGreaterThan(git.relevance);
    expect(git.relevance).toBeLessThanOrEqual(0.7);
    // detectAll returns the ordering the Learn & improve tab renders.
    expect(detected.indexOf(gsap)).toBeLessThan(detected.indexOf(git));
  });

  it('matches request keywords on word boundaries', () => {
    const detected = detector.detectAll([step('Shell', { command: 'git status' })], ['build a prototype']);
    // "pr" (pull request) must not match "prototype"
    expect(detected.find((d) => d.conceptId === 'git-basics')!.relevance).toBeLessThanOrEqual(0.7);
  });
});

describe('session signals', () => {
  it('merges resources across concepts without duplicates, most relevant concept first', () => {
    const sessionConcepts = ['gsap-core', 'gsap-scrolltrigger', 'gsap-core'].map(
      (id) => ({ concept: graph.get(id)!, detected: { conceptId: id, evidence: [], relevance: 1 }, files: [] }) satisfies SessionConcept,
    );
    const merged = collectResources(sessionConcepts);
    const keys = merged.map((r) => r.resource.url ?? r.resource.path ?? r.resource.title);
    expect(new Set(keys).size).toBe(keys.length);
    expect(merged[0].conceptId).toBe('gsap-core');
    expect(merged.some((r) => r.conceptId === 'gsap-scrolltrigger')).toBe(true);
  });

  it('extracts installed packages and MCP namespaces for research', () => {
    const steps = [
      explained(step('Shell', { command: 'npm install gsap@^3.12.5 && pnpm add -D vitest' }, 'a')),
      explained(step('Shell', { command: 'npm run build' }, 'b')),
      explained(step('CallDynamicTool', { namespace: 'plugin-figma-figma' }, 'c')),
    ];
    expect(installedPackages(steps)).toEqual(expect.arrayContaining(['gsap', 'vitest']));
    expect(installedPackages(steps)).not.toContain('build');
    expect(mcpNamespaces(steps)).toEqual(['plugin-figma-figma']);
  });
});
