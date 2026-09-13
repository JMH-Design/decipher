import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConceptStatus, LearningProfile } from '../../../shared/activity-schema';

export function emptyProfile(): LearningProfile {
  return { version: 1, concepts: {}, totalDebtPaid: 0, sessionsReviewed: 0, termsExpanded: {}, countedConversations: [] };
}

/**
 * Local-only persistence for the user's learning profile.
 * Lives at `~/.cursor/projects/<slug>/decipher/profile.json`; never leaves the machine.
 */
export class ProfileStore {
  private profile: LearningProfile;
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<(p: LearningProfile) => void>();

  constructor(private readonly filePath: string) {
    this.profile = this.load();
  }

  get(): LearningProfile {
    return this.profile;
  }

  onChange(fn: (p: LearningProfile) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Record that these concepts appeared in a conversation (counted once per conversation). */
  recordExposures(conversationId: string, conceptIds: string[], when = new Date()): boolean {
    if (this.profile.countedConversations.includes(conversationId)) {
      // Still bump lastSeen and add any brand-new concepts, but do not inflate exposure counts.
      let changed = false;
      for (const id of conceptIds) {
        if (!this.profile.concepts[id]) {
          this.profile.concepts[id] = { exposures: 1, status: 'new', firstSeen: iso(when), lastSeen: iso(when) };
          changed = true;
        }
      }
      if (changed) this.save();
      return changed;
    }
    const day = iso(when);
    for (const id of conceptIds) {
      const entry = this.profile.concepts[id];
      if (entry) {
        entry.exposures += 1;
        entry.lastSeen = day;
      } else {
        this.profile.concepts[id] = { exposures: 1, status: 'new', firstSeen: day, lastSeen: day };
      }
    }
    if (conceptIds.length) {
      this.profile.countedConversations.push(conversationId);
      if (this.profile.countedConversations.length > 500) this.profile.countedConversations.splice(0, 100);
      this.profile.sessionsReviewed += 1;
    }
    this.save();
    return conceptIds.length > 0;
  }

  setStatus(conceptId: string, status: ConceptStatus, debtPaid = 0): void {
    const day = iso(new Date());
    const entry = this.profile.concepts[conceptId] ?? { exposures: 0, status: 'new', firstSeen: day, lastSeen: day };
    const wasLearned = entry.status === 'learned';
    entry.status = status;
    if (status === 'learned') {
      entry.learnedAt = day;
      if (!wasLearned) this.profile.totalDebtPaid += debtPaid;
    } else {
      delete entry.learnedAt;
      if (wasLearned) this.profile.totalDebtPaid = Math.max(0, this.profile.totalDebtPaid - debtPaid);
    }
    this.profile.concepts[conceptId] = entry;
    this.save();
  }

  recordTermExpanded(termId: string): void {
    this.profile.termsExpanded[termId] = (this.profile.termsExpanded[termId] ?? 0) + 1;
    this.save();
  }

  reset(): void {
    this.profile = emptyProfile();
    this.save(true);
  }

  private load(): LearningProfile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LearningProfile>;
      return { ...emptyProfile(), ...parsed, concepts: parsed.concepts ?? {}, termsExpanded: parsed.termsExpanded ?? {}, countedConversations: parsed.countedConversations ?? [] };
    } catch {
      return emptyProfile();
    }
  }

  private save(immediate = false): void {
    const write = () => {
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.profile, null, 2), 'utf8');
        fs.renameSync(tmp, this.filePath);
      } catch {
        /* best effort */
      }
      for (const fn of this.listeners) fn(this.profile);
    };
    if (immediate) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      write();
      return;
    }
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(write, 150);
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
