import { describe, expect, it } from 'vitest';
import type { ActivityStep } from '../../shared/activity-schema';
import { TemplateEngine } from '../src/explainer/templateEngine';
import { GlossaryService } from '../src/glossary/glossaryService';

const engine = new TemplateEngine({ glossary: new GlossaryService(), workspaceRoot: '/Users/me/Portfolio' });

function step(toolName: string, input: Record<string, unknown>, output?: string): ActivityStep {
  return { id: 's1', conversationId: 'c', turnIndex: 0, index: 0, toolName, category: 'other', input, output, status: 'done', source: output ? 'hook' : 'transcript' };
}

describe('shell templates', () => {
  it('explains git status from the plan screenshot, with output', () => {
    const out = '## main...origin/main\n M src/styles/global.css\n?? scripts/debug/modal-scrim-strip.png\n';
    const e = engine.explain(step('Shell', { command: 'git status --short' }, out));
    expect(e.title).toBe('Checking which files changed');
    expect(e.summary).toMatch(/1 file was edited \(global\.css\)/);
    expect(e.summary).toMatch(/1 new file is not yet tracked by git \(modal-scrim-strip\.png\)/);
    expect(e.vocabulary).toEqual(expect.arrayContaining(['git', 'status', 'modified', 'untracked']));
  });

  it('breaks a chained command into sub-steps', () => {
    const e = engine.explain(step('Shell', { command: `rg -n 'home-field|data-home-field' . && git status && git diff --stat && git log -5 --oneline` }));
    expect(e.templateId).toBe('shell.chain');
    expect(e.subSteps).toHaveLength(4);
    expect(e.subSteps![0].title).toBe('Searching the project');
    expect(e.subSteps![0].summary).toContain('"home-field" or "data-home-field"');
    expect(e.subSteps![2].title).toBe('Reviewing a summary of changes');
    expect(e.subSteps![3].summary).toContain('last 5 checkpoints');
    expect(e.summary).toMatch(/^Ran 4 steps in order/);
    expect(e.vocabulary).toContain('chained-commands');
  });

  it('extracts commit messages including heredocs and reports push', () => {
    const e = engine.explain(step('Shell', { command: `git commit -m "$(cat <<'EOF'\nRemove the /lab/home-field bake-off now that the homepage field shipped\n\nDetails here\nEOF\n)" && git push origin main` }));
    expect(e.subSteps![0].summary).toContain('"Remove the /lab/home-field bake-off now that the homepage field shipped"');
    expect(e.subSteps![1].title).toBe('Uploading to GitHub');
  });

  it('reports search results when hook output is present', () => {
    const e = engine.explain(step('Shell', { command: 'rg -n "foo" src' }, 'src/a.ts:3:foo\nsrc/a.ts:9:foo\nsrc/b.ts:1:foo\n'));
    expect(e.summary).toContain('3 matches in 2 files');
    const none = engine.explain(step('Shell', { command: 'rg -n "foo" src' }, ''));
    expect(none.summary).toContain('found nothing');
  });

  it('skips cd scaffolding and echo separators', () => {
    const e = engine.explain(step('Shell', { command: 'cd /Users/me/Portfolio && ls src && echo "---" && git status' }));
    expect(e.subSteps).toHaveLength(2);
  });

  it('understands package managers and dev servers', () => {
    expect(engine.explain(step('Shell', { command: 'npm install gsap' })).summary).toContain('gsap');
    expect(engine.explain(step('Shell', { command: 'npx astro dev --background' })).title).toMatch(/local preview/i);
    expect(engine.explain(step('Shell', { command: 'curl -s -o /dev/null -w "%{http_code}" http://localhost:4321/' })).title).toBe('Checking the local preview');
  });

  it('falls back with low confidence for unknown programs', () => {
    const e = engine.explain(step('Shell', { command: 'frobnicate --all' }));
    expect(e.confidence).toBeLessThan(0.45);
    expect(e.technical).toBe('frobnicate --all');
  });

  it('uses the agent description when the fallback is weak', () => {
    const e = engine.explain(step('Shell', { command: 'frobnicate --all', description: 'Rebuild the search index' }));
    expect(e.summary).toBe('Rebuild the search index.');
  });
});

describe('tool templates', () => {
  it('names files in plain language', () => {
    const e = engine.explain(step('Read', { path: '/Users/me/Portfolio/src/styles/global.css' }));
    expect(e.summary).toBe('Opened the main stylesheet (global.css) to understand how it works.');
    expect(e.technical).toBe('src/styles/global.css');
  });

  it('recognises skill reads', () => {
    const e = engine.explain(step('Read', { path: '/Users/me/.claude/skills/gsap-core/SKILL.md' }));
    expect(e.title).toBe('Reading an instruction guide');
    expect(e.summary).toContain('"gsap-core" skill guide');
  });

  it('describes edits with size and intent', () => {
    const s = step('StrReplace', { path: '/Users/me/Portfolio/src/components/Hero.astro', old_string: 'a\nb', new_string: 'a\nb\nc\nd' });
    s.narration = 'Adding the stagger delay.';
    const e = engine.explain(s);
    expect(e.summary).toBe('Updated an Astro page/component (Hero.astro), replacing 2 lines with 4 — Adding the stagger delay.');
  });

  it('never displays contents of sensitive files', () => {
    const e = engine.explain(step('Read', { path: '/Users/me/Portfolio/.env' }));
    expect(e.whatHappened).toMatch(/secrets/);
  });

  it('marks errored steps', () => {
    const s = step('Shell', { command: 'npm test' });
    s.status = 'error';
    s.errorMessage = 'Command timed out after 30s';
    expect(engine.explain(s).whatHappened).toContain('It failed: Command timed out after 30s');
  });
});
