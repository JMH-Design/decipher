import type { ActivityStep, Turn } from '../../../../shared/activity-schema';
import { categorizeTool } from '../toolCategorizer';
import type { ParsedTranscript, ParseOptions } from '../transcriptParser';
import { normalizeCopilotTool } from './copilotTools';

/**
 * Fallback for workspaces without a Copilot Chat extension transcript (Copilot Chat before
 * 0.51, or chats started outside agent mode). VS Code's own chat log is a delta format: line
 * one is a full snapshot, later lines patch it. It records which tools ran but not their
 * arguments, so explanations are thinner than the extension transcript's — good enough to
 * show a timeline, not good enough to prefer.
 */

interface Delta {
  kind?: number;
  k?: Array<string | number>;
  v?: unknown;
}

interface ChatRequest {
  requestId?: string;
  timestamp?: number;
  modelId?: string;
  message?: { text?: string };
  response?: Array<Record<string, unknown>>;
  result?: { errorDetails?: { message?: string }; metadata?: unknown };
}

interface ChatSession {
  sessionId?: string;
  customTitle?: string;
  requests?: ChatRequest[];
}

export function parseCopilotChatSession(conversationId: string, jsonl: string, opts: ParseOptions = {}): ParsedTranscript {
  const session = applyDeltas(jsonl);
  const steps: ActivityStep[] = [];
  const turns: Turn[] = [];
  let seq = opts.indexOffset ?? 0;
  let title = session.customTitle ?? '';

  const requests = session.requests ?? [];
  requests.forEach((request, index) => {
    const userRequest = String(request.message?.text ?? '').trim();
    const error = request.result?.errorDetails?.message;
    // A request without a `result` is the one still streaming.
    const status: Turn['status'] = error ? 'error' : request.result ? 'success' : 'active';
    const turn: Turn = { index, userRequest, timestamp: request.timestamp, status, stepIds: [] };
    turns.push(turn);
    if (!title && userRequest) title = userRequest.split('\n')[0].slice(0, 80);

    let narration = '';
    for (const part of request.response ?? []) {
      if (part.kind === 'toolInvocationSerialized') {
        const { toolName, input } = normalizeCopilotTool(String(part.toolId ?? part.toolName ?? 'unknown'), toolArguments(part));
        const step: ActivityStep = {
          id: `${conversationId}:${seq}`,
          conversationId,
          turnIndex: index,
          index: seq++,
          timestamp: request.timestamp,
          toolName,
          category: categorizeTool(toolName, input),
          input,
          status: part.isComplete === false ? 'running' : 'done',
          narration: narration || plainText(part.invocationMessage) || undefined,
          source: 'transcript',
          subagentId: opts.subagentId,
          parentStepId: opts.parentStepId,
        };
        narration = '';
        steps.push(step);
        turn.stepIds.push(step.id);
        continue;
      }
      const text = plainText(part.value ?? (part.kind === 'markdownContent' ? part.content : undefined));
      if (!text) continue;
      narration = narration ? `${narration}\n${text}` : text;
      turn.finalResponse = text;
    }
  });

  return { conversationId, turns, steps, title: title || 'Untitled chat', agentModel: requests[requests.length - 1]?.modelId };
}

/** Replay the log: `kind 0` is the snapshot, `kind 1` sets a value, `kind 2` appends to an array. */
function applyDeltas(jsonl: string): ChatSession {
  let session: ChatSession = {};
  for (const raw of jsonl.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let delta: Delta;
    try {
      delta = JSON.parse(line);
    } catch {
      continue;
    }
    if (delta.kind === 0) {
      session = (delta.v ?? {}) as ChatSession;
      continue;
    }
    if (!delta.k?.length) continue;
    const target = resolveParent(session, delta.k);
    if (!target) continue;
    const key = delta.k[delta.k.length - 1];
    if (delta.kind === 2) {
      const existing = (target as Record<string | number, unknown>)[key];
      const additions = Array.isArray(delta.v) ? delta.v : [delta.v];
      if (Array.isArray(existing)) existing.push(...additions);
      else (target as Record<string | number, unknown>)[key] = additions;
    } else {
      (target as Record<string | number, unknown>)[key] = delta.v;
    }
  }
  return session;
}

function resolveParent(root: unknown, keyPath: Array<string | number>): object | undefined {
  let node: unknown = root;
  for (const key of keyPath.slice(0, -1)) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node && typeof node === 'object' ? (node as object) : undefined;
}

function toolArguments(part: Record<string, unknown>): unknown {
  const specific = part.toolSpecificData;
  if (specific && typeof specific === 'object') return specific;
  return part.arguments ?? {};
}

/** Response parts are markdown strings or `{ value: string }` wrappers with file links. */
function plainText(value: unknown): string {
  const raw = typeof value === 'string' ? value : typeof (value as { value?: unknown })?.value === 'string' ? String((value as { value: string }).value) : '';
  return raw
    .replace(/\[([^\]]*)\]\((?:file|vscode-file):[^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
