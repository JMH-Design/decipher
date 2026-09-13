import * as fs from 'node:fs';
import type { ActivityStep, ConversationSummary, ExplainMode, ExplainedStep, HookEvent, SessionState, StepCategory, Turn } from '../../../shared/activity-schema';
import type { LlmSummarizer } from '../explainer/llmSummarizer';
import type { TemplateEngine } from '../explainer/templateEngine';
import type { GlossaryService } from '../glossary/glossaryService';
import { ConceptDetector } from '../knowledge/conceptDetector';
import type { DebtTracker } from '../knowledge/debtTracker';
import type { KnowledgeGraph } from '../knowledge/knowledgeGraph';
import type { ProfileStore } from '../knowledge/profileStore';
import { parseTranscript } from '../parser/transcriptParser';
import { listSubagentTranscripts, listTranscripts, type DecipherPaths } from '../paths';
import { mergeHookEvents } from './hookMerger';

export interface SessionBuilderDeps {
  paths: DecipherPaths;
  workspaceName: string;
  engine: TemplateEngine;
  glossary: GlossaryService;
  graph: KnowledgeGraph;
  debt: DebtTracker;
  profile: ProfileStore;
  llm?: LlmSummarizer;
  maxQueue: number;
}

export interface BuildOptions {
  conversationId: string | null;
  mode: ExplainMode;
  hooksInstalled: boolean;
  llmAvailable: boolean;
}

/**
 * Turns raw inputs (transcript JSONL, subagent transcripts, hook events, learning profile)
 * into the single `SessionState` object the webview renders. Rebuilt from scratch on every
 * change — the inputs are small and this keeps the pipeline deterministic.
 */
export class SessionBuilder {
  private readonly detector: ConceptDetector;
  private llmSummaries = new Map<string, string>();

  constructor(private readonly deps: SessionBuilderDeps) {
    this.detector = new ConceptDetector(deps.graph);
  }

  listConversations(): ConversationSummary[] {
    return listTranscripts(this.deps.paths.transcriptsDir)
      .slice(0, 25)
      .map(({ id, file, mtime }) => {
        const head = readHead(file, 8192);
        const title = titleFromRawHead(head);
        return { id, title, lastModified: mtime, stepCount: 0 };
      });
  }

  /** Newest conversation, or one that recently received hook events. */
  pickActiveConversation(): string | null {
    const transcripts = listTranscripts(this.deps.paths.transcriptsDir);
    const events = listEventFiles(this.deps.paths.eventsDir);
    const newest = [...transcripts.map((t) => ({ id: t.id, mtime: t.mtime })), ...events].sort((a, b) => b.mtime - a.mtime)[0];
    return newest?.id ?? null;
  }

  build(opts: BuildOptions): SessionState {
    const { paths, glossary, graph, profile } = this.deps;
    const conversationId = opts.conversationId ?? this.pickActiveConversation();
    const base: SessionState = {
      conversationId,
      conversations: this.listConversations(),
      turns: [],
      steps: [],
      liveSummary: 'Start a chat with the agent — I’ll explain everything here.',
      liveSummaryKind: 'idle',
      debt: null,
      blindSpots: this.deps.debt.blindSpots(profile.get()),
      glossary: glossary.all(),
      concepts: graph.asRecord(),
      profile: profile.get(),
      mode: opts.mode,
      hooksInstalled: opts.hooksInstalled,
      llmAvailable: opts.llmAvailable,
      workspaceName: this.deps.workspaceName,
    };
    if (!conversationId) return base;

    const { steps, turns } = this.loadConversation(conversationId);
    const userRequests = turns.map((t) => t.userRequest ?? '').filter(Boolean);

    const explained: ExplainedStep[] = steps.map((step) => {
      const turn = turns[step.turnIndex];
      const explanation = this.deps.engine.explain(step, turn?.userRequest);
      const conceptIds = this.detector.detectStep(step).map((d) => d.conceptId);
      return { ...step, explanation, conceptIds };
    });

    // Knowledge debt for the whole session.
    const detected = this.detector.detectAll(steps, userRequests);
    const lastTurn = turns[turns.length - 1];
    const sessionComplete = !lastTurn || lastTurn.status !== 'active';
    if (sessionComplete && detected.length) profile.recordExposures(conversationId, detected.map((d) => d.conceptId));
    const debt = detected.length ? this.deps.debt.summarize(conversationId, detected, profile.get(), this.deps.maxQueue) : null;

    const { text, kind } = this.liveSummary(conversationId, turns, explained);

    return {
      ...base,
      conversationId,
      turns,
      steps: explained,
      liveSummary: text,
      liveSummaryKind: kind,
      debt,
      blindSpots: this.deps.debt.blindSpots(profile.get()),
      profile: profile.get(),
    };
  }

  /** Kick off LLM turn summaries for complex turns; resolves true when a new summary landed. */
  async enhanceWithLlm(state: SessionState, signal?: AbortSignal): Promise<boolean> {
    const llm = this.deps.llm;
    if (!llm || !state.conversationId) return false;
    let changed = false;
    // Only the last two turns — earlier ones are already stable and rarely looked at.
    for (const turn of state.turns.slice(-2)) {
      if (turn.status === 'active') continue;
      const steps = state.steps.filter((s) => s.turnIndex === turn.index && !s.subagentId);
      const key = `${state.conversationId}:${turn.index}:${steps.length}`;
      if (this.llmSummaries.has(key)) continue;
      const summary = await llm.summarizeTurn(state.conversationId, turn.index, { userRequest: turn.userRequest, steps, turnStatus: turn.status }, signal);
      if (summary) {
        this.llmSummaries.set(key, summary);
        changed = true;
      } else this.llmSummaries.set(key, '');
    }
    return changed;
  }

  llmSummaryFor(conversationId: string, turn: Turn, stepCount: number): string | undefined {
    return this.llmSummaries.get(`${conversationId}:${turn.index}:${stepCount}`) || undefined;
  }

  // ---------------------------------------------------------------------------

  private loadConversation(conversationId: string): { steps: ActivityStep[]; turns: Turn[] } {
    const { transcriptsDir, eventsDir } = this.deps.paths;
    const mainFile = `${transcriptsDir}/${conversationId}/${conversationId}.jsonl`;
    let steps: ActivityStep[] = [];
    let turns: Turn[] = [];

    if (fs.existsSync(mainFile)) {
      const parsed = parseTranscript(conversationId, safeRead(mainFile));
      steps = parsed.steps;
      turns = parsed.turns;
      // Subagent transcripts nest under the Task step that spawned them (matched in order).
      const taskSteps = steps.filter((s) => s.toolName === 'Task');
      listSubagentTranscripts(transcriptsDir, conversationId).forEach((sub, i) => {
        const parent = taskSteps[i];
        const subParsed = parseTranscript(conversationId, safeRead(sub.file), {
          subagentId: sub.id,
          parentStepId: parent?.id,
          indexOffset: (parent?.index ?? steps.length) * 1000 + 1,
        });
        for (const s of subParsed.steps) {
          s.turnIndex = parent?.turnIndex ?? turns.length - 1;
          steps.push(s);
        }
      });
      steps.sort((a, b) => a.index - b.index);
    }

    const events = readEvents(`${eventsDir}/${conversationId}.jsonl`);
    if (events.length) {
      if (!turns.length) turns.push({ index: 0, status: 'active', stepIds: [] });
      const merged = mergeHookEvents(conversationId, steps, turns, events);
      steps = merged.steps;
      turns = merged.turns;
    }
    return { steps, turns };
  }

  private liveSummary(conversationId: string, turns: Turn[], steps: ExplainedStep[]): { text: string; kind: SessionState['liveSummaryKind'] } {
    const last = turns[turns.length - 1];
    if (!last) return { text: 'No agent activity in this chat yet.', kind: 'idle' };
    const turnSteps = steps.filter((s) => s.turnIndex === last.index && !s.subagentId);
    if (last.status === 'active') {
      const current = [...turnSteps].reverse().find((s) => s.status === 'running') ?? turnSteps[turnSteps.length - 1];
      if (!current) return { text: 'The agent is thinking about your request…', kind: 'now' };
      return { text: `Right now: ${lowerFirst(current.explanation.title)} — ${lowerFirst(current.explanation.summary)}`, kind: 'now' };
    }
    const llm = this.llmSummaryFor(conversationId, last, turnSteps.length);
    if (llm) return { text: `This turn: ${llm}`, kind: 'turn' };
    if (last.status === 'error') return { text: `This turn: something went wrong. ${composeTurn(turnSteps)}`, kind: 'turn' };
    if (last.status === 'aborted') return { text: `This turn was stopped early. ${composeTurn(turnSteps)}`, kind: 'turn' };
    if (!turnSteps.length) return { text: last.finalResponse ? `This turn: the agent replied without changing anything.` : 'This turn: no actions were taken.', kind: 'turn' };
    return { text: `This turn: ${composeTurn(turnSteps)}`, kind: 'turn' };
  }
}

/** Template-only composition: "Searched the project, edited 3 files, and saved a checkpoint." */
export function composeTurn(steps: ExplainedStep[]): string {
  const order: StepCategory[] = [];
  const counts = new Map<StepCategory, number>();
  const files = new Set<string>();
  for (const s of steps) {
    if (!counts.has(s.category)) order.push(s.category);
    counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    if (s.category === 'editing' && typeof s.input.path === 'string') files.add(s.input.path);
  }
  const phrases = order
    .map((c) => {
      const n = counts.get(c)!;
      switch (c) {
        case 'reading':
          return n === 1 ? 'read one file' : `read ${n} files`;
        case 'searching':
          return n === 1 ? 'searched the project' : `ran ${n} searches`;
        case 'editing':
          return files.size ? `edited ${files.size === 1 ? 'one file' : `${files.size} files`}` : 'made edits';
        case 'running':
          return n === 1 ? 'ran a command' : `ran ${n} commands`;
        case 'checking':
          return 'reviewed the changes';
        case 'saving':
          return steps.some((s) => /push/.test(String(s.input.command ?? ''))) ? 'saved a checkpoint and uploaded it' : 'saved a checkpoint';
        case 'asking':
          return 'asked you a question';
        case 'planning':
          return steps.some((s) => s.toolName === 'CreatePlan') ? 'proposed a plan' : 'tracked its progress';
        case 'delegating':
          return n === 1 ? 'delegated a sub-task' : `delegated ${n} sub-tasks`;
        case 'external':
          return 'used an outside tool';
        case 'browsing':
          return 'looked things up online';
        default:
          return undefined;
      }
    })
    .filter((p): p is string => Boolean(p));
  if (!phrases.length) return 'The agent finished without notable actions.';
  const joined = phrases.length === 1 ? phrases[0] : `${phrases.slice(0, -1).join(', ')}, and ${phrases[phrases.length - 1]}`;
  return `${joined[0].toUpperCase()}${joined.slice(1)}.`;
}

function readEvents(file: string): HookEvent[] {
  if (!fs.existsSync(file)) return [];
  return safeRead(file)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as HookEvent;
      } catch {
        return undefined;
      }
    })
    .filter((e): e is HookEvent => Boolean(e));
}

function listEventFiles(dir: string): Array<{ id: string; mtime: number }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ id: f.replace(/\.jsonl$/, ''), mtime: fs.statSync(`${dir}/${f}`).mtimeMs }));
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** The head is raw JSON text, so newlines/quotes are still escaped. */
export function titleFromRawHead(head: string): string {
  const m = head.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (!m) return 'Untitled chat';
  const text = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.trim().slice(0, 80) || 'Untitled chat';
}

function readHead(file: string, bytes: number): string {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  }
}

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
