import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HostKind } from './detectHost';

/**
 * GitHub Copilot Chat writes an agent transcript per session under the workspace's own
 * storage folder:
 *
 *   {userDataDir}/workspaceStorage/{hash}/GitHub.copilot-chat/transcripts/{sessionId}.jsonl
 *
 * The hash is opaque, so the only reliable way to find the right folder is to read each
 * `workspace.json` and match its folder URI against the open workspace. Matching on
 * "most recently modified" looks tempting and is wrong: another window touches its storage
 * constantly, and Decipher would end up explaining somebody else's project.
 */

export interface CopilotWorkspaceStorage {
  storageDir: string;
  /** `GitHub.copilot-chat/transcripts` — the rich event stream, Copilot Chat 0.51+. */
  transcriptsDir: string;
  /** `chatSessions` — VS Code's own chat log, used when the extension transcript is absent. */
  chatSessionsDir: string;
}

/** Where the editor keeps per-user state. Mirrors VS Code's own `userDataDir` rules. */
export function vscodeUserDataDir(
  host: HostKind,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const appDir = host === 'vscode-insiders' ? 'Code - Insiders' : 'Code';
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), appDir, 'User');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', appDir, 'User');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), appDir, 'User');
}

/**
 * Find the storage folder belonging to `workspacePath`. Prefers a folder that already has
 * Copilot transcripts, so a stale entry for the same path does not win.
 */
export function findCopilotWorkspaceStorage(userDataDir: string, workspacePath: string): CopilotWorkspaceStorage | undefined {
  const root = path.join(userDataDir, 'workspaceStorage');
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return undefined;
  }

  const target = normalizePath(workspacePath);
  const matches: CopilotWorkspaceStorage[] = [];
  for (const entry of entries) {
    const storageDir = path.join(root, entry);
    if (!workspaceStorageMatches(storageDir, target)) continue;
    matches.push({
      storageDir,
      transcriptsDir: path.join(storageDir, 'GitHub.copilot-chat', 'transcripts'),
      chatSessionsDir: path.join(storageDir, 'chatSessions'),
    });
  }
  if (!matches.length) return undefined;
  return matches.sort((a, b) => score(b) - score(a))[0];
}

function score(ws: CopilotWorkspaceStorage): number {
  if (countJsonl(ws.transcriptsDir)) return 2;
  if (countJsonl(ws.chatSessionsDir)) return 1;
  return 0;
}

function countJsonl(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length;
  } catch {
    return 0;
  }
}

/** True when this storage folder's `workspace.json` points at `target`. */
function workspaceStorageMatches(storageDir: string, target: string): boolean {
  let meta: { folder?: string; workspace?: string };
  try {
    meta = JSON.parse(fs.readFileSync(path.join(storageDir, 'workspace.json'), 'utf8'));
  } catch {
    return false;
  }
  if (meta.folder) return normalizePath(fileUriToPath(meta.folder)) === target;
  if (meta.workspace) return multiRootFolders(fileUriToPath(meta.workspace)).some((f) => normalizePath(f) === target);
  return false;
}

/** A `.code-workspace` file lists its roots; any of them can be the folder Decipher sees. */
function multiRootFolders(workspaceFile: string): string[] {
  try {
    const parsed = JSON.parse(stripJsonComments(fs.readFileSync(workspaceFile, 'utf8'))) as { folders?: Array<{ path?: string }> };
    const base = path.dirname(workspaceFile);
    return (parsed.folders ?? []).map((f) => f.path).filter((p): p is string => Boolean(p)).map((p) => path.resolve(base, p));
  } catch {
    return [];
  }
}

/** `.code-workspace` is JSONC. Only line comments appear in practice. */
function stripJsonComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, '');
}

/** `file:///Users/me/My%20Site` -> `/Users/me/My Site`. Non-file URIs come back unchanged. */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  let p = decodeURIComponent(uri.slice('file://'.length));
  // `file:///c:/src` and `file://server/share` both appear on Windows.
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  return p;
}

function normalizePath(p: string): string {
  const cleaned = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
}

export interface CopilotTranscriptFile {
  id: string;
  file: string;
  mtime: number;
  /** `transcript` is the Copilot event stream; `chat-session` is the VS Code fallback. */
  format: 'transcript' | 'chat-session';
}

/**
 * Session files for a workspace, newest first. The Copilot event stream wins outright when it
 * exists — the VS Code chat log is a delta format that only carries a subset of what we need.
 */
export function listCopilotTranscripts(ws: CopilotWorkspaceStorage): CopilotTranscriptFile[] {
  const rich = jsonlFiles(ws.transcriptsDir, 'transcript');
  if (rich.length) return rich;
  return jsonlFiles(ws.chatSessionsDir, 'chat-session');
}

function jsonlFiles(dir: string, format: CopilotTranscriptFile['format']): CopilotTranscriptFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: CopilotTranscriptFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    out.push({ id: name.replace(/\.jsonl$/, ''), file, mtime, format });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
