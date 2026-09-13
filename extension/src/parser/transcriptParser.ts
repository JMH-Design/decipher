import type { ActivityStep, Turn } from '../../../shared/activity-schema';
import { categorizeTool, normalizeToolName } from './toolCategorizer';

/**
 * Shape of one JSONL line in `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`.
 * Only the fields Decipher relies on are modelled.
 */
interface TranscriptLine {
  role?: 'user' | 'assistant';
  type?: string; // e.g. "turn_ended"
  status?: string;
  error?: unknown;
  message?: { content?: ContentBlock[] };
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input?: Record<string, unknown>; id?: string }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export interface ParsedTranscript {
  conversationId: string;
  turns: Turn[];
  steps: ActivityStep[];
  /** Title derived from the first user request. */
  title: string;
  /** The model driving the chat, when the transcript records it (Copilot and Claude Code do). */
  agentModel?: string;
}

export interface ParseOptions {
  subagentId?: string;
  parentStepId?: string;
  /** Offset so subagent steps sort after their parent step. */
  indexOffset?: number;
}

/** Strip Cursor's wrapper tags from a user message, leaving the human-typed request. */
export function extractUserQuery(text: string): { query: string; timestamp?: number } {
  const tsMatch = text.match(/<timestamp>([^<]+)<\/timestamp>/);
  const timestamp = tsMatch ? parseTimestamp(tsMatch[1]) : undefined;
  const q = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  let query = q ? q[1] : text;
  query = query
    .replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/g, '') // remaining wrapper blocks
    .replace(/\[Image\]/g, '')
    .trim();
  return { query, timestamp };
}

function parseTimestamp(s: string): number | undefined {
  // "Sunday, Sep 13, 2026, 12:19 PM (UTC-4)"
  const cleaned = s.replace(/^[A-Za-z]+,\s*/, '').replace(/\s*\(UTC([+-]\d+)\)\s*$/, ' GMT$1');
  const t = Date.parse(cleaned);
  return Number.isNaN(t) ? undefined : t;
}

/** Parse the full JSONL text of a transcript. Tolerates truncated trailing lines. */
export function parseTranscript(conversationId: string, jsonl: string, opts: ParseOptions = {}): ParsedTranscript {
  const lines = jsonl.split('\n');
  const steps: ActivityStep[] = [];
  const turns: Turn[] = [];
  let turnIndex = -1;
  let seq = opts.indexOffset ?? 0;
  let lastTimestamp: number | undefined;
  let title = '';
  /** Whether the most recent assistant line included any tool_use blocks. */
  let lastAssistantHadToolUse = false;
  let sawAssistantMessage = false;

  const currentTurn = (): Turn => {
    if (turnIndex < 0) {
      turnIndex = 0;
      turns.push({ index: 0, status: 'active', stepIds: [] });
    }
    return turns[turnIndex];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj: TranscriptLine;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // partial write while the agent is mid-stream
    }

    if (obj.type === 'turn_ended') {
      const t = turns[turnIndex];
      if (t) {
        t.status = obj.status === 'error' ? 'error' : obj.status === 'aborted' ? 'aborted' : 'success';
        // Mark still-running steps of this turn as done/error.
        for (const id of t.stepIds) {
          const s = steps.find((x) => x.id === id);
          if (s && s.status === 'running') s.status = t.status === 'error' ? 'error' : 'done';
        }
      }
      continue;
    }

    const content = obj.message?.content ?? [];

    if (obj.role === 'user') {
      // Tool results are also sent with role "user" in Anthropic-style transcripts; ignore those.
      const textBlocks = content.filter((b): b is { type: 'text'; text: string } => b.type === 'text');
      const hasToolResult = content.some((b) => b.type === 'tool_result');
      if (!textBlocks.length || (hasToolResult && !textBlocks.some((b) => /<user_query>/.test(b.text)))) continue;
      const { query, timestamp } = extractUserQuery(textBlocks.map((b) => b.text).join('\n'));
      if (!query && !timestamp) continue;
      // Close previous turn if the transcript never wrote turn_ended.
      const prev = turns[turnIndex];
      if (prev && prev.status === 'active') prev.status = 'success';
      turnIndex = turns.length;
      turns.push({ index: turnIndex, userRequest: query, timestamp, status: 'active', stepIds: [] });
      if (timestamp) lastTimestamp = timestamp;
      if (!title && query) title = query.split('\n')[0].slice(0, 80);
      continue;
    }

    if (obj.role === 'assistant') {
      sawAssistantMessage = true;
      lastAssistantHadToolUse = content.some((b) => b.type === 'tool_use');
      const turn = currentTurn();
      let narration = '';
      for (const block of content) {
        if (block.type === 'text') {
          const text = String((block as { text: string }).text ?? '')
            .replace(/\[REDACTED\]/g, '')
            .trim();
          if (text) narration = narration ? `${narration}\n${text}` : text;
          turn.finalResponse = text || turn.finalResponse;
        } else if (block.type === 'tool_use') {
          const tb = block as { name: string; input?: Record<string, unknown>; id?: string };
          const toolName = normalizeToolName(tb.name);
          const input = tb.input ?? {};
          const step: ActivityStep = {
            id: opts.subagentId ? `${conversationId}:${opts.subagentId}:${seq}` : `${conversationId}:${seq}`,
            conversationId,
            turnIndex: turn.index,
            index: seq++,
            timestamp: lastTimestamp,
            toolName,
            category: categorizeTool(toolName, input),
            input,
            status: 'running',
            narration: narration || undefined,
            source: 'transcript',
            subagentId: opts.subagentId,
            parentStepId: opts.parentStepId,
          };
          narration = '';
          steps.push(step);
          turn.stepIds.push(step.id);
        }
      }
    }
  }

  // Cursor often omits `turn_ended` until the next user message. When the transcript ends with a
  // text-only assistant reply after tools ran, the agent is done — close the turn so the loader
  // can lift. A lone planning line before any tools stays active (more lines may still arrive).
  const lastTurn = turns[turns.length - 1];
  if (lastTurn?.status === 'active' && sawAssistantMessage && !lastAssistantHadToolUse && lastTurn.stepIds.length > 0) {
    lastTurn.status = 'success';
  }

  // All steps except the very last batch are necessarily done (the agent moved on).
  for (const s of steps) {
    if (s.status === 'running' && (!lastTurn || s.turnIndex !== lastTurn.index || lastTurn.status !== 'active')) {
      s.status = 'done';
    }
  }
  if (lastTurn?.status === 'active') {
    // Everything but the final tool batch is done.
    const ids = lastTurn.stepIds;
    const lastBatchStart = findLastBatchStart(steps, ids);
    ids.forEach((id, i) => {
      const s = steps.find((x) => x.id === id);
      if (s && i < lastBatchStart) s.status = 'done';
    });
  }

  return { conversationId, turns, steps, title: title || 'Untitled chat' };
}

/** Steps created from the same assistant message share `narration` reset — approximate by index gaps. */
function findLastBatchStart(steps: ActivityStep[], ids: string[]): number {
  if (!ids.length) return 0;
  // Steps are appended in order; the last assistant message's tool_use blocks are contiguous
  // and the first of them carries the narration. Walk back until we hit a narrated step.
  for (let i = ids.length - 1; i >= 0; i--) {
    const s = steps.find((x) => x.id === ids[i]);
    if (s?.narration) return i;
  }
  return Math.max(0, ids.length - 1);
}
