/**
 * Dogfood CLI: explain a real agent transcript from the terminal, no editor needed.
 *
 *   npm run dogfood -- --workspace "/Users/me/Portfolio"           # newest chat in that workspace
 *   npm run dogfood -- --workspace "/Users/me/Portfolio" --list    # list chats
 *   npm run dogfood -- --workspace "/Users/me/Portfolio" --id <uuid>
 *   npm run dogfood -- --file path/to/transcript.jsonl
 *   npm run dogfood -- ... --grep "home-field"                     # only chats whose first request matches
 *   npm run dogfood -- ... --json                                   # dump SessionState
 *
 * Runs offline: no language model and no web search, so recommendations come from the
 * curated catalog only. Research output is cached to a throwaway directory.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExplainedStep, SessionState } from '../../shared/activity-schema';
import { LLM_FALLBACK_THRESHOLD } from '../../shared/activity-schema';
import { LlmSummarizer, NoopLlmProvider } from '../src/explainer/llmSummarizer';
import { TemplateEngine } from '../src/explainer/templateEngine';
import { GlossaryService } from '../src/glossary/glossaryService';
import { KnowledgeGraph } from '../src/knowledge/knowledgeGraph';
import { listTranscripts, resolvePaths } from '../src/paths';
import { RecommendationCatalog } from '../src/research/catalog';
import { ResearchService } from '../src/research/researchService';
import { NoopSearchClient } from '../src/research/webSearchClient';
import { SessionBuilder, titleFromRawHead } from '../src/session/sessionBuilder';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);

const workspace = opt('workspace') ?? process.cwd();
const file = opt('file');
const paths = resolvePaths(workspace);
paths.researchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decipher-research-'));

if (file) {
  // Point the builder at a fake project dir containing just this transcript.
  const id = path.basename(file, '.jsonl');
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'decipher-'));
  fs.mkdirSync(path.join(fake, 'agent-transcripts', id), { recursive: true });
  fs.copyFileSync(file, path.join(fake, 'agent-transcripts', id, `${id}.jsonl`));
  paths.transcriptsDir = path.join(fake, 'agent-transcripts');
  paths.eventsDir = path.join(fake, 'events');
}

if (flag('list')) {
  for (const t of listTranscripts(paths.transcriptsDir)) {
    const head = fs.readFileSync(t.file, 'utf8').slice(0, 8192);
    console.log(`${t.id}  ${new Date(t.mtime).toISOString().slice(0, 16)}  ${titleFromRawHead(head)}`);
  }
  process.exit(0);
}

const glossary = new GlossaryService();
const graph = new KnowledgeGraph();
const research = new ResearchService({
  catalog: new RecommendationCatalog(),
  search: new NoopSearchClient(),
  cacheDir: paths.researchDir,
  options: { enabled: true, webSearch: false, trigger: 'auto', maxResults: 6 },
});
const builder = new SessionBuilder({
  paths,
  workspaceName: path.basename(workspace),
  engine: new TemplateEngine({ glossary, workspaceRoot: workspace }),
  glossary,
  graph,
  llm: new LlmSummarizer(new NoopLlmProvider(), { enabled: false, alwaysExplainInDepth: false }),
  research,
});

let conversationId = opt('id') ?? null;
const grep = opt('grep');
if (!conversationId && grep) {
  const re = new RegExp(grep, 'i');
  const match = listTranscripts(paths.transcriptsDir).find((t) => re.test(fs.readFileSync(t.file, 'utf8').slice(0, 20000)));
  if (!match) {
    console.error(`No transcript matching /${grep}/ in ${paths.transcriptsDir}`);
    process.exit(1);
  }
  conversationId = match.id;
}
if (file) conversationId = path.basename(file, '.jsonl');

const buildOptions = { conversationId, mode: 'advanced', hooksInstalled: false, llmAvailable: false, webSearchConfigured: false, loadingRotateMs: 3500 } as const;

void main();

async function main(): Promise<void> {
  // Curated recommendations only — no model, no network.
  await builder.enhanceWithResearch(builder.build(buildOptions));
  const state: SessionState = { ...builder.build(buildOptions), loadingPhase: 'ready' };
  fs.rmSync(paths.researchDir, { recursive: true, force: true });

  if (flag('json')) {
    // Large payload: let the pipe drain instead of calling process.exit().
    process.stdout.write(JSON.stringify(state, null, 2));
  } else {
    print(state);
  }
}

function print(s: SessionState): void {
  if (!s.conversationId) {
    console.log('No conversation found.');
    return;
  }
  console.log(`\n═══ ${s.workspaceName} · chat ${s.conversationId.slice(0, 8)} · ${s.steps.length} actions ═══`);
  console.log(`${s.liveHeadline}\n${s.liveSummary}\n`);

  let coverage = 0;
  let conceptEdits = 0;
  let edits = 0;
  for (const turn of s.turns) {
    const steps = s.steps.filter((st) => st.turnIndex === turn.index && !st.subagentId);
    console.log(`── Turn ${turn.index + 1} [${turn.status}] ${turn.userRequest ? `“${turn.userRequest.split('\n')[0].slice(0, 100)}”` : ''}`);
    for (const st of steps) {
      printStep(st, s);
      if (st.explanation.confidence >= LLM_FALLBACK_THRESHOLD) coverage++;
      if (st.category === 'editing') {
        edits++;
        if (st.conceptIds.length) conceptEdits++;
      }
    }
    console.log('');
  }

  if (s.sessionConcepts.length) {
    console.log(`── Concepts to learn (${s.sessionConcepts.length}) · ${s.resources.length} resources`);
    s.sessionConcepts.forEach((c, i) => {
      const ev = c.detected.evidence.slice(0, 3).map((e) => `${e.kind}:${e.detail}`).join(', ');
      console.log(`   ${i + 1}. ${c.concept.label.padEnd(28)} rel=${c.detected.relevance.toFixed(2)}  ${c.concept.resources.length} resources  [${ev}]`);
    });
  } else console.log('── Concepts to learn: none detected');

  console.log(`\n── Suggested tools (${s.recommendations.length}) [${s.researchStatus}]`);
  for (const rec of s.recommendations) console.log(`   · ${rec.kind.padEnd(7)} ${rec.title.padEnd(28)} (${rec.source}) ${rec.url ?? ''}`);
  if (s.researchNote) console.log(`   note: ${s.researchNote}`);

  const total = s.steps.filter((st) => !st.subagentId).length;
  console.log(`\n── Coverage: ${total ? Math.round((coverage / total) * 100) : 0}% of ${total} steps matched a confident template · ${edits ? Math.round((conceptEdits / edits) * 100) : 0}% of ${edits} edits matched ≥1 concept`);
}

function printStep(st: ExplainedStep, s: SessionState): void {
  const e = st.explanation;
  const flagStr = e.confidence < 0.45 ? ' ⚠ low-confidence' : '';
  console.log(`  [${st.category.padEnd(10)}] ${e.title}${flagStr}`);
  console.log(`      ${e.summary}`);
  if (e.subSteps && e.subSteps.length > 1) for (const sub of e.subSteps) console.log(`        · ${sub.title}: ${sub.summary}`);
  if (e.technical) console.log(`      $ ${e.technical.split('\n')[0].slice(0, 110)}`);
  const vocab = e.vocabulary.map((v) => s.glossary[v]?.term).filter(Boolean);
  if (vocab.length) console.log(`      vocab: ${vocab.join(' · ')}`);
  if (st.conceptIds.length) console.log(`      concepts: ${st.conceptIds.map((c) => s.concepts[c]?.label).join(', ')}`);
}
