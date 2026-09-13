import type { Recommendation, RecommendationKind } from '../../../shared/activity-schema';
import catalogJson from '../../../recommendations/catalog.json';
import { mentions } from '../knowledge/knowledgeGraph';

export interface CatalogMatchRules {
  concepts?: string[];
  categories?: string[];
  keywords?: string[];
  packages?: string[];
}

export interface CatalogEntry {
  id: string;
  kind: RecommendationKind;
  title: string;
  summary: string;
  whyForYou: string;
  url?: string;
  match: CatalogMatchRules;
}

export interface CatalogQuery {
  /** The latest request. Weighted highest — it is what the user wants right now. */
  goal?: string;
  /** What the user asked for, across the whole conversation. */
  requests: string[];
  concepts: Array<{ id: string; category: string }>;
  packages: string[];
}

/**
 * A hit in the current goal outranks everything: naming "vercel" should surface Vercel even
 * though a dozen entries match the session's concepts. A keyword from an older request is the
 * loosest signal.
 */
const WEIGHT = { goalKeyword: 4, concept: 3, package: 3, category: 2, keyword: 2 } as const;

export class RecommendationCatalog {
  private readonly entries: CatalogEntry[];

  constructor(entries: CatalogEntry[] = (catalogJson as { entries: CatalogEntry[] }).entries) {
    this.entries = entries;
  }

  all(): CatalogEntry[] {
    return this.entries;
  }

  /** Entries relevant to this session, strongest match first. */
  match(query: CatalogQuery): Array<{ entry: CatalogEntry; score: number }> {
    const conceptIds = new Set(query.concepts.map((c) => c.id));
    const categories = new Set(query.concepts.map((c) => c.category));
    const packages = new Set(query.packages.map((p) => p.toLowerCase()));
    const requestText = query.requests.join('\n').toLowerCase();

    const goalText = (query.goal ?? '').toLowerCase();

    return this.entries
      .map((entry) => ({ entry, score: this.score(entry, conceptIds, categories, packages, requestText, goalText) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));
  }

  private score(entry: CatalogEntry, conceptIds: Set<string>, categories: Set<string>, packages: Set<string>, requestText: string, goalText: string): number {
    const m = entry.match;
    let score = 0;
    for (const id of m.concepts ?? []) if (conceptIds.has(id)) score += WEIGHT.concept;
    for (const cat of m.categories ?? []) if (categories.has(cat)) score += WEIGHT.category;
    for (const pkg of m.packages ?? []) if (packages.has(pkg.toLowerCase())) score += WEIGHT.package;
    for (const kw of m.keywords ?? []) {
      if (goalText && mentions(goalText, kw)) score += WEIGHT.goalKeyword;
      else if (requestText && mentions(requestText, kw)) score += WEIGHT.keyword;
    }
    return score;
  }
}

export function toRecommendation(entry: CatalogEntry): Recommendation {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    whyForYou: entry.whyForYou,
    url: entry.url,
    source: 'curated',
  };
}
