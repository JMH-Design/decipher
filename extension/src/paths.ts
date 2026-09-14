import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { workspaceSlug } from '../../shared/activity-schema';

export interface LumenPaths {
  cursorProjectsDir: string;
  projectDir: string;
  transcriptsDir: string;
  /** Primary cache dir: `~/.cursor/projects/<slug>/lumen/`. */
  dataDir: string;
  /** Pre-rename cache dir, still read for hook events and research. */
  legacyDataDir: string;
  eventsDir: string;
  legacyEventsDir: string;
  /** Cached research results, one file per conversation. */
  researchDir: string;
  legacyResearchDir: string;
  hooksJsonPath: string;
}

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Resolve where Cursor keeps per-project data for a workspace.
 * If the slug we compute does not exist we fall back to scanning for the closest match so a
 * slight change in Cursor's slug rule does not break Lumen.
 */
export function resolvePaths(workspacePath: string, projectsDirOverride?: string): LumenPaths {
  const cursorProjectsDir = projectsDirOverride ? expandHome(projectsDirOverride) : path.join(os.homedir(), '.cursor', 'projects');
  let slug = workspaceSlug(workspacePath);
  let projectDir = path.join(cursorProjectsDir, slug);

  if (!fs.existsSync(projectDir) && fs.existsSync(cursorProjectsDir)) {
    const base = path.basename(workspacePath).replace(/[^A-Za-z0-9]/g, '-');
    const candidates = fs
      .readdirSync(cursorProjectsDir)
      .filter((d) => d.endsWith(base))
      .map((d) => ({ d, mtime: statMtime(path.join(cursorProjectsDir, d)) }))
      .sort((a, b) => b.mtime - a.mtime);
    if (candidates.length) {
      slug = candidates[0].d;
      projectDir = path.join(cursorProjectsDir, slug);
    }
  }

  const dataDir = path.join(projectDir, 'lumen');
  const legacyDataDir = path.join(projectDir, 'decipher');
  return {
    cursorProjectsDir,
    projectDir,
    transcriptsDir: path.join(projectDir, 'agent-transcripts'),
    dataDir,
    legacyDataDir,
    eventsDir: path.join(dataDir, 'events'),
    legacyEventsDir: path.join(legacyDataDir, 'events'),
    researchDir: path.join(dataDir, 'research'),
    legacyResearchDir: path.join(legacyDataDir, 'research'),
    hooksJsonPath: path.join(os.homedir(), '.cursor', 'hooks.json'),
  };
}

function statMtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** List transcript files: `<transcriptsDir>/<id>/<id>.jsonl`, newest first. */
export function listTranscripts(transcriptsDir: string): Array<{ id: string; file: string; mtime: number }> {
  if (!fs.existsSync(transcriptsDir)) return [];
  const out: Array<{ id: string; file: string; mtime: number }> = [];
  for (const id of fs.readdirSync(transcriptsDir)) {
    const file = path.join(transcriptsDir, id, `${id}.jsonl`);
    if (fs.existsSync(file)) out.push({ id, file, mtime: statMtime(file) });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function listSubagentTranscripts(transcriptsDir: string, conversationId: string): Array<{ id: string; file: string }> {
  const dir = path.join(transcriptsDir, conversationId, 'subagents');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ id: f.replace(/\.jsonl$/, ''), file: path.join(dir, f) }));
}
