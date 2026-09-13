/**
 * Live web search through Context.dev.
 *
 * The extension host calls the REST API directly: MCP servers are scoped to the agent, so an
 * extension cannot invoke them. Requests carry a bearer token the user stores once in the
 * editor's secret storage; the key never touches the webview, settings JSON, or the repo.
 *
 * Docs: https://docs.context.dev/api-reference/web-scraping/web-search
 */

const ENDPOINT = 'https://api.context.dev/v1/web/search';
const MAX_QUERY_CHARS = 200;
const REQUEST_TIMEOUT_MS = 20_000;

export interface WebSearchResult {
  url: string;
  title: string;
  description: string;
  relevance: 'high' | 'medium' | 'low';
}

export type WebSearchFailure = 'no-key' | 'unauthorized' | 'quota' | 'rate-limit' | 'network' | 'bad-response';

export class WebSearchError extends Error {
  constructor(
    readonly reason: WebSearchFailure,
    message: string,
  ) {
    super(message);
    this.name = 'WebSearchError';
  }
}

export interface WebSearchClient {
  isConfigured(): Promise<boolean>;
  search(query: string, signal?: AbortSignal): Promise<WebSearchResult[]>;
}

export class ContextDevSearchClient implements WebSearchClient {
  constructor(private readonly getApiKey: () => Promise<string | undefined>) {}

  async isConfigured(): Promise<boolean> {
    return Boolean(await this.getApiKey());
  }

  async search(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new WebSearchError('no-key', 'No Context.dev API key stored.');

    const trimmed = sanitizeQuery(query);
    if (!trimmed) return [];

    // Pair the caller's signal with our own timeout so a hung request cannot stall a refresh.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed, timeoutMS: REQUEST_TIMEOUT_MS }),
        signal: controller.signal,
      });
      if (!res.ok) throw new WebSearchError(failureFor(res.status), `Context.dev search failed (HTTP ${res.status}).`);
      const json = (await res.json()) as { results?: unknown };
      if (!Array.isArray(json.results)) throw new WebSearchError('bad-response', 'Context.dev search returned no result list.');
      return json.results.map(toResult).filter((r): r is WebSearchResult => Boolean(r));
    } catch (err) {
      if (err instanceof WebSearchError) throw err;
      throw new WebSearchError('network', `Context.dev search could not be reached — ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function failureFor(status: number): WebSearchFailure {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'quota';
  if (status === 429) return 'rate-limit';
  return 'network';
}

function toResult(raw: unknown): WebSearchResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === 'string' ? r.url : undefined;
  const title = typeof r.title === 'string' ? r.title : undefined;
  if (!url || !title) return undefined;
  const relevance = r.relevance === 'high' || r.relevance === 'medium' || r.relevance === 'low' ? r.relevance : 'medium';
  return { url, title, description: typeof r.description === 'string' ? r.description : '', relevance };
}

/**
 * Queries are built from the user's own words, so strip anything that looks like a local path
 * or a credential before it leaves the machine, and keep it to a single short line.
 */
export function sanitizeQuery(query: string): string {
  return (
    query
      // Absolute, home-relative, and Windows paths.
      .replace(/(?:^|\s)(?:[A-Za-z]:[\\/]|~?\/)\S*/g, ' ')
      // Tails of paths that contained a space, e.g. "Secret Project/src/app.tsx".
      .replace(/\S*\/\S*\.[A-Za-z0-9]{1,6}\b/g, ' ')
      // Credential-shaped tokens.
      .replace(/\b(?:sk|ghp|gho|ghu|xoxb|xoxp|AKIA|ctxt)[-_][A-Za-z0-9_-]{8,}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_QUERY_CHARS)
  );
}

/** Stand-in used by tests and the dogfood CLI. */
export class NoopSearchClient implements WebSearchClient {
  async isConfigured(): Promise<boolean> {
    return false;
  }

  async search(): Promise<WebSearchResult[]> {
    throw new WebSearchError('no-key', 'Web search is disabled.');
  }
}
