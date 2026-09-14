import * as fs from 'node:fs';
import * as path from 'node:path';
import { workspaceSlug } from '../../../shared/activity-schema';
import { parserFor, type TranscriptFormat } from '../parser/adapters';
import { cleanClaudePrompt } from '../parser/adapters/claudeTranscript';
import type { ParsedTranscript } from '../parser/transcriptParser';
import { listSubagentTranscripts, listTranscripts, resolvePaths, type LumenPaths } from '../paths';
import { claudeHomeDir, findClaudeProjectDir, listClaudeSessions, readHead } from './claudePaths';
import { findCopilotWorkspaceStorage, listCopilotTranscripts, vscodeUserDataDir, type CopilotWorkspaceStorage } from './copilotPaths';
import { AGENT_LABEL, AGENT_SHORT_LABEL, candidateProviders, hooksSupported, type AgentProvider, type DataSourcePreference, type HostKind } from './detectHost';

/** One conversation on disk, whatever wrote it. */
export interface TranscriptSource {
  id: string;
  file: string;
  mtime: number;
  provider: AgentProvider;
  format: TranscriptFormat;
  title: string;
  /** False when the file exists but holds no messages — Claude Code sometimes writes only metadata. */
  hasMessages: boolean;
}

/**
 * The single seam between Lumen and the editor it is running in. Everything above this
 * interface — session building, explanations, research, the webview — is host-agnostic.
 */
export interface TranscriptStore {
  readonly provider: AgentProvider;
  /** "GitHub Copilot" — used in sentences. */
  readonly label: string;
  /** "Copilot" — used where space is tight. */
  readonly shortLabel: string;
  /** Where the transcripts live, for the output channel and the empty state. */
  readonly location: string;
  /** Directories whose changes should trigger a rebuild. */
  readonly watchDirs: string[];
  /** Hook events written by the Lumen Cursor plugin. Undefined where hooks cannot run. */
  readonly eventsDir?: string;
  /** Pre-rename hook events dir (`decipher/events`), read when the primary dir is empty. */
  readonly legacyEventsDir?: string;
  readonly researchDir: string;
  readonly hooksSupported: boolean;
  list(): TranscriptSource[];
  load(conversationId: string): ParsedTranscript | undefined;
}

export interface StoreContext {
  host: HostKind;
  workspacePath: string;
  preference: DataSourcePreference;
  /** `context.globalStorageUri.fsPath`: where Lumen caches its own work off Cursor. */
  storageDir: string;
  cursorProjectsDir?: string;
  claudeConfigDir?: string;
}

/**
 * Pick the store to read from: the first candidate for this host that actually has a
 * conversation. When nothing is found we still return the host's native store, so the empty
 * state can name the agent the user is most likely waiting on.
 */
export function resolveStore(ctx: StoreContext): TranscriptStore {
  const candidates = candidateProviders(ctx.host, ctx.preference);
  const stores = candidates.map((provider) => createStore(provider, ctx));
  return stores.find((store) => store.list().some((s) => s.hasMessages)) ?? stores[0];
}

export function createStore(provider: AgentProvider, ctx: StoreContext): TranscriptStore {
  switch (provider) {
    case 'copilot':
      return new CopilotStore(ctx);
    case 'claude-code':
      return new ClaudeStore(ctx);
    default:
      return new CursorStore(ctx);
  }
}

/** Lumen's own cache for hosts where it cannot write next to the agent's data. */
function workspaceStorageDir(ctx: StoreContext): string {
  return path.join(ctx.storageDir, 'workspaces', workspaceSlug(ctx.workspacePath));
}

// ---------------------------------------------------------------------------

/**
 * Caches titles by file mtime. Deriving a title means reading the head of every transcript,
 * and `list()` runs on every rebuild.
 */
class TitleCache {
  private readonly cache = new Map<string, { mtime: number; title: string }>();

  get(file: string, mtime: number, derive: () => string): string {
    const hit = this.cache.get(file);
    if (hit && hit.mtime === mtime) return hit.title;
    const title = derive() || 'Untitled chat';
    this.cache.set(file, { mtime, title });
    return title;
  }
}

const HEAD_BYTES = 32 * 1024;

// ---------------------------------------------------------------------------

/** Cursor: `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, plus hook events. */
class CursorStore implements TranscriptStore {
  readonly provider = 'cursor' as const;
  readonly label = AGENT_LABEL.cursor;
  readonly shortLabel = AGENT_SHORT_LABEL.cursor;
  readonly hooksSupported: boolean;
  readonly paths: LumenPaths;
  private readonly titles = new TitleCache();

  constructor(ctx: StoreContext) {
    this.paths = resolvePaths(ctx.workspacePath, ctx.cursorProjectsDir);
    this.hooksSupported = hooksSupported(ctx.host, 'cursor');
  }

  get location(): string {
    return this.paths.transcriptsDir;
  }

  get watchDirs(): string[] {
    return [this.paths.transcriptsDir, this.paths.eventsDir, this.paths.legacyEventsDir];
  }

  get eventsDir(): string {
    return this.paths.eventsDir;
  }

  get legacyEventsDir(): string {
    return this.paths.legacyEventsDir;
  }

  get researchDir(): string {
    return this.paths.researchDir;
  }

  list(): TranscriptSource[] {
    return listTranscripts(this.paths.transcriptsDir).map(({ id, file, mtime }) => ({
      id,
      file,
      mtime,
      provider: this.provider,
      format: 'cursor' as const,
      title: this.titles.get(file, mtime, () => titleFromRawHead(readHead(file, HEAD_BYTES))),
      hasMessages: true,
    }));
  }

  load(conversationId: string): ParsedTranscript | undefined {
    const file = path.join(this.paths.transcriptsDir, conversationId, `${conversationId}.jsonl`);
    if (!fs.existsSync(file)) return undefined;
    const parsed = parserFor('cursor')(conversationId, safeRead(file));

    // Subagent transcripts nest under the Task step that spawned them (matched in order).
    const taskSteps = parsed.steps.filter((s) => s.toolName === 'Task');
    listSubagentTranscripts(this.paths.transcriptsDir, conversationId).forEach((sub, i) => {
      const parent = taskSteps[i];
      const subParsed = parserFor('cursor')(conversationId, safeRead(sub.file), {
        subagentId: sub.id,
        parentStepId: parent?.id,
        indexOffset: (parent?.index ?? parsed.steps.length) * 1000 + 1,
      });
      for (const step of subParsed.steps) {
        step.turnIndex = parent?.turnIndex ?? parsed.turns.length - 1;
        parsed.steps.push(step);
      }
    });
    parsed.steps.sort((a, b) => a.index - b.index);
    return parsed;
  }
}

// ---------------------------------------------------------------------------

/** GitHub Copilot Chat, discovered through the workspace's VS Code storage folder. */
class CopilotStore implements TranscriptStore {
  readonly provider = 'copilot' as const;
  readonly label = AGENT_LABEL.copilot;
  readonly shortLabel = AGENT_SHORT_LABEL.copilot;
  readonly hooksSupported = false;
  readonly researchDir: string;
  private readonly storage: CopilotWorkspaceStorage | undefined;
  private readonly titles = new TitleCache();

  constructor(ctx: StoreContext) {
    this.storage = findCopilotWorkspaceStorage(vscodeUserDataDir(ctx.host), ctx.workspacePath);
    this.researchDir = path.join(workspaceStorageDir(ctx), 'research');
  }

  get location(): string {
    return this.storage?.transcriptsDir ?? 'no Copilot Chat storage for this workspace';
  }

  get watchDirs(): string[] {
    return this.storage ? [this.storage.transcriptsDir, this.storage.chatSessionsDir] : [];
  }

  list(): TranscriptSource[] {
    if (!this.storage) return [];
    return listCopilotTranscripts(this.storage).map(({ id, file, mtime, format }) => ({
      id,
      file,
      mtime,
      provider: this.provider,
      format: format === 'transcript' ? ('copilot' as const) : ('copilot-chat-session' as const),
      title: this.titles.get(file, mtime, () => copilotTitle(file, format)),
      hasMessages: true,
    }));
  }

  load(conversationId: string): ParsedTranscript | undefined {
    const source = this.list().find((s) => s.id === conversationId);
    if (!source) return undefined;
    return parserFor(source.format)(conversationId, safeRead(source.file));
  }
}

/** The first user message, or the title VS Code stored for the chat. */
function copilotTitle(file: string, format: 'transcript' | 'chat-session'): string {
  const head = readHead(file, HEAD_BYTES);
  if (format === 'transcript') {
    for (const line of head.split('\n')) {
      if (!line.includes('"user.message"')) continue;
      try {
        const content = (JSON.parse(line) as { data?: { content?: string } }).data?.content;
        if (content?.trim()) return firstLine(content);
      } catch {
        break; // truncated by the head read
      }
    }
  }
  const custom = /"customTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  if (custom) return firstLine(unescapeJson(custom[1]));
  const text = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  return text ? firstLine(unescapeJson(text[1])) : '';
}

// ---------------------------------------------------------------------------

/** Claude Code, which stores sessions per workspace under `~/.claude/projects`. */
class ClaudeStore implements TranscriptStore {
  readonly provider = 'claude-code' as const;
  readonly label = AGENT_LABEL['claude-code'];
  readonly shortLabel = AGENT_SHORT_LABEL['claude-code'];
  readonly hooksSupported = false;
  readonly researchDir: string;
  private readonly projectDir: string | undefined;
  private readonly titles = new TitleCache();

  constructor(ctx: StoreContext) {
    this.projectDir = findClaudeProjectDir(claudeHomeDir(ctx.claudeConfigDir), ctx.workspacePath);
    this.researchDir = path.join(workspaceStorageDir(ctx), 'research');
  }

  get location(): string {
    return this.projectDir ?? 'no Claude Code sessions for this workspace';
  }

  get watchDirs(): string[] {
    return this.projectDir ? [this.projectDir] : [];
  }

  list(): TranscriptSource[] {
    if (!this.projectDir) return [];
    return listClaudeSessions(this.projectDir).map(({ id, file, mtime, title, hasMessages }) => ({
      id,
      file,
      mtime,
      provider: this.provider,
      format: 'claude-code' as const,
      title: this.titles.get(file, mtime, () => firstLine(title ?? claudeTitle(file))),
      hasMessages,
    }));
  }

  load(conversationId: string): ParsedTranscript | undefined {
    const source = this.list().find((s) => s.id === conversationId);
    if (!source) return undefined;
    return parserFor('claude-code')(conversationId, safeRead(source.file));
  }
}

/** The first human line, skipping the tool-result and metadata records around it. */
function claudeTitle(file: string): string {
  for (const line of readHead(file, HEAD_BYTES).split('\n')) {
    if (!line.includes('"type"') || !line.includes('"user"')) continue;
    let record: { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      break; // truncated by the head read
    }
    if (record.type !== 'user' || record.isMeta || record.isSidechain) continue;
    const content = record.message?.content;
    const raw = typeof content === 'string' ? content : Array.isArray(content) ? textOfBlocks(content) : '';
    // Wrapper tags and injected editor context are not what the user typed.
    const text = cleanClaudePrompt(raw);
    if (text) return firstLine(text);
  }
  return '';
}

function textOfBlocks(blocks: unknown[]): string {
  return blocks
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------

/** Cursor's head is raw JSON text, so newlines and quotes are still escaped. */
export function titleFromRawHead(head: string): string {
  const match = /<user_query>([\s\S]*?)<\/user_query>/.exec(head);
  return match ? firstLine(unescapeJson(match[1])) : '';
}

function unescapeJson(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.trim().slice(0, 80);
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
