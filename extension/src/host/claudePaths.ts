import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanClaudePrompt } from '../parser/adapters/claudeTranscript';

/**
 * Claude Code keeps one JSONL per session under `~/.claude/projects/<encoded-workspace-path>/`,
 * regardless of whether it was launched from a terminal, the VS Code extension, or Cursor.
 * `CLAUDE_CONFIG_DIR` relocates the whole `.claude` directory.
 */

/** `/Users/me/My Site` -> `-Users-me-My-Site`. Unlike Cursor, the leading slash becomes a dash. */
export function claudeProjectSlug(workspacePath: string): string {
  return workspacePath.replace(/[^A-Za-z0-9]/g, '-');
}

export function claudeHomeDir(configDirOverride?: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = configDirOverride?.trim() || env.CLAUDE_CONFIG_DIR?.trim();
  return override ? expandHome(override, home) : path.join(home, '.claude');
}

function expandHome(p: string, home: string): string {
  return p.startsWith('~') ? path.join(home, p.slice(1)) : p;
}

/**
 * The project folder for this workspace. Claude's encoding rule has changed between releases,
 * so when the computed slug is missing we fall back to the newest folder whose name ends with
 * the same encoded basename — the same tolerance the Cursor resolver already has.
 */
export function findClaudeProjectDir(claudeHome: string, workspacePath: string): string | undefined {
  const projects = path.join(claudeHome, 'projects');
  const exact = path.join(projects, claudeProjectSlug(workspacePath));
  if (fs.existsSync(exact)) return exact;

  const suffix = claudeProjectSlug(path.basename(workspacePath));
  let names: string[];
  try {
    names = fs.readdirSync(projects);
  } catch {
    return undefined;
  }
  const candidates = names
    .filter((n) => n.endsWith(`-${suffix}`) || n === suffix)
    .map((n) => ({ dir: path.join(projects, n), mtime: mtimeOf(path.join(projects, n)) }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.dir;
}

function mtimeOf(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

export interface ClaudeSessionFile {
  id: string;
  file: string;
  mtime: number;
  /** From `sessions-index.json` or the first prompt in the file. */
  title?: string;
  /** False when the file holds only bookkeeping records (`custom-title`, `mode`, …). */
  hasMessages: boolean;
}

interface SessionsIndex {
  entries?: Array<{ sessionId?: string; fullPath?: string; firstPrompt?: string; fileMtime?: number; isSidechain?: boolean }>;
}

/**
 * Sessions for a project, newest first. Files that never got a real message are kept but
 * flagged, so the UI can say "Claude Code did not save this conversation" rather than
 * silently showing an empty timeline.
 */
export function listClaudeSessions(projectDir: string): ClaudeSessionFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(projectDir);
  } catch {
    return [];
  }

  const titles = readSessionsIndex(path.join(projectDir, 'sessions-index.json'));
  const out: ClaudeSessionFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(projectDir, name);
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const id = name.replace(/\.jsonl$/, '');
    out.push({ id, file, mtime, title: titles.get(id), hasMessages: fileHasMessages(file) });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function readSessionsIndex(file: string): Map<string, string> {
  const titles = new Map<string, string>();
  try {
    const index = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionsIndex;
    for (const entry of index.entries ?? []) {
      if (!entry.sessionId || !entry.firstPrompt) continue;
      const title = cleanClaudePrompt(entry.firstPrompt).split('\n')[0].slice(0, 80);
      if (title) titles.set(entry.sessionId, title);
    }
  } catch {
    /* no index, or an index from a newer Claude — titles come from the transcript instead */
  }
  return titles;
}

/** Stub sessions are tiny, so a head read is enough to tell them from a real conversation. */
const MESSAGE_PROBE_BYTES = 256 * 1024;

function fileHasMessages(file: string): boolean {
  return /"type"\s*:\s*"(user|assistant)"/.test(readHead(file, MESSAGE_PROBE_BYTES));
}

export function readHead(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}
