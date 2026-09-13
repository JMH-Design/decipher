/**
 * Shared types for Decipher.
 *
 * These are imported by the extension host, the webview, and the dogfood CLI.
 * Keep this file free of runtime dependencies (types + tiny pure helpers only).
 */

// ---------------------------------------------------------------------------
// Activity steps (what the agent did)
// ---------------------------------------------------------------------------

export type StepCategory =
  | 'reading'
  | 'searching'
  | 'editing'
  | 'running'
  | 'checking'
  | 'saving'
  | 'asking'
  | 'planning'
  | 'delegating'
  | 'external'
  | 'browsing'
  | 'thinking'
  | 'other';

export type StepStatus = 'running' | 'done' | 'error';

export type StepSource = 'transcript' | 'hook';

export interface ActivityStep {
  /** Stable id: `${conversationId}:${index}` for transcript steps, hook tool_use_id when known. */
  id: string;
  conversationId: string;
  /** Zero-based turn (one user message + agent response). */
  turnIndex: number;
  /** Monotonic sequence within the conversation. */
  index: number;
  timestamp?: number;
  toolName: string;
  category: StepCategory;
  input: Record<string, unknown>;
  /** Raw tool output when captured by hooks (transcripts do not store it). */
  output?: string;
  durationMs?: number;
  status: StepStatus;
  errorMessage?: string;
  /** Assistant prose that preceded the tool call in the same message. */
  narration?: string;
  source: StepSource;
  /** Populated for steps that came from a subagent transcript. */
  subagentId?: string;
  parentStepId?: string;
}

export type TurnStatus = 'active' | 'success' | 'error' | 'aborted';

export interface Turn {
  index: number;
  userRequest?: string;
  timestamp?: number;
  status: TurnStatus;
  /** Final assistant prose for this turn (if any). */
  finalResponse?: string;
  stepIds: string[];
}

// ---------------------------------------------------------------------------
// Explanations (plain-language layer)
// ---------------------------------------------------------------------------

export interface GlossaryTerm {
  id: string;
  term: string;
  aliases?: string[];
  definition: string;
  analogy?: string;
  category: string;
}

export interface Explanation {
  /** Short label, e.g. "Searching the project". */
  title: string;
  /** One sentence, e.g. "Looked for any leftover 'home-field' references." */
  summary: string;
  /** 1–3 sentences in plain language. */
  whatHappened: string;
  /** The raw technical version (command, path, pattern). */
  technical: string;
  whyItMatters?: string;
  /** Glossary ids referenced by this explanation. */
  vocabulary: string[];
  /** Chained shell commands produce one sub-explanation per segment. */
  subSteps?: Explanation[];
  templateId: string;
  /** 0–1. Below `LLM_FALLBACK_THRESHOLD` the template is treated as a weak explanation. */
  confidence: number;
  /** Set when the LLM layer rewrote the summary. */
  llmEnhanced?: boolean;
}

export const LLM_FALLBACK_THRESHOLD = 0.45;

// ---------------------------------------------------------------------------
// Learning catalog (the concepts the agent used, and how to learn them)
// ---------------------------------------------------------------------------

export type Depth = 'beginner' | 'intermediate' | 'advanced';

export interface Topic {
  id: string;
  label: string;
  minutes: number;
}

export type ResourceType = 'explainer' | 'official' | 'tutorial' | 'video' | 'course' | 'workshop' | 'skill';

export interface Resource {
  type: ResourceType;
  title: string;
  url?: string;
  /** Local path (skills). `~` is expanded by the extension. */
  path?: string;
}

export interface ConceptDetection {
  imports?: string[];
  symbols?: string[];
  packages?: string[];
  fileExtensions?: string[];
  fileNames?: string[];
  commands?: string[];
  skillPaths?: string[];
  mcpNamespaces?: string[];
  keywords?: string[];
}

export interface KnowledgeConcept {
  id: string;
  label: string;
  plainSummary: string;
  whyUsed?: string;
  depth: Depth;
  category: string;
  prerequisites: string[];
  topics: Topic[];
  resources: Resource[];
  detection: ConceptDetection;
}

export type EvidenceKind = 'import' | 'symbol' | 'package' | 'file' | 'skill' | 'command' | 'mcp' | 'request' | 'llm';

export interface Evidence {
  kind: EvidenceKind;
  detail: string;
  stepId: string;
  file?: string;
  line?: number;
}

export interface DetectedConcept {
  conceptId: string;
  evidence: Evidence[];
  /** 0.5–1.5. Central to the user's request → high. Incidental → low. */
  relevance: number;
}

/** A concept the agent used in this chat, resolved against the catalog. */
export interface SessionConcept {
  concept: KnowledgeConcept;
  detected: DetectedConcept;
  /** Files the concept showed up in, for "Used in". */
  files: string[];
}

/** One learning resource, tagged with the concept it came from. */
export interface SessionResource {
  resource: Resource;
  conceptId: string;
  conceptLabel: string;
}

// ---------------------------------------------------------------------------
// Improvement recommendations (tools/MCPs/kits that could help the user)
// ---------------------------------------------------------------------------

export type RecommendationKind = 'tool' | 'mcp' | 'kit' | 'service' | 'course';

export interface Recommendation {
  id: string;
  kind: RecommendationKind;
  title: string;
  /** Plain English, 1–2 sentences. */
  summary: string;
  /** Tied to what the user actually asked for. */
  whyForYou: string;
  url?: string;
  source: 'curated' | 'researched';
}

export type ResearchStatus = 'idle' | 'ready' | 'unavailable' | 'error';

export interface ResearchResult {
  conversationId: string;
  /** Cache key: conversation + last turn + step count. */
  signature: string;
  goal?: string;
  recommendations: Recommendation[];
  status: ResearchStatus;
  /** Why the result is thin (no API key, model unavailable, request failed). */
  note?: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * The webview builds its cards underneath a full-content loader and only reveals them once
 * every stage is done, so the user never reads a half-built panel.
 *
 * `working` means the agent's own turn is still running; `parsing` and `research` mean the turn
 * has finished but Decipher is still writing its recap or looking for tools.
 */
export type LoadingPhase = 'boot' | 'working' | 'parsing' | 'research' | 'ready';

// ---------------------------------------------------------------------------
// Composite state sent to the webview
// ---------------------------------------------------------------------------

export interface ExplainedStep extends ActivityStep {
  explanation: Explanation;
  conceptIds: string[];
}

export type ExplainMode = 'beginner' | 'intermediate' | 'advanced';

export interface ConversationSummary {
  id: string;
  title: string;
  lastModified: number;
  stepCount: number;
}

export interface SessionState {
  conversationId: string | null;
  conversations: ConversationSummary[];
  turns: Turn[];
  steps: ExplainedStep[];
  /** One-line outcome for the recap: "Read 18 files, edited 3 files, and ran 2 commands." */
  liveHeadline: string;
  /** The explanatory paragraph under the headline: what was asked, what happened, the outcome. */
  liveSummary: string;
  liveSummaryKind: 'now' | 'turn' | 'idle';
  glossary: Record<string, GlossaryTerm>;
  concepts: Record<string, KnowledgeConcept>;
  /** Concepts detected in this chat, most relevant first. */
  sessionConcepts: SessionConcept[];
  /** De-duplicated learning resources merged across `sessionConcepts`. */
  resources: SessionResource[];
  /** What the user asked for, in their own words (latest non-empty request). */
  goal?: string;
  recommendations: Recommendation[];
  researchStatus: ResearchStatus;
  researchNote?: string;
  /** False until a Context.dev key is stored, so the UI can prompt for setup. */
  webSearchConfigured: boolean;
  loadingPhase: LoadingPhase;
  /** Model powering the user's agent chat. Drives the loading phrases. */
  agentModel?: string;
  /** How often the loading phrase rotates, in milliseconds. */
  loadingRotateMs: number;
  mode: ExplainMode;
  hooksInstalled: boolean;
  llmAvailable: boolean;
  workspaceName: string;
}

// ---------------------------------------------------------------------------
// Webview <-> extension messages
// ---------------------------------------------------------------------------

export type ToWebviewMessage =
  | { type: 'state'; state: SessionState }
  | { type: 'toast'; text: string }
  | { type: 'viewVisible' }
  | { type: 'viewHidden' };

export type FromWebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'selectConversation'; conversationId: string }
  | { type: 'setMode'; mode: ExplainMode }
  | { type: 'openResource'; resource: Resource }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'researchNow' }
  | { type: 'configureWebSearch' }
  | { type: 'exportResourceSheet' }
  | { type: 'installHooks' };

// ---------------------------------------------------------------------------
// Hook events (written by the plugin, read by the extension)
// ---------------------------------------------------------------------------

export interface HookEvent {
  /** ISO timestamp written by the hook script. */
  ts: string;
  hook: string;
  conversationId: string;
  generationId?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  command?: string;
  output?: string;
  filePath?: string;
  edits?: Array<{ old_string?: string; new_string?: string }>;
  durationMs?: number;
  status?: string;
  errorMessage?: string;
  prompt?: string;
  text?: string;
  modifiedFiles?: string[];
  subagentType?: string;
  summary?: string;
  /** Display name of the model driving the agent, when Cursor reports it. */
  model?: string;
  modelId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cursor stores per-project data under `~/.cursor/projects/<slug>/` where the slug is the
 * absolute workspace path with every non-alphanumeric character replaced by `-`.
 * `/Users/jane/My Site` → `Users-jane-My-Site`.
 */
export function workspaceSlug(workspacePath: string): string {
  return workspacePath.replace(/^[\\/]+/, '').replace(/[^A-Za-z0-9]/g, '-');
}
