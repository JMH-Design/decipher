import type { ActivityStep, DetectedConcept, Evidence, EvidenceKind, KnowledgeConcept } from '../../../shared/activity-schema';
import { firstProgram, splitShellCommand } from '../parser/shellParser';
import { mentions, type KnowledgeGraph } from './knowledgeGraph';

/**
 * Multi-signal concept extraction. Every signal is a cheap string check against the
 * knowledge graph's `detection` blocks; no AST, no network. Designed to be run on
 * every step as it arrives.
 *
 * Signals (from the plan):
 *  - imports / requires in edited text
 *  - API symbols in edited text
 *  - package installs in shell commands
 *  - file extensions / names touched
 *  - skill reads (Read of a SKILL.md)
 *  - MCP namespaces used
 *  - user request keywords (relevance boost only)
 */
export class ConceptDetector {
  constructor(private readonly graph: KnowledgeGraph) {}

  detectStep(step: ActivityStep): DetectedConcept[] {
    const hits = new Map<string, Evidence[]>();
    const add = (conceptId: string, kind: EvidenceKind, detail: string, file?: string) => {
      if (!this.graph.get(conceptId)) return;
      const list = hits.get(conceptId) ?? [];
      if (list.length < 6 && !list.some((e) => e.kind === kind && e.detail === detail)) list.push({ kind, detail, stepId: step.id, file });
      hits.set(conceptId, list);
    };

    const file = pathOf(step);
    if (file && this.isIgnoredPath(file)) return [];

    // --- file-type and file-name signals
    if (file && ['Write', 'StrReplace', 'Read', 'Delete', 'EditNotebook'].includes(step.toolName)) {
      const base = file.split('/').pop() ?? file;
      const ext = base.includes('.') ? `.${base.split('.').pop()}` : '';
      for (const c of this.graph.all()) {
        if (c.detection.fileNames?.some((n) => base === n || base.endsWith(n))) add(c.id, 'file', base, file);
        else if (ext && c.detection.fileExtensions?.includes(ext.toLowerCase())) add(c.id, 'file', ext, file);
        if (c.detection.skillPaths?.some((p) => file.includes(p)) && /SKILL\.md$/.test(file)) add(c.id, 'skill', base, file);
      }
      // A skill read is a strong signal for the concept the skill is about.
      if (step.toolName === 'Read' && /SKILL\.md$/.test(file)) {
        const skillName = file.split('/').slice(-2, -1)[0]?.toLowerCase() ?? '';
        for (const c of this.graph.all()) {
          if (c.resources.some((r) => r.type === 'skill' && r.path && r.path.toLowerCase().includes(`/${skillName}/`))) add(c.id, 'skill', skillName, file);
          else if (c.detection.keywords?.some((k) => skillName.includes(k.replace(/\s+/g, '-')))) add(c.id, 'skill', skillName, file);
        }
      }
    }

    // --- code-content signals (only the text the agent wrote, never files it merely read)
    const written = writtenText(step);
    if (written) {
      for (const c of this.graph.all()) {
        for (const imp of c.detection.imports ?? []) {
          if (importRegex(imp).test(written)) add(c.id, 'import', imp, file);
        }
        for (const sym of c.detection.symbols ?? []) {
          if (written.includes(sym)) add(c.id, 'symbol', sym.trim(), file);
        }
      }
    }

    // --- shell signals
    if (step.toolName === 'Shell') {
      const command = String(step.input.command ?? '');
      for (const seg of splitShellCommand(command)) {
        const { program, args } = firstProgram(seg);
        const positional = args.filter((a) => !a.startsWith('-'));
        const head = `${program} ${positional[0] ?? ''}`.trim();
        for (const c of this.graph.all()) {
          for (const cmd of c.detection.commands ?? []) {
            const needle = cmd.trim();
            if (needle.includes(' ') ? head.startsWith(needle) || seg.startsWith(needle) : program === needle) add(c.id, 'command', needle);
          }
          // package installs: `npm install gsap`, `pnpm add @gsap/react`
          if (['npm', 'pnpm', 'yarn', 'bun'].includes(program) && ['install', 'i', 'add'].includes(positional[0] ?? '')) {
            for (const pkg of positional.slice(1)) {
              const bare = pkg.replace(/@[\^~]?[\d.]+$/, '');
              if (c.detection.packages?.includes(bare)) add(c.id, 'package', bare);
            }
          }
        }
      }
    }

    // --- MCP / dynamic tools
    if (['CallDynamicTool', 'GetDynamicTools', 'FetchMcpResource'].includes(step.toolName)) {
      const ns = String(step.input.namespace ?? step.input.server ?? '');
      for (const c of this.graph.all()) {
        if (c.detection.mcpNamespaces?.some((n) => ns === n || ns.startsWith(n))) add(c.id, 'mcp', ns);
      }
    }

    // --- subagent type
    if (step.toolName === 'Task' && String(step.input.subagent_type) === 'browser-use') add('browser-devtools', 'mcp', 'browser-use');

    return [...hits.entries()].map(([conceptId, evidence]) => ({ conceptId, evidence, relevance: 1 }));
  }

  /**
   * Detect across a set of steps (a turn or a session) and compute relevance:
   *   base 0.5 + evidence strength (up to +0.5) + request-domain boost (+0.5), clamped to [0.5, 1.5].
   * Incidental concepts (git, terminal…) are capped unless the request is about them.
   */
  detectAll(steps: ActivityStep[], userRequests: string[] = []): DetectedConcept[] {
    const merged = new Map<string, DetectedConcept>();
    for (const step of steps) {
      for (const d of this.detectStep(step)) {
        const existing = merged.get(d.conceptId);
        if (existing) {
          for (const e of d.evidence) if (existing.evidence.length < 12) existing.evidence.push(e);
        } else merged.set(d.conceptId, { ...d, evidence: [...d.evidence] });
      }
    }

    const request = userRequests.join('\n');
    const domains = this.graph.domainsForRequest(request);
    const boosted = new Set(domains.flatMap((d) => d.concepts));
    const requestLower = request.toLowerCase();

    for (const d of merged.values()) {
      const concept = this.graph.get(d.conceptId)!;
      const strong = d.evidence.filter((e) => e.kind === 'import' || e.kind === 'package' || e.kind === 'skill').length;
      const weak = d.evidence.length - strong;
      const strength = Math.min(0.5, strong * 0.25 + weak * 0.08);
      let relevance = 0.5 + strength;
      const mentioned = concept.detection.keywords?.some((k) => mentions(requestLower, k)) || mentions(requestLower, concept.label);
      if (boosted.has(d.conceptId) || mentioned) relevance += 0.5;
      if (this.graph.isIncidental(d.conceptId) && !boosted.has(d.conceptId) && !mentioned) relevance = Math.min(relevance, this.graph.rules.incidentalConcepts.relevanceCap);
      d.relevance = clamp(relevance, 0.5, 1.5);
      if (mentioned) d.evidence.push({ kind: 'request', detail: 'mentioned in your request', stepId: '' });
    }

    return [...merged.values()].sort((a, b) => b.relevance - a.relevance);
  }

  private isIgnoredPath(file: string): boolean {
    const base = file.split('/').pop() ?? '';
    return this.graph.rules.ignoredPaths.some((p) => file.includes(p)) || this.graph.rules.ignoredFileNames.includes(base);
  }
}

function pathOf(step: ActivityStep): string | undefined {
  const p = step.input.path ?? step.input.file_path ?? step.input.target_notebook;
  return typeof p === 'string' ? p.replace(/\\/g, '/') : undefined;
}

/** Text the agent authored in this step (new content only). */
function writtenText(step: ActivityStep): string | undefined {
  switch (step.toolName) {
    case 'Write':
      return typeof step.input.contents === 'string' ? step.input.contents : undefined;
    case 'StrReplace':
      return typeof step.input.new_string === 'string' ? step.input.new_string : undefined;
    case 'EditNotebook':
      return typeof step.input.new_string === 'string' ? step.input.new_string : undefined;
    default:
      return undefined;
  }
}

const importRegexCache = new Map<string, RegExp>();
function importRegex(spec: string): RegExp {
  let re = importRegexCache.get(spec);
  if (!re) {
    const esc = spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    // import x from 'spec' | import 'spec' | require('spec') | from "spec/sub"
    re = new RegExp(`(?:from\\s*|import\\s*|require\\(\\s*)['"]${esc}(?:['"]|/)`);
    importRegexCache.set(spec, re);
  }
  return re;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export type { KnowledgeConcept };
