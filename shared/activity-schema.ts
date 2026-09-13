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
  /** 0–1. Below `LLM_FALLBACK_THRESHOLD` the LLM layer is consulted. */
  confidence: number;
  /** Set when the LLM layer rewrote the summary. */
  llmEnhanced?: boolean;
}

export const LLM_FALLBACK_THRESHOLD = 0.45;

// ---------------------------------------------------------------------------
// Knowledge Debt
// ---------------------------------------------------------------------------

export type Depth = 'beginner' | 'intermediate' | 'advanced';

export interface Topic {
  id: string;
  label: string;
  minutes: number;
}

export type ResourceType = 'explainer' | 'official' | 'tutorial' | 'video' | 'skill';

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

export type EvidenceKind =
  | 'import'
  | 'symbol'
  | 'package'
  | 'file'
  | 'skill'
  | 'command'
  | 'mcp'
  | 'request'
  | 'llm';

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

export type ConceptStatus = 'new' | 'learning' | 'learned';

export interface ConceptProfileEntry {
  exposures: number;
  status: ConceptStatus;
  firstSeen: string;
  lastSeen: string;
  learnedAt?: string;
}

export interface LearningProfile {
  version: 1;
  concepts: Record<string, ConceptProfileEntry>;
  /** Sum of debt points of concepts the user marked learned. */
  totalDebtPaid: number;
  sessionsReviewed: number;
  /** Glossary term id → times the user expanded it. Drives progressive de-duplication. */
  termsExpanded: Record<string, number>;
  /** Conversation ids whose exposures have already been counted. */
  countedConversations: string[];
}

export interface ScoredConcept {
  concept: KnowledgeConcept;
  detected: DetectedConcept;
  status: ConceptStatus;
  exposures: number;
  novelty: number;
  depthWeight: number;
  relevance: number;
  /** 0–10 */
  debt: number;
  /** Estimated minutes to close the gap. */
  minutes: number;
  /** Prerequisites the user has not learned yet. */
  missingPrerequisites: string[];
}

export interface SessionDebtSummary {
  conversationId: string;
  totalDebt: number;
  newConcepts: number;
  reviewConcepts: number;
  learnedConcepts: number;
  estimatedMinutes: number;
  /** Sorted by debt desc. */
  queue: ScoredConcept[];
}

export interface BlindSpot {
  concept: KnowledgeConcept;
  exposures: number;
  status: ConceptStatus;
}

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
  /** "Right now: …" / "This turn: …" */
  liveSummary: string;
  liveSummaryKind: 'now' | 'turn' | 'idle';
  debt: SessionDebtSummary | null;
  blindSpots: BlindSpot[];
  glossary: Record<string, GlossaryTerm>;
  concepts: Record<string, KnowledgeConcept>;
  profile: LearningProfile;
  mode: ExplainMode;
  hooksInstalled: boolean;
  llmAvailable: boolean;
  workspaceName: string;
}

// ---------------------------------------------------------------------------
// Webview <-> extension messages
// ---------------------------------------------------------------------------

export type ToWebviewMessage = { type: 'state'; state: SessionState } | { type: 'toast'; text: string };

export type FromWebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'selectConversation'; conversationId: string }
  | { type: 'setMode'; mode: ExplainMode }
  | { type: 'markConcept'; conceptId: string; status: ConceptStatus }
  | { type: 'markAllSeen' }
  | { type: 'termExpanded'; termId: string }
  | { type: 'openResource'; resource: Resource }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'askAgent'; conceptId: string }
  | { type: 'exportLearningPlan' }
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
