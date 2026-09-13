import type { ActivityStep, Explanation } from '../../../shared/activity-schema';
import { firstProgram, hasFileRedirect, redactCommand, splitShellSegments } from '../parser/shellParser';
import type { GlossaryService } from '../glossary/glossaryService';
import { parseShellOutput } from './outputParsers';
import { SHELL_TEMPLATES } from './templates/shellTemplates';
import { TOOL_TEMPLATES } from './templates/toolTemplates';
import { makeExplanation, type ShellContext, type Template, type TemplateContext } from './types';

export interface EngineOptions {
  glossary: GlossaryService;
  workspaceRoot?: string;
}

/**
 * Rule-based explanation layer. Deterministic, instant, free.
 * Picks the highest-scoring template for a step; for shell commands it splits
 * `a && b && c` and explains each segment, composing a "Ran N steps" summary.
 */
export class TemplateEngine {
  constructor(private readonly opts: EngineOptions) {}

  explain(step: ActivityStep, userRequest?: string): Explanation {
    const base: TemplateContext = {
      step,
      toolName: step.toolName,
      input: step.input,
      output: step.output,
      shellResult: parseShellOutput(step.output),
      workspaceRoot: this.opts.workspaceRoot,
      glossary: this.opts.glossary,
      userRequest,
    };

    let explanation: Explanation;
    if (step.toolName === 'Shell') explanation = this.explainShell(base);
    else explanation = pick(TOOL_TEMPLATES, base).explain(base);

    // Enrich vocabulary with glossary terms mentioned in the technical string.
    const detected = this.opts.glossary.detect(explanation.technical, 4);
    explanation.vocabulary = uniq([...explanation.vocabulary, ...detected]).filter((id) => this.opts.glossary.get(id));

    if (step.status === 'error') {
      explanation.whyItMatters = explanation.whyItMatters ?? '';
      explanation.whatHappened += step.errorMessage ? ` It failed: ${firstSentence(step.errorMessage)}` : ' It did not finish successfully.';
    }
    return explanation;
  }

  private explainShell(base: TemplateContext): Explanation {
    const command = String(base.input.command ?? '');
    const description = typeof base.input.description === 'string' ? base.input.description : undefined;
    const segments = splitShellSegments(command);
    // `cd dir && real-command` — the cd is scaffolding, not a step worth explaining.
    // `echo "---"` separators between commands are likewise noise.
    const meaningful = segments.filter((s, i) => {
      if (i === 0 && /^cd\s/.test(s.raw) && segments.length > 1) return false;
      if (segments.length > 1 && isSeparatorEcho(s.raw)) return false;
      return true;
    });
    if (!meaningful.length) meaningful.push(...segments);

    const subExplanations = meaningful.map((seg) => {
      const ctx = this.shellContext(base, seg.raw);
      return pick(SHELL_TEMPLATES, ctx).explain(ctx);
    });

    if (subExplanations.length === 1) {
      const only = subExplanations[0];
      if (description && only.confidence < 0.5) {
        // The agent's own one-line description beats our generic fallback.
        only.summary = description.endsWith('.') ? description : `${description}.`;
        only.confidence = 0.55;
      }
      return only;
    }

    const titles = subExplanations.map((e) => lowerFirst(stripTrailingPeriod(e.title)));
    const summaryList = subExplanations.map((e, i) => `(${i + 1}) ${lowerFirst(stripTrailingPeriod(e.summary))}`).join(', ');
    const confidence = Math.min(...subExplanations.map((e) => e.confidence));
    const hasFailure = base.shellResult && base.shellResult.exitCode !== undefined && base.shellResult.exitCode !== 0;

    return makeExplanation({
      templateId: 'shell.chain',
      title: description ? capitalize(stripTrailingPeriod(description)) : `Ran ${subExplanations.length} steps in order`,
      summary: `Ran ${subExplanations.length} steps in order: ${summaryList}.`,
      whatHappened: `These commands were joined with "&&", which means each one only runs if the previous one succeeded: ${titles.join(' → ')}.${hasFailure ? ' One of them reported an error, so later steps may have been skipped.' : ''}`,
      whyItMatters: 'Chaining lets the agent do a sequence of checks in one go while guaranteeing it stops at the first problem.',
      technical: redactCommand(command),
      vocabulary: uniq(['chained-commands', ...subExplanations.flatMap((e) => e.vocabulary)]),
      subSteps: subExplanations,
      confidence,
    });
  }

  private shellContext(base: TemplateContext, segment: string): ShellContext {
    const { program, args, filters } = firstProgram(segment);
    const positional = positionalArgs(program, args);
    return {
      ...base,
      segment,
      program,
      args,
      filters,
      positional,
      has: (flag) => args.some((a) => (typeof flag === 'string' ? a === flag || a.startsWith(`${flag}=`) : flag.test(a))),
    };
  }
}

function pick<C extends TemplateContext>(templates: Template<C>[], ctx: C): Template<C> {
  let best: Template<C> | undefined;
  let bestScore = 0;
  for (const t of templates) {
    const score = t.match(ctx);
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best ?? templates[templates.length - 1];
}

/** `echo` with no file redirect and only decorative text (`---`, `===`, blank) is a visual separator. */
function isSeparatorEcho(segment: string): boolean {
  const { program, args } = firstProgram(segment);
  if (program !== 'echo' && program !== 'printf') return false;
  if (hasFileRedirect(segment)) return false;
  const text = args.filter((a) => !/^-[neE]+$/.test(a)).join(' ');
  return text.trim() === '' || /^[-=_#*~>\s]*[A-Za-z0-9 :]*[-=_#*~>\s]*$/.test(text) && /^[\s\W]*$|^[-=#*~]{2,}/.test(text.trim());
}

/** Flags whose next token is a value, per program, so it is not mistaken for a file/argument. */
const VALUE_FLAGS: Record<string, string[]> = {
  head: ['-n', '-c'],
  tail: ['-n', '-c'],
  rg: ['-g', '--glob', '-t', '--type', '-e', '--regexp', '-m', '--max-count', '-A', '-B', '-C', '--context', '-j'],
  grep: ['-e', '--include', '--exclude', '-A', '-B', '-C', '-m'],
  find: ['-name', '-iname', '-type', '-maxdepth', '-mindepth', '-path', '-newer', '-size', '-mtime', '-exec', '-not'],
  git: ['-m', '--message', '-C', '-n', '--author', '-u'],
  curl: ['-o', '-w', '-H', '-X', '-d', '--data', '--max-time', '-u', '-A'],
  wget: ['-O', '-o'],
  sed: ['-e', '-i'],
  awk: ['-F', '-v'],
  cut: ['-d', '-f', '-c'],
  sort: ['-k', '-t'],
  node: ['-e', '--eval', '-p', '--print', '-r', '--require', '--input-type'],
  python: ['-c', '-m'],
  python3: ['-c', '-m'],
  npm: ['--prefix', '-w', '--workspace'],
  pnpm: ['--filter', '-C'],
  xargs: ['-I', '-n', '-P'],
  ls: [],
  chmod: [],
};

function positionalArgs(program: string, args: string[]): string[] {
  const valueFlags = new Set(VALUE_FLAGS[program] ?? []);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-') && a !== '-') {
      if (valueFlags.has(a) && !a.includes('=')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const stripTrailingPeriod = (s: string) => s.replace(/\.$/, '');
const firstSentence = (s: string) => s.split(/(?<=\.)\s|\n/)[0].slice(0, 200);
