/**
 * Minimal, dependency-free shell command tokenizer.
 *
 * Goals: split `a && b; c || d` into segments and `cmd -x "quoted arg"` into argv,
 * respecting single/double quotes and backslash escapes. Not a full POSIX parser —
 * it is only used to *describe* commands, never to run them.
 */

export interface ShellSegment {
  raw: string;
  /** Operator that joined this segment to the previous one. */
  joiner?: '&&' | '||' | ';' | '|' | '&';
}

export function splitShellCommand(command: string): string[] {
  return splitShellSegments(command).map((s) => s.raw);
}

export function splitShellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let joiner: ShellSegment['joiner'];
  let parenDepth = 0;

  const push = (nextJoiner?: ShellSegment['joiner']) => {
    const raw = current.trim();
    if (raw) segments.push({ raw, joiner });
    current = '';
    joiner = nextJoiner;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    // Heredoc: `<<'EOF' … \nEOF` — swallow the body verbatim so its newlines don't split segments.
    if (ch === '<' && next === '<' && !quote) {
      const m = command.slice(i).match(/^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n/);
      if (m) {
        const terminator = m[2];
        const bodyStart = i + m[0].length;
        const endRe = new RegExp(`\\n${terminator}\\s*(\\n|$)`);
        const rel = command.slice(bodyStart).search(endRe);
        const end = rel >= 0 ? bodyStart + rel + `\n${terminator}`.length : command.length;
        current += command.slice(i, end);
        i = end - 1;
        continue;
      }
    }

    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && next !== undefined) {
        current += next;
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '\\' && next !== undefined) {
      current += ch + next;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') parenDepth++;
    if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    if (parenDepth > 0) {
      current += ch;
      continue;
    }

    if (ch === '&' && next === '&') {
      push('&&');
      i++;
      continue;
    }
    if (ch === '|' && next === '|') {
      push('||');
      i++;
      continue;
    }
    if (ch === ';' || ch === '\n') {
      push(';');
      continue;
    }
    // Pipelines stay in one segment; downstream describers treat `| head` etc. as filters.
    current += ch;
  }
  push();
  return segments;
}

/** Split one segment into argv, dropping shell quoting. */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    const next = segment[i + 1];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && next !== undefined) {
        current += next;
        i++;
      } else {
        current += ch;
      }
      hasToken = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === '\\' && next !== undefined) {
      current += next;
      i++;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) tokens.push(current);
      current = '';
      hasToken = false;
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/** Split a pipeline `a | b | c` into stages (quote-aware). */
export function splitPipeline(segment: string): string[] {
  const stages: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '|' && segment[i + 1] !== '|') {
      stages.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) stages.push(current.trim());
  return stages;
}

export interface ProgramInfo {
  program: string;
  args: string[];
  /** Remaining pipeline stages (`head -5`, `wc -l`, …). */
  filters: string[];
  /** Leading env assignments, e.g. `NODE_ENV=production`. */
  env: string[];
}

const WRAPPERS = new Set(['sudo', 'time', 'env', 'nice', 'nohup', 'command', 'exec']);

/** Identify the program a segment runs, skipping `cd x &&`-style wrappers handled upstream. */
export function firstProgram(segment: string): ProgramInfo {
  const stages = splitPipeline(segment);
  const argv = stripRedirections(tokenize(stages[0] ?? ''));
  const env: string[] = [];
  while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) env.push(argv.shift()!);
  while (argv.length && WRAPPERS.has(argv[0])) argv.shift();
  const program = (argv.shift() ?? '').replace(/^.*\//, '');
  return { program, args: argv, filters: stages.slice(1), env };
}

/** Drop `2>/dev/null`, `>out.txt`, `2>&1`, `< in` tokens — they describe plumbing, not intent. */
export function stripRedirections(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^\d*>>?&?\d*$/.test(a) || a === '<' || a === '<<<') {
      i++; // skip the target
      continue;
    }
    if (/^\d*>>?\S+$/.test(a) || /^<\S+$/.test(a)) continue;
    out.push(a);
  }
  return out;
}

/** Does the raw segment write to a file (`> file`, `>> file`, `tee file`)? */
export function hasFileRedirect(segment: string): boolean {
  return /(^|[^0-9&>])>{1,2}\s*[^&\s]/.test(segment) && !/>\s*\/dev\/null/.test(segment.replace(/2>\s*\/dev\/null/g, ''));
}

/** Human-friendly rendering of `| head -5 | wc -l` filters. */
export function describeFilters(filters: string[]): string | undefined {
  if (!filters.length) return undefined;
  const parts = filters.map((f) => {
    const { program, args } = firstProgram(f);
    switch (program) {
      case 'head':
        return `kept only the first ${numberArg(args) ?? 10} lines`;
      case 'tail':
        return `kept only the last ${numberArg(args) ?? 10} lines`;
      case 'wc':
        return args.includes('-l') ? 'counted the lines' : 'counted the results';
      case 'sort':
        return 'sorted the results';
      case 'uniq':
        return 'removed duplicates';
      case 'grep':
      case 'rg':
        return `filtered for "${args.filter((a) => !a.startsWith('-')).pop() ?? ''}"`;
      case 'jq':
        return 'pulled specific fields out of the JSON';
      case 'cat':
        return 'displayed the result';
      case 'xargs':
        return 'ran a follow-up command on each result';
      case 'tee':
        return 'saved a copy of the output to a file';
      case 'sed':
      case 'awk':
      case 'cut':
      case 'tr':
        return 'reformatted the output';
      case 'od':
      case 'xxd':
        return 'inspected the raw bytes';
      default:
        return `passed it through ${program}`;
    }
  });
  return parts.join(', then ');
}

function numberArg(args: string[]): string | undefined {
  for (const a of args) {
    const m = a.match(/^-n?(\d+)$/);
    if (m) return m[1];
  }
  const i = args.indexOf('-n');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return undefined;
}

/** Return a redacted copy of a command safe to display (tokens that look like secrets). */
export function redactCommand(command: string): string {
  return command
    .replace(/(--?(?:token|password|passwd|secret|api[-_]?key|authorization)[=\s]+)(\S+)/gi, '$1[redacted]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*=)(\S+)/g, '$1[redacted]')
    .replace(/\b(sk|ghp|gho|ghu|xoxb|xoxp)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer [redacted]');
}
