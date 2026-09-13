import type { ShellResult } from './types';

/** Cursor hooks deliver `tool_output` as a JSON string `{"exitCode":0,"stdout":"..."}`; shells deliver raw text. */
export function parseShellOutput(output: string | undefined): ShellResult | undefined {
  if (output === undefined || output === null) return undefined;
  const trimmed = output.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if ('stdout' in obj || 'exitCode' in obj || 'output' in obj) {
        return {
          exitCode: typeof obj.exitCode === 'number' ? obj.exitCode : undefined,
          stdout: String(obj.stdout ?? obj.output ?? ''),
          stderr: obj.stderr ? String(obj.stderr) : undefined,
        };
      }
    } catch {
      /* raw text */
    }
  }
  // Cursor's Shell tool output format: "Exit code: N\n\nCommand output:\n\n```\n...\n```"
  const m = trimmed.match(/^Exit code:\s*(\d+)[\s\S]*?```\n?([\s\S]*?)\n?```/);
  if (m) return { exitCode: Number(m[1]), stdout: m[2] };
  return { stdout: output };
}

export interface GitStatusSummary {
  branch?: string;
  ahead?: number;
  behind?: number;
  modified: string[];
  added: string[];
  deleted: string[];
  renamed: string[];
  untracked: string[];
  clean: boolean;
}

/** Parse `git status --short` / `--porcelain` / `-sb` output. */
export function parseGitStatus(stdout: string): GitStatusSummary {
  const s: GitStatusSummary = { modified: [], added: [], deleted: [], renamed: [], untracked: [], clean: true };
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('##')) {
      const m = line.match(/^##\s+([^\s.]+)(?:\.\.\.(\S+))?(?:\s+\[(?:ahead (\d+))?(?:,\s*)?(?:behind (\d+))?\])?/);
      if (m) {
        s.branch = m[1];
        if (m[3]) s.ahead = Number(m[3]);
        if (m[4]) s.behind = Number(m[4]);
      }
      continue;
    }
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (!file) continue;
    s.clean = false;
    if (code === '??') s.untracked.push(file);
    else if (code.includes('R')) s.renamed.push(file);
    else if (code.includes('D')) s.deleted.push(file);
    else if (code.includes('A')) s.added.push(file);
    else s.modified.push(file);
  }
  // Long-form `git status`
  if (s.clean && /nothing to commit/.test(stdout)) s.clean = true;
  if (s.clean && /Changes not staged|Untracked files|Changes to be committed/.test(stdout)) s.clean = false;
  return s;
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export function parseDiffStat(stdout: string): DiffStat | undefined {
  const m = stdout.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  if (!m) return undefined;
  return { files: Number(m[1]), insertions: Number(m[2] ?? 0), deletions: Number(m[3] ?? 0) };
}

/** `git log --oneline` → [{hash, message}] */
export function parseGitLog(stdout: string): Array<{ hash: string; message: string }> {
  return stdout
    .split('\n')
    .map((l) => l.match(/^([0-9a-f]{7,40})\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ hash: m[1], message: m[2] }));
}

/** `git commit` output: "[main fa473f0] Message\n 2 files changed, ..." */
export function parseCommitOutput(stdout: string): { hash?: string; branch?: string; stat?: DiffStat } {
  const m = stdout.match(/^\[([^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,})\]/m);
  return { branch: m?.[1], hash: m?.[2], stat: parseDiffStat(stdout) };
}

/** Count ripgrep/grep matches. Handles `-n` (file:line:text), `-l` (files), `-c` (file:count). */
export function countSearchMatches(stdout: string): { matches: number; files: number } {
  const lines = stdout.split('\n').filter((l) => l.trim());
  const files = new Set<string>();
  let matches = 0;
  for (const l of lines) {
    const m = l.match(/^([^:\n]+?):(\d+)[:-]/);
    if (m) {
      files.add(m[1]);
      matches++;
    } else if (/^[^\s:]+$/.test(l)) {
      files.add(l);
      matches++;
    } else {
      matches++;
    }
  }
  return { matches, files: files.size || (matches ? 1 : 0) };
}

export function countLines(stdout: string): number {
  return stdout.split('\n').filter((l) => l.trim()).length;
}

export function firstLine(text: string | undefined, max = 120): string {
  const l = (text ?? '').split('\n').find((x) => x.trim()) ?? '';
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}

export function looksLikeError(result: ShellResult | undefined): boolean {
  if (!result) return false;
  if (result.exitCode !== undefined && result.exitCode !== 0) return true;
  return /\b(error|ENOENT|command not found|fatal:|Traceback|Exception)\b/i.test(result.stderr ?? '') ||
    /^(fatal|error):/im.test(result.stdout);
}
