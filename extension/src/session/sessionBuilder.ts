import * as fs from 'node:fs';
import type {
  ActivityStep,
  ConversationSummary,
  ExplainMode,
  ExplainedStep,
  HookEvent,
  SessionConcept,
  SessionResource,
  SessionState,
  StepCategory,
  Turn,
} from '../../../shared/activity-schema';
import type { LlmSummarizer } from '../explainer/llmSummarizer';
import type { TemplateEngine } from '../explainer/templateEngine';
import type { GlossaryService } from '../glossary/glossaryService';
import { ConceptDetector } from '../knowledge/conceptDetector';
import type { KnowledgeGraph } from '../knowledge/knowledgeGraph';
import { agentModelFromEvents } from '../loading/agentModel';
import { parseTranscript } from '../parser/transcriptParser';
import { firstProgram, splitShellCommand } from '../parser/shellParser';
import { listSubagentTranscripts, listTranscripts, type DecipherPaths } from '../paths';
import type { ResearchService } from '../research/researchService';
import { mergeHookEvents } from './hookMerger';

/** Enough resources to browse, few enough that the panel stays readable. */
const MAX_SESSION_RESOURCES = 30;

export interface SessionBuilderDeps {
  paths: DecipherPaths;
  workspaceName: string;
  engine: TemplateEngine;
  glossary: GlossaryService;
  graph: KnowledgeGraph;
  llm?: LlmSummarizer;
  research?: ResearchService;
}

interface LiveSummary {
  headline: string;
  text: string;
  kind: SessionState['liveSummaryKind'];
}

export interface BuildOptions {
  conversationId: string | null;
  mode: ExplainMode;
  hooksInstalled: boolean;
  llmAvailable: boolean;
  webSearchConfigured: boolean;
  loadingRotateMs: number;
}

/**
 * Turns raw inputs (transcript JSONL, subagent transcripts, hook events) into the single
 * `SessionState` object the webview renders. Rebuilt from scratch on every change — the inputs
 * are small and this keeps the pipeline deterministic.
 *
 * `build()` is synchronous and always sets `loadingPhase: 'parsing'`. The controller owns the
 * transition to `'ready'`, because only it knows whether the async LLM and research passes are
 * still outstanding.
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
    const { glossary, graph } = this.deps;
    const conversationId = opts.conversationId ?? this.pickActiveConversation();
    const base: SessionState = {
      conversationId,
      conversations: this.listConversations(),
      turns: [],
      steps: [],
      liveHeadline: 'Nothing to explain yet',
      liveSummary: 'Start a chat with the agent — I’ll explain everything here.',
      liveSummaryKind: 'idle',
      glossary: glossary.all(),
      concepts: graph.asRecord(),
      sessionConcepts: [],
      resources: [],
      recommendations: [],
      researchStatus: 'idle',
      webSearchConfigured: opts.webSearchConfigured,
      loadingPhase: 'parsing',
      loadingRotateMs: opts.loadingRotateMs,
      mode: opts.mode,
      hooksInstalled: opts.hooksInstalled,
      llmAvailable: opts.llmAvailable,
      workspaceName: this.deps.workspaceName,
    };
    if (!conversationId) return base;

    const { steps, turns, events } = this.loadConversation(conversationId);
    const userRequests = turns.map((t) => t.userRequest ?? '').filter(Boolean);

    const explained: ExplainedStep[] = steps.map((step) => {
      const turn = turns[step.turnIndex];
      const explanation = this.deps.engine.explain(step, turn?.userRequest);
      const conceptIds = this.detector.detectStep(step).map((d) => d.conceptId);
      return { ...step, explanation, conceptIds };
    });

    const sessionConcepts = this.detector
      .detectAll(steps, userRequests)
      .map((detected) => {
        const concept = graph.get(detected.conceptId);
        if (!concept) return undefined;
        const files = [...new Set(detected.evidence.map((e) => e.file).filter((f): f is string => Boolean(f)))];
        return { concept, detected, files } satisfies SessionConcept;
      })
      .filter((c): c is SessionConcept => Boolean(c));

    const { headline, text, kind } = this.liveSummary(conversationId, turns, explained);
    const research = this.deps.research?.latest(conversationId);

    return {
      ...base,
      conversationId,
      turns,
      steps: explained,
      liveHeadline: headline,
      liveSummary: text,
      liveSummaryKind: kind,
      sessionConcepts,
      resources: collectResources(sessionConcepts),
      goal: userRequests[userRequests.length - 1],
      recommendations: research?.recommendations ?? [],
      researchStatus: research?.status ?? 'idle',
      researchNote: research?.note,
      agentModel: agentModelFromEvents(events),
    };
  }

  /** Turns in the recent window that have not been through the LLM yet. */
  pendingLlmTurns(state: SessionState): number {
    if (!this.deps.llm || !state.conversationId) return 0;
    return this.recentTurns(state).filter((t) => !this.llmSummaries.has(this.llmKey(state, t))).length;
  }

  /** Kick off LLM turn summaries for complex turns; resolves true when a new summary landed. */
  async enhanceWithLlm(state: SessionState, signal?: AbortSignal): Promise<boolean> {
    const llm = this.deps.llm;
    if (!llm || !state.conversationId) return false;
    let changed = false;
    for (const turn of this.recentTurns(state)) {
      const key = this.llmKey(state, turn);
      if (this.llmSummaries.has(key)) continue;
      const steps = this.turnSteps(state, turn);
      const summary = await llm.summarizeTurn(state.conversationId, turn.index, { userRequest: turn.userRequest, steps, turnStatus: turn.status }, signal);
      // A superseded pass must not cache "no summary", or the turn never gets one.
      if (signal?.aborted) return changed;
      if (summary) {
        this.llmSummaries.set(key, summary);
        changed = true;
      } else this.llmSummaries.set(key, '');
    }
    return changed;
  }

  /** Research tools/MCPs for the current goal; resolves true when a fresh result landed. */
  async enhanceWithResearch(state: SessionState, signal?: AbortSignal): Promise<boolean> {
    const research = this.deps.research;
    if (!research || !state.conversationId || !research.shouldResearch(state)) return false;
    await research.run(
      {
        conversationId: state.conversationId,
        signature: research.signatureFor(state),
        goal: state.goal,
        requests: state.turns.map((t) => t.userRequest ?? '').filter(Boolean),
        concepts: state.sessionConcepts.map((c) => ({ id: c.concept.id, label: c.concept.label, category: c.concept.category })),
        packages: installedPackages(state.steps),
        mcpNamespaces: mcpNamespaces(state.steps),
      },
      signal,
    );
    return true;
  }

  llmSummaryFor(conversationId: string, turn: Turn, stepCount: number): string | undefined {
    return this.llmSummaries.get(`${conversationId}:${turn.index}:${stepCount}`) || undefined;
  }

  // ---------------------------------------------------------------------------

  /** Only the last two turns — earlier ones are stable and rarely looked at. */
  private recentTurns(state: SessionState): Turn[] {
    return state.turns.slice(-2).filter((t) => t.status !== 'active');
  }

  private turnSteps(state: SessionState, turn: Turn): ExplainedStep[] {
    return state.steps.filter((s) => s.turnIndex === turn.index && !s.subagentId);
  }

  private llmKey(state: SessionState, turn: Turn): string {
    return `${state.conversationId}:${turn.index}:${this.turnSteps(state, turn).length}`;
  }

  private loadConversation(conversationId: string): { steps: ActivityStep[]; turns: Turn[]; events: HookEvent[] } {
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
    return { steps, turns, events };
  }

  /**
   * The recap shown once the loader lifts: a headline of what the turn amounted to, and a
   * paragraph explaining it. While the turn is still running this describes the current step —
   * only the overlay sees that, but it keeps the recap from being empty mid-turn.
   */
  private liveSummary(conversationId: string, turns: Turn[], steps: ExplainedStep[]): LiveSummary {
    const last = turns[turns.length - 1];
    if (!last) return { headline: 'No agent activity in this chat yet.', text: 'Ask the agent for something and every step will be explained here.', kind: 'idle' };
    const turnSteps = steps.filter((s) => s.turnIndex === last.index && !s.subagentId);

    if (last.status === 'active') {
      const current = [...turnSteps].reverse().find((s) => s.status === 'running') ?? turnSteps[turnSteps.length - 1];
      if (!current) return { headline: 'Thinking about your request', text: 'The agent has not taken an action yet.', kind: 'now' };
      return { headline: current.explanation.title, text: current.explanation.summary, kind: 'now' };
    }

    const headline = turnSteps.length ? composeTurn(turnSteps) : last.finalResponse ? 'Answered without changing anything.' : 'No actions were taken.';
    const llm = this.llmSummaryFor(conversationId, last, turnSteps.length);
    return { headline, text: llm ?? composeTurnRecap(last, turnSteps), kind: 'turn' };
  }
}

/** Every resource across the session's concepts, de-duplicated, most relevant concept first. */
export function collectResources(sessionConcepts: SessionConcept[]): SessionResource[] {
  const out: SessionResource[] = [];
  const seen = new Set<string>();
  for (const { concept } of sessionConcepts) {
    for (const resource of concept.resources) {
      const key = (resource.url ?? resource.path ?? resource.title).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ resource, conceptId: concept.id, conceptLabel: concept.label });
      if (out.length >= MAX_SESSION_RESOURCES) return out;
    }
  }
  return out;
}

/** Packages the agent installed in this session, as a signal for recommendations. */
export function installedPackages(steps: ExplainedStep[]): string[] {
  const found = new Set<string>();
  for (const step of steps) {
    if (step.toolName !== 'Shell') continue;
    for (const segment of splitShellCommand(String(step.input.command ?? ''))) {
      const { program, args } = firstProgram(segment);
      if (!['npm', 'pnpm', 'yarn', 'bun'].includes(program)) continue;
      const positional = args.filter((a) => !a.startsWith('-'));
      if (!['install', 'i', 'add'].includes(positional[0] ?? '')) continue;
      for (const pkg of positional.slice(1)) found.add(pkg.replace(/@[\^~]?[\d.]+$/, ''));
    }
  }
  return [...found];
}

/** MCP servers the agent reached for, so research can suggest complementary ones. */
export function mcpNamespaces(steps: ExplainedStep[]): string[] {
  const found = new Set<string>();
  for (const step of steps) {
    if (!['CallDynamicTool', 'GetDynamicTools', 'FetchMcpResource'].includes(step.toolName)) continue;
    const ns = String(step.input.namespace ?? step.input.server ?? '').trim();
    if (ns) found.add(ns);
  }
  return [...found];
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

/**
 * The recap paragraph when no language model wrote one. The headline already carries the
 * counts, so this explains the consequences instead: what changed, what broke, how it ended.
 */
export function composeTurnRecap(turn: Turn, steps: ExplainedStep[]): string {
  if (!steps.length) {
    return turn.finalResponse
      ? `The agent answered from what it already knew, without touching your project. It said: “${firstSentence(turn.finalResponse)}”`
      : 'The agent took no actions, so nothing in your project changed.';
  }

  const parts: string[] = [];
  if (turn.status === 'error') parts.push('Something went wrong partway through, so the work may be unfinished.');
  else if (turn.status === 'aborted') parts.push('The turn was stopped early, so some of the steps never ran.');

  const edited = [...new Set(steps.filter((s) => s.category === 'editing' && typeof s.input.path === 'string').map((s) => basename(String(s.input.path))))];
  if (edited.length) {
    const shown = edited.slice(0, 4);
    const extra = edited.length - shown.length;
    parts.push(`It changed ${joinList(shown)}${extra ? `, and ${extra} more ${extra === 1 ? 'file' : 'files'}` : ''}.`);
  } else if (!steps.some((s) => MUTATING_CATEGORIES.includes(s.category))) {
    parts.push('Nothing in your project was changed — this turn only looked around.');
  }

  const failed = steps.filter((s) => s.status === 'error').length;
  if (failed && turn.status !== 'error') parts.push(`${failed === 1 ? 'One step' : `${failed} steps`} failed along the way, and the agent carried on.`);

  if (turn.finalResponse) parts.push(`It finished by telling you: “${firstSentence(turn.finalResponse)}”`);
  else if (!parts.length) parts.push('The agent finished without a closing note.');

  return parts.join(' ');
}

/** Categories that can leave something behind on disk, in git, or on another machine. */
const MUTATING_CATEGORIES: StepCategory[] = ['editing', 'running', 'saving'];

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function firstSentence(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
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
