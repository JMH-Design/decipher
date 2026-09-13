import type { ExplainedStep, Turn } from '../../../shared/activity-schema';
import { LLM_FALLBACK_THRESHOLD } from '../../../shared/activity-schema';

/** Minimal provider abstraction so the summarizer can run without `vscode` (tests, CLI). */
export interface LlmProvider {
  available(): Promise<boolean>;
  /** Returns the completion text, or undefined when the model declined / failed. */
  complete(system: string, user: string, signal?: AbortSignal): Promise<string | undefined>;
}

export interface LlmSummarizerOptions {
  enabled: boolean;
  alwaysExplainInDepth: boolean;
}

export interface TurnSummaryInput {
  userRequest?: string;
  steps: ExplainedStep[];
  turnStatus: Turn['status'];
}

const SYSTEM_SUMMARY = `You explain what an AI coding agent did to a non-technical person.
Rules:
- Plain English. No jargon unless you define it in the same sentence.
- One or two sentences, max 45 words total. Past tense. Start with a verb.
- Describe outcomes ("searched for leftover references and found none"), not tools ("ran rg").
- Never invent results you were not given. If an outcome is unknown, describe the action only.
- Do not mention file paths longer than a file name. Do not use markdown.`;

/**
 * Layer 2 of the hybrid explainer. Templates run first and always; the LLM only rewrites
 * the turn-level summary when the turn is complex or a template had low confidence.
 */
export class LlmSummarizer {
  private readonly cache = new Map<string, string | undefined>();
  private availability: boolean | undefined;

  constructor(
    private readonly provider: LlmProvider,
    private options: LlmSummarizerOptions,
  ) {}

  setOptions(options: LlmSummarizerOptions): void {
    this.options = options;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.options.enabled) return false;
    if (this.availability === undefined) {
      try {
        this.availability = await this.provider.available();
      } catch {
        this.availability = false;
      }
    }
    return this.availability;
  }

  /** Plan trigger rules: 3+ distinct tool types in a turn, or a low-confidence template, or user opt-in. */
  shouldSummarize(input: TurnSummaryInput): boolean {
    if (!this.options.enabled || input.steps.length === 0) return false;
    if (this.options.alwaysExplainInDepth) return true;
    const distinctTools = new Set(input.steps.map((s) => s.toolName)).size;
    if (distinctTools >= 3) return true;
    return input.steps.some((s) => s.explanation.confidence < LLM_FALLBACK_THRESHOLD);
  }

  /** Cache key: the turn is stable once its step list stops growing. */
  private keyFor(conversationId: string, turnIndex: number, input: TurnSummaryInput): string {
    return `${conversationId}:${turnIndex}:${input.steps.length}:${input.turnStatus}`;
  }

  async summarizeTurn(conversationId: string, turnIndex: number, input: TurnSummaryInput, signal?: AbortSignal): Promise<string | undefined> {
    if (!(await this.isAvailable()) || !this.shouldSummarize(input)) return undefined;
    const key = this.keyFor(conversationId, turnIndex, input);
    if (this.cache.has(key)) return this.cache.get(key);

    const payload = {
      user_request: (input.userRequest ?? '').slice(0, 400),
      turn_status: input.turnStatus,
      steps: input.steps.slice(-40).map((s) => ({
        category: s.category,
        summary: s.explanation.summary.slice(0, 200),
        // Technical detail is limited to a short redacted string; never file contents.
        technical: s.explanation.technical.slice(0, 120),
        status: s.status,
      })),
    };
    const result = await this.safeComplete(SYSTEM_SUMMARY, JSON.stringify(payload), signal);
    const cleaned = result?.replace(/\s+/g, ' ').trim();
    const final = cleaned && cleaned.length > 10 && cleaned.length < 400 ? cleaned : undefined;
    this.cache.set(key, final);
    return final;
  }

  private async safeComplete(system: string, user: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      return await this.provider.complete(system, user, signal);
    } catch {
      return undefined;
    }
  }
}

export class NoopLlmProvider implements LlmProvider {
  async available(): Promise<boolean> {
    return false;
  }
  async complete(): Promise<string | undefined> {
    return undefined;
  }
}
