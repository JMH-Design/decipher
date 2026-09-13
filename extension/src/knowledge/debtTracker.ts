import type { BlindSpot, ConceptStatus, DetectedConcept, LearningProfile, ScoredConcept, SessionDebtSummary } from '../../../shared/activity-schema';
import type { KnowledgeGraph } from './knowledgeGraph';

/**
 * debt = novelty × depthWeight × relevance × SCALE, capped at 10.
 *
 *   novelty : 1.0 first exposure · 0.3 seen 2+ times · 0 learned
 *   depth   : beginner 1 · intermediate 2 · advanced 3
 *   relevance: 0.5–1.5 (central to the request → high)
 *
 * SCALE = 4 so the plan's worked example holds: GSAP, new, intermediate, central = 1×2×1×4 = 8.
 */
const SCALE = 4;
const DEPTH_WEIGHT = { beginner: 1, intermediate: 2, advanced: 3 } as const;
const REVIEW_MINUTES = 5;

export class DebtTracker {
  constructor(private readonly graph: KnowledgeGraph) {}

  score(detected: DetectedConcept, profile: LearningProfile): ScoredConcept | undefined {
    const concept = this.graph.get(detected.conceptId);
    if (!concept) return undefined;
    const entry = profile.concepts[concept.id];
    const status: ConceptStatus = entry?.status ?? 'new';
    const exposures = entry?.exposures ?? 0;
    const novelty = status === 'learned' ? 0 : exposures >= 2 ? 0.3 : 1;
    const depthWeight = DEPTH_WEIGHT[concept.depth];
    const relevance = detected.relevance;
    const debt = Math.min(10, Math.round(novelty * depthWeight * relevance * SCALE));
    const missingPrerequisites = this.graph.prerequisitesOf(concept.id).filter((p) => profile.concepts[p]?.status !== 'learned');
    const minutes = status === 'learned' ? 0 : novelty < 1 ? REVIEW_MINUTES : this.graph.minutesFor(concept.id);
    return { concept, detected, status, exposures, novelty, depthWeight, relevance, debt, minutes, missingPrerequisites };
  }

  summarize(conversationId: string, detected: DetectedConcept[], profile: LearningProfile, maxQueue = 5): SessionDebtSummary {
    const scored = detected.map((d) => this.score(d, profile)).filter((s): s is ScoredConcept => Boolean(s));
    const queue = scored
      .filter((s) => s.status !== 'learned')
      .sort((a, b) => b.debt - a.debt || b.relevance - a.relevance || a.concept.label.localeCompare(b.concept.label));
    const learned = scored.filter((s) => s.status === 'learned');
    const visible = queue.slice(0, maxQueue);
    return {
      conversationId,
      totalDebt: queue.reduce((n, s) => n + s.debt, 0),
      newConcepts: queue.filter((s) => s.novelty === 1).length,
      reviewConcepts: queue.filter((s) => s.novelty < 1).length,
      learnedConcepts: learned.length,
      // "~45 min to learn the essentials": the visible priority queue, not every incidental concept.
      estimatedMinutes: visible.reduce((n, s) => n + s.minutes, 0),
      queue: [...visible, ...learned.slice(0, 3)],
    };
  }

  /** Concepts the agent uses often that the user has never marked learned. */
  blindSpots(profile: LearningProfile, minExposures = 3, limit = 5): BlindSpot[] {
    return Object.entries(profile.concepts)
      .filter(([, e]) => e.status !== 'learned' && e.exposures >= minExposures)
      .map(([id, e]) => ({ concept: this.graph.get(id)!, exposures: e.exposures, status: e.status }))
      .filter((b) => b.concept)
      .sort((a, b) => b.exposures - a.exposures)
      .slice(0, limit);
  }

  /** Markdown export of a learning plan for a session. */
  toMarkdown(summary: SessionDebtSummary, userRequests: string[]): string {
    const lines: string[] = [];
    lines.push(`# Learning plan — ${new Date().toLocaleDateString()}`, '');
    if (userRequests.length) {
      lines.push('## What you asked the agent to do', '');
      for (const r of userRequests.slice(0, 5)) lines.push(`- ${r.split('\n')[0].slice(0, 160)}`);
      lines.push('');
    }
    lines.push(`**Knowledge debt:** ${summary.totalDebt} points · ${summary.newConcepts} new concepts · ~${summary.estimatedMinutes} min`, '');
    for (const [i, s] of summary.queue.filter((q) => q.status !== 'learned').entries()) {
      lines.push(`## ${i + 1}. ${s.concept.label} (${s.debt} pts · ~${s.minutes} min)`, '');
      lines.push(s.concept.plainSummary, '');
      if (s.concept.whyUsed) lines.push(`*Why the agent used it:* ${s.concept.whyUsed}`, '');
      const ev = s.detected.evidence.filter((e) => e.kind !== 'request').slice(0, 4);
      if (ev.length) lines.push(`*Seen in this session:* ${ev.map((e) => `${e.kind}: \`${e.detail}\`${e.file ? ` (${e.file.split('/').pop()})` : ''}`).join(', ')}`, '');
      if (s.missingPrerequisites.length) lines.push(`*Learn first:* ${s.missingPrerequisites.map((p) => this.graph.get(p)?.label ?? p).join(', ')}`, '');
      if (s.concept.topics.length) {
        lines.push('**Learn in order**', '');
        for (const t of s.concept.topics) lines.push(`- [ ] ${t.label} (${t.minutes} min)`);
        lines.push('');
      }
      if (s.concept.resources.length) {
        lines.push('**Resources**', '');
        for (const r of s.concept.resources) lines.push(`- ${r.title}${r.url ? ` — ${r.url}` : r.path ? ` — \`${r.path}\`` : ''}`);
        lines.push('');
      }
    }
    return lines.join('\n');
  }
}
