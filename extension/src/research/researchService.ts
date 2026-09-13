import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Recommendation, RecommendationKind, ResearchResult, ResearchStatus, SessionState } from '../../../shared/activity-schema';
import type { LlmProvider } from '../explainer/llmSummarizer';
import { RecommendationCatalog, toRecommendation } from './catalog';
import { WebSearchError, type WebSearchClient, type WebSearchResult } from './webSearchClient';

const KINDS: RecommendationKind[] = ['tool', 'mcp', 'kit', 'service', 'course'];

const SYSTEM_RECOMMEND = `You recommend tools, MCP servers, starter kits, services, and courses that would help someone build what they described — either with better quality or with less effort.
Return ONLY a JSON array, no prose and no code fence. Each item:
{"kind":"tool|mcp|kit|service|course","title":"…","summary":"…","whyForYou":"…","url":"…"}
- title: the product name, at most 6 words.
- summary: what it is, one plain-English sentence, no jargon.
- whyForYou: one sentence completing "Worth a look because …" — start lowercase, tie it to THIS person's goal.
- url: the official homepage or docs. Omit the field entirely if you are not certain. Never invent a URL.
Rules: return 2 to 5 items, most useful first. Do not repeat anything in "alreadySuggested". Prefer well-known, actively maintained options. Never recommend something purely because it is trendy.`;

export interface ResearchOptions {
  enabled: boolean;
  webSearch: boolean;
  /** `auto` re-researches after every turn; `manual` waits for the user to ask. */
  trigger: 'auto' | 'manual';
  maxResults: number;
}

export interface ResearchDeps {
  catalog: RecommendationCatalog;
  provider?: LlmProvider;
  search?: WebSearchClient;
  /** Directory for per-conversation cache files. */
  cacheDir: string;
  options: ResearchOptions;
  log?: (message: string) => void;
}

export interface ResearchInput {
  conversationId: string;
  signature: string;
  goal?: string;
  requests: string[];
  concepts: Array<{ id: string; label: string; category: string }>;
  packages: string[];
  /** MCP servers already in use, so the model does not suggest what the user has. */
  mcpNamespaces: string[];
}

/**
 * Turns "what you asked for" into "things that could help you do it better".
 *
 * Three layers, cheapest first: a curated catalog matched on concepts and request keywords,
 * live web search for current options, then the language model to merge both into plain-English
 * suggestions. Any layer can fail; the ones that succeed still produce a useful answer.
 *
 * Results are cached per turn so a burst of file-watch events cannot trigger repeated searches.
 */
export class ResearchService {
  private readonly memory = new Map<string, ResearchResult>();
  /** Conversations the user explicitly asked to re-research; consumed by the next run. */
  private readonly forced = new Set<string>();

  constructor(private readonly deps: ResearchDeps) {}

  /** Queue a one-off run, whichever trigger mode is configured. */
  requestNow(conversationId: string): void {
    this.forced.add(conversationId);
    this.invalidate(conversationId);
  }

  /** Identifies a turn's worth of activity: research is re-run only when this changes. */
  signatureFor(state: SessionState): string {
    const lastTurn = state.turns[state.turns.length - 1];
    const steps = state.steps.filter((s) => !s.subagentId).length;
    return `${state.conversationId ?? 'none'}:${lastTurn?.index ?? -1}:${steps}`;
  }

  /** Research runs once a turn has finished, so suggestions reflect a complete request. */
  shouldResearch(state: SessionState): boolean {
    if (!this.deps.options.enabled || !state.conversationId) return false;
    if (this.deps.options.trigger === 'manual' && !this.forced.has(state.conversationId)) return false;
    const lastTurn = state.turns[state.turns.length - 1];
    if (!lastTurn || lastTurn.status === 'active') return false;
    if (!state.sessionConcepts.length && !state.turns.some((t) => t.userRequest)) return false;
    return !this.cached(state.conversationId, this.signatureFor(state));
  }

  cached(conversationId: string, signature: string): ResearchResult | undefined {
    const hit = this.memory.get(conversationId);
    if (hit) return hit.signature === signature ? hit : undefined;
    const fromDisk = this.readCache(conversationId);
    if (fromDisk) {
      this.memory.set(conversationId, fromDisk);
      if (fromDisk.signature === signature) return fromDisk;
    }
    return undefined;
  }

  /** Newest cached result for a conversation, even if the signature has moved on. */
  latest(conversationId: string): ResearchResult | undefined {
    return this.memory.get(conversationId) ?? this.readCache(conversationId);
  }

  /** Drop the cached result so the next build re-runs research. */
  invalidate(conversationId: string): void {
    this.memory.delete(conversationId);
    try {
      fs.rmSync(this.cacheFile(conversationId), { force: true });
    } catch {
      /* nothing cached */
    }
  }

  /**
   * Always resolves with a result, and always caches it. The caller re-runs whenever the cache
   * misses, so a thrown error here would loop forever.
   */
  async run(input: ResearchInput, signal?: AbortSignal): Promise<ResearchResult> {
    try {
      const result = await this.compute(input, signal);
      // Superseded by a newer refresh: leave the cache untouched so the new pass redoes the
      // work, rather than storing a half-finished result as if it were final.
      if (signal?.aborted) return result;
      this.memory.set(input.conversationId, result);
      this.forced.delete(input.conversationId);
      this.writeCache(result);
      return result;
    } catch (err) {
      if (signal?.aborted) throw err;
      this.deps.log?.(`research: failed — ${(err as Error).message}`);
      const result: ResearchResult = {
        conversationId: input.conversationId,
        signature: input.signature,
        goal: input.goal,
        recommendations: [],
        status: 'error',
        note: 'Decipher could not put together suggestions for this turn. Try Refresh.',
        generatedAt: new Date().toISOString(),
      };
      // Cached in memory only, so restarting the editor retries.
      this.memory.set(input.conversationId, result);
      this.forced.delete(input.conversationId);
      return result;
    }
  }

  private async compute(input: ResearchInput, signal?: AbortSignal): Promise<ResearchResult> {
    const curated = this.deps.catalog.match(input).map((m) => toRecommendation(m.entry));
    const notes: string[] = [];
    let snippets: WebSearchResult[] = [];
    let researched: Recommendation[] = [];

    if (this.deps.options.webSearch && this.deps.search) {
      try {
        snippets = await this.gatherSnippets(input, signal);
      } catch (err) {
        notes.push(searchNote(err));
      }
    } else if (this.deps.options.webSearch) {
      notes.push('Web search is not set up yet, so these come from Decipher’s built-in list.');
    }

    if (this.deps.provider) {
      try {
        researched = await this.synthesize(input, curated, snippets, signal);
      } catch (err) {
        this.deps.log?.(`research: model synthesis failed — ${(err as Error).message}`);
        notes.push('The language model could not be reached, so these come from Decipher’s built-in list.');
      }
    } else {
      notes.push('No language model available, so these come from Decipher’s built-in list.');
    }

    const recommendations = mergeRecommendations(curated, researched, this.deps.options.maxResults);
    const status: ResearchStatus = recommendations.length ? 'ready' : 'unavailable';
    return {
      conversationId: input.conversationId,
      signature: input.signature,
      goal: input.goal,
      recommendations,
      status,
      note: notes.length ? notes[0] : undefined,
      generatedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------

  /** Two queries at most: one for the stated goal, one for the technologies in play. */
  private async gatherSnippets(input: ResearchInput, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const search = this.deps.search!;
    const conceptLabels = input.concepts.slice(0, 4).map((c) => c.label);
    const queries: string[] = [];
    if (input.goal) queries.push(`best tools and MCP servers to ${goalPhrase(input.goal)}`);
    if (conceptLabels.length) queries.push(`recommended libraries and tools for ${conceptLabels.join(', ')}`);
    if (!queries.length) return [];

    const batches = await Promise.all(
      queries.map(async (q) => {
        try {
          return await search.search(q, signal);
        } catch (err) {
          // One failed query should not lose the other's results; surface only a hard auth error.
          if (err instanceof WebSearchError && (err.reason === 'no-key' || err.reason === 'unauthorized')) throw err;
          this.deps.log?.(`research: search "${q}" failed — ${(err as Error).message}`);
          return [] as WebSearchResult[];
        }
      }),
    );
    const seen = new Set<string>();
    return batches
      .flat()
      .filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)))
      .slice(0, 12);
  }

  private async synthesize(input: ResearchInput, curated: Recommendation[], snippets: WebSearchResult[], signal?: AbortSignal): Promise<Recommendation[]> {
    const payload = {
      goal: (input.goal ?? '').slice(0, 500),
      also_asked_for: input.requests.slice(-4, -1).map((r) => r.split('\n')[0].slice(0, 160)),
      technologies_in_use: input.concepts.slice(0, 10).map((c) => c.label),
      packages: input.packages.slice(0, 10),
      mcp_servers_in_use: input.mcpNamespaces.slice(0, 10),
      alreadySuggested: curated.map((c) => c.title),
      searchResults: snippets.map((s) => ({ title: s.title, url: s.url, description: s.description.slice(0, 260) })),
    };
    const text = await this.deps.provider!.complete(SYSTEM_RECOMMEND, JSON.stringify(payload, null, 2), signal);
    return text ? parseRecommendations(text) : [];
  }

  private cacheFile(conversationId: string): string {
    return path.join(this.deps.cacheDir, `${conversationId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  }

  private readCache(conversationId: string): ResearchResult | undefined {
    try {
      const raw = fs.readFileSync(this.cacheFile(conversationId), 'utf8');
      const parsed = JSON.parse(raw) as ResearchResult;
      return Array.isArray(parsed.recommendations) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private writeCache(result: ResearchResult): void {
    try {
      fs.mkdirSync(this.deps.cacheDir, { recursive: true });
      fs.writeFileSync(this.cacheFile(result.conversationId), JSON.stringify(result, null, 2), 'utf8');
    } catch (err) {
      this.deps.log?.(`research: could not cache result — ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Keep room for both sources so a well-matched catalog never crowds out live findings,
 * then backfill from whichever list has more to give.
 */
export function mergeRecommendations(curated: Recommendation[], researched: Recommendation[], max: number): Recommendation[] {
  const out: Recommendation[] = [];
  const seen = new Set<string>();
  const take = (list: Recommendation[], limit: number) => {
    for (const rec of list) {
      if (out.length >= max || limit <= 0) return;
      const key = dedupeKey(rec);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rec);
      limit--;
    }
  };
  const half = Math.max(1, Math.floor(max / 2));
  take(curated, half);
  take(researched, max - out.length);
  take(curated, max - out.length);
  return out;
}

function dedupeKey(rec: Recommendation): string {
  const host = rec.url ? safeHost(rec.url) : '';
  return host || rec.title.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Trim the request down to something that reads well inside a search query. */
export function goalPhrase(goal: string): string {
  return goal
    .split('\n')
    .find((l) => l.trim())
    ?.replace(/^(?:please\s+|can you\s+|i want to\s+|help me\s+)/i, '')
    .trim()
    .slice(0, 120) ?? '';
}

/** Models sometimes wrap JSON in prose or a fence; recover the array and validate every field. */
export function parseRecommendations(text: string): Recommendation[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const out: Recommendation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = str(r.title);
    const summary = str(r.summary);
    if (!title || !summary) continue;
    const url = str(r.url);
    out.push({
      id: `researched:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      kind: KINDS.includes(r.kind as RecommendationKind) ? (r.kind as RecommendationKind) : 'tool',
      title: title.slice(0, 60),
      summary: summary.slice(0, 240),
      whyForYou: str(r.whyForYou)?.slice(0, 240) ?? 'it fits what you are building.',
      url: url && /^https?:\/\//.test(url) ? url : undefined,
      source: 'researched',
    });
    if (out.length >= 5) break;
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function searchNote(err: unknown): string {
  if (err instanceof WebSearchError) {
    switch (err.reason) {
      case 'no-key':
        return 'Add a Context.dev API key to search the live web for newer tools.';
      case 'unauthorized':
        return 'Your Context.dev API key was rejected — check it in Decipher’s settings.';
      case 'quota':
        return 'Your Context.dev plan has no search credits left, so these come from the built-in list.';
      case 'rate-limit':
        return 'Context.dev is rate-limiting requests; try refreshing in a minute.';
      default:
        return 'Live web search could not be reached, so these come from Decipher’s built-in list.';
    }
  }
  return 'Live web search failed, so these come from Decipher’s built-in list.';
}
