import type { SessionState } from '../../../shared/activity-schema';

/**
 * A take-away Markdown summary of one chat: what you asked for, what the agent did, the
 * concepts behind it with links, and the tools that could make the next attempt easier.
 */
export function resourceSheetMarkdown(state: SessionState): string {
  const lines: string[] = ['# Lumen — what to learn and what could help', ''];

  const requests = state.turns.map((t) => t.userRequest).filter((r): r is string => Boolean(r));
  if (requests.length) {
    lines.push('## What you asked for', '');
    for (const request of requests.slice(-5)) lines.push(`- ${firstLine(request, 200)}`);
    lines.push('');
  }

  lines.push('## What happened', '', `**${state.liveHeadline}**`, '', state.liveSummary, '');

  if (state.sessionConcepts.length) {
    lines.push('## Concepts the agent used', '');
    for (const { concept, files } of state.sessionConcepts) {
      lines.push(`### ${concept.label}`, '', concept.plainSummary, '');
      if (concept.whyUsed) lines.push(`Why it came up: ${concept.whyUsed}`, '');
      if (files.length) lines.push(`Seen in: ${files.map((f) => `\`${basename(f)}\``).join(', ')}`, '');
      if (concept.topics.length) {
        lines.push('Learn in this order:', '');
        concept.topics.forEach((t, i) => lines.push(`${i + 1}. ${t.label} (~${t.minutes} min)`));
        lines.push('');
      }
      const resources = concept.resources.filter((r) => r.url ?? r.path);
      if (resources.length) {
        lines.push('Resources:', '');
        for (const r of resources) lines.push(`- [${r.title}](${r.url ?? r.path}) — ${r.type}`);
        lines.push('');
      }
    }
  }

  if (state.recommendations.length) {
    lines.push('## Tools that could help next time', '');
    for (const rec of state.recommendations) {
      const heading = rec.url ? `[${rec.title}](${rec.url})` : rec.title;
      lines.push(`### ${heading} (${rec.kind})`, '', rec.summary, '', `Worth a look because ${rec.whyForYou}`, '');
    }
  }

  if (state.researchNote) lines.push('---', '', `_${state.researchNote}_`, '');

  return lines.join('\n');
}

const firstLine = (s: string, max: number) => s.split('\n').find((l) => l.trim())?.trim().slice(0, max) ?? '';
const basename = (p: string) => p.split('/').pop() ?? p;
