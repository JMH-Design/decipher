import type { ActivityStep, Turn } from '../../../../shared/activity-schema';
import { categorizeTool } from '../toolCategorizer';
import type { ParsedTranscript, ParseOptions } from '../transcriptParser';
import { normalizeCopilotTool } from './copilotTools';

/**
 * GitHub Copilot Chat transcripts are a typed event stream, one JSON object per line:
 *
 *   {"type":"tool.execution_start","data":{…},"id":"…","timestamp":"…","parentId":"…"}
 *
 * Unlike Cursor, Copilot reliably writes `assistant.turn_end`, so turn completion needs no
 * inference — and because tool starts and completions are separate events, Decipher gets
 * durations and success/failure without any hook installed.
 */

interface CopilotEvent {
  type?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

export function parseCopilotTranscript(conversationId: string, jsonl: string, opts: ParseOptions = {}): ParsedTranscript {
  const steps: ActivityStep[] = [];
  const turns: Turn[] = [];
  const pending = new Map<string, { step: ActivityStep; startedAt?: number }>();
  let turnIndex = -1;
  let seq = opts.indexOffset ?? 0;
  let lastTimestamp: number | undefined;
  let narration = '';
  let title = '';

  const currentTurn = (): Turn => {
    if (turnIndex < 0) {
      turnIndex = 0;
      turns.push({ index: 0, status: 'active', stepIds: [] });
    }
    return turns[turnIndex];
  };

  for (const raw of jsonl.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let event: CopilotEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // partial write while the agent is mid-stream
    }

    const data = event.data ?? {};
    const at = parseIso(event.timestamp);
    if (at) lastTimestamp = at;

    switch (event.type) {
      case 'user.message': {
        const request = String(data.content ?? '').trim();
        const previous = turns[turnIndex];
        if (previous && previous.status === 'active') previous.status = 'success';
        turnIndex = turns.length;
        turns.push({ index: turnIndex, userRequest: request, timestamp: at, status: 'active', stepIds: [] });
        narration = '';
        if (!title && request) title = request.split('\n')[0].slice(0, 80);
        break;
      }

      // Copilot runs several rounds per user request, each its own turn_start/turn_end pair.
      // Re-opening the turn matters: a trailing turn_start with no end means work is still in
      // flight, and the loading overlay keys off the last turn being active.
      case 'assistant.turn_start':
        currentTurn().status = 'active';
        break;

      case 'assistant.message': {
        const turn = currentTurn();
        const text = String(data.content ?? '').trim();
        if (text) {
          narration = narration ? `${narration}\n${text}` : text;
          turn.finalResponse = text;
        }
        break;
      }

      case 'tool.execution_start': {
        const turn = currentTurn();
        const { toolName, input } = normalizeCopilotTool(String(data.toolName ?? 'unknown'), data.arguments);
        const step: ActivityStep = {
          id: opts.subagentId ? `${conversationId}:${opts.subagentId}:${seq}` : `${conversationId}:${seq}`,
          conversationId,
          turnIndex: turn.index,
          index: seq++,
          timestamp: at ?? lastTimestamp,
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
        const callId = data.toolCallId;
        if (typeof callId === 'string') pending.set(callId, { step, startedAt: at });
        break;
      }

      case 'tool.execution_complete': {
        const callId = String(data.toolCallId ?? '');
        const entry = pending.get(callId);
        if (!entry) break;
        pending.delete(callId);
        const failed = data.success === false;
        entry.step.status = failed ? 'error' : 'done';
        if (failed) entry.step.errorMessage = errorText(data);
        const output = resultText(data);
        if (output) entry.step.output = output;
        if (at && entry.startedAt) entry.step.durationMs = Math.max(0, at - entry.startedAt);
        break;
      }

      case 'assistant.turn_end': {
        const turn = turns[turnIndex];
        if (!turn) break;
        turn.status = 'success';
        for (const id of turn.stepIds) {
          const step = steps.find((s) => s.id === id);
          if (step?.status === 'running') step.status = 'done';
        }
        break;
      }
    }
  }

  return { conversationId, turns, steps, title: title || 'Untitled chat' };
}

function resultText(data: Record<string, unknown>): string | undefined {
  const value = data.result ?? data.output ?? data.content;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return JSON.stringify(value).slice(0, 4000);
  return undefined;
}

function errorText(data: Record<string, unknown>): string | undefined {
  const value = data.error ?? data.errorMessage;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return String((value as { message?: unknown }).message ?? JSON.stringify(value));
  return undefined;
}

function parseIso(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}
