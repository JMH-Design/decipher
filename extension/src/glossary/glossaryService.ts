import type { GlossaryTerm } from '../../../shared/activity-schema';
import rawTerms from '../../../glossary/terms.json';

/** Times a user must expand a term before it is considered "familiar" and de-emphasized. */
export const FAMILIAR_AFTER_EXPANSIONS = 3;

export class GlossaryService {
  private readonly byId = new Map<string, GlossaryTerm>();
  /** lower-cased alias → id */
  private readonly aliasIndex = new Map<string, string>();
  /** Aliases sorted longest-first so "git status" wins over "git". */
  private readonly aliasesSorted: string[];

  constructor(terms: GlossaryTerm[] = rawTerms as GlossaryTerm[]) {
    for (const t of terms) {
      this.byId.set(t.id, t);
      for (const alias of [t.term, ...(t.aliases ?? [])]) {
        const key = alias.trim().toLowerCase();
        if (key.length >= 2 && !this.aliasIndex.has(key)) this.aliasIndex.set(key, t.id);
      }
    }
    this.aliasesSorted = [...this.aliasIndex.keys()].sort((a, b) => b.length - a.length);
  }

  get(id: string): GlossaryTerm | undefined {
    return this.byId.get(id);
  }

  all(): Record<string, GlossaryTerm> {
    return Object.fromEntries(this.byId);
  }

  resolve(ids: string[]): GlossaryTerm[] {
    return ids.map((id) => this.byId.get(id)).filter((t): t is GlossaryTerm => Boolean(t));
  }

  /**
   * Find glossary terms mentioned in a technical string (a command, a path, a pattern).
   * Word-boundary aware for alphanumeric aliases; symbol aliases (`&&`, `??`) match literally.
   */
  detect(text: string, limit = 6): string[] {
    const lower = text.toLowerCase();
    const found: string[] = [];
    for (const alias of this.aliasesSorted) {
      if (found.length >= limit) break;
      const id = this.aliasIndex.get(alias)!;
      if (found.includes(id)) continue;
      if (this.matches(lower, alias)) found.push(id);
    }
    return found;
  }

  private matches(haystack: string, alias: string): boolean {
    const idx = haystack.indexOf(alias);
    if (idx < 0) return false;
    const alnum = /^[a-z0-9]/.test(alias) && /[a-z0-9]$/.test(alias);
    if (!alnum) return true;
    const before = haystack[idx - 1];
    const after = haystack[idx + alias.length];
    const boundary = (c: string | undefined) => c === undefined || !/[a-z0-9_]/.test(c);
    return boundary(before) && boundary(after);
  }

  /** Progressive de-duplication: which of these terms has the user already learned well? */
  partitionByFamiliarity(ids: string[], termsExpanded: Record<string, number>): { fresh: string[]; familiar: string[] } {
    const fresh: string[] = [];
    const familiar: string[] = [];
    for (const id of ids) ((termsExpanded[id] ?? 0) >= FAMILIAR_AFTER_EXPANSIONS ? familiar : fresh).push(id);
    return { fresh, familiar };
  }
}
