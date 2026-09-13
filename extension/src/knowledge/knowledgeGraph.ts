import type { KnowledgeConcept } from '../../../shared/activity-schema';
import conceptsJson from '../../../knowledge/concepts.json';
import rulesJson from '../../../knowledge/detection-rules.json';

export interface RequestDomain {
  id: string;
  keywords: string[];
  concepts: string[];
}

export interface DetectionRules {
  requestDomains: RequestDomain[];
  incidentalConcepts: { ids: string[]; relevanceCap: number };
  ignoredPaths: string[];
  ignoredFileNames: string[];
}

export class KnowledgeGraph {
  private readonly byId = new Map<string, KnowledgeConcept>();
  readonly rules: DetectionRules;

  constructor(concepts: KnowledgeConcept[] = conceptsJson as KnowledgeConcept[], rules: DetectionRules = rulesJson as unknown as DetectionRules) {
    for (const c of concepts) this.byId.set(c.id, c);
    this.rules = rules;
  }

  get(id: string): KnowledgeConcept | undefined {
    return this.byId.get(id);
  }

  all(): KnowledgeConcept[] {
    return [...this.byId.values()];
  }

  asRecord(): Record<string, KnowledgeConcept> {
    return Object.fromEntries(this.byId);
  }

  /** Transitive prerequisites, nearest first, without duplicates. */
  prerequisitesOf(id: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>([id]);
    const queue = [...(this.byId.get(id)?.prerequisites ?? [])];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      out.push(next);
      queue.push(...(this.byId.get(next)?.prerequisites ?? []));
    }
    return out;
  }

  /** Estimated minutes to learn a concept from its topics (fallback by depth). */
  minutesFor(id: string): number {
    const c = this.byId.get(id);
    if (!c) return 0;
    const sum = c.topics.reduce((n, t) => n + t.minutes, 0);
    if (sum) return sum;
    return c.depth === 'beginner' ? 15 : c.depth === 'intermediate' ? 30 : 45;
  }

  isIncidental(id: string): boolean {
    return this.rules.incidentalConcepts.ids.includes(id);
  }

  /** Domains whose keywords appear in the user's request. */
  domainsForRequest(request: string | undefined): RequestDomain[] {
    if (!request) return [];
    const lower = request.toLowerCase();
    return this.rules.requestDomains.filter((d) => d.keywords.some((k) => mentions(lower, k)));
  }
}

/** Whole-word match so "pr" does not match "prototype" and "test" does not match "latest". */
export function mentions(haystackLower: string, keyword: string): boolean {
  const k = keyword.toLowerCase().trim();
  if (!k) return false;
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}(s|es|ed|ing)?([^a-z0-9]|$)`, 'i').test(haystackLower);
}
