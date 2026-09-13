import type { ActivityStep, Turn } from '../../../../shared/activity-schema';
import { categorizeTool } from '../toolCategorizer';
import type { ParsedTranscript, ParseOptions } from '../transcriptParser';
import { normalizeClaudeTool } from './claudeTools';

/**
 * Claude Code transcripts are Anthropic-style message records, one per line:
 *
 *   {"type":"assistant","message":{"role":"assistant","content":[…]},"uuid":"…","isSidechain":false}
 *
 * Three things make them different from Cursor's:
 *  - tool results come back as `user` messages, so most `user` lines are not the human talking;
 *  - subagent work is interleaved in the same file, flagged with `isSidechain: true`;
 *  - `stop_reason: "end_turn"` says the agent is finished, so turn completion is explicit.
 *
 * Bookkeeping-only lines (`custom-title`, `mode`, `file-history-snapshot`, …) are ignored.
 */

interface ClaudeRecord {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  timestamp?: string;
  uuid?: string;
  message?: { role?: string; model?: string; stop_reason?: string | null; content?: unknown };
  toolUseResult?: unknown;
}

type ContentBlock = { type?: string; [key: string]: unknown };

/** Wrapper blocks Claude injects into user messages that are not the human speaking. */
const INJECTED_BLOCK = /<(ide_opened_file|command-name|command-message|command-args|local-command-stdout|system-reminder)>[\s\S]*?<\/\1>/g;
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

export function parseClaudeTranscript(conversationId: string, jsonl: string, opts: ParseOptions = {}): ParsedTranscript {
  const steps: ActivityStep[] = [];
  const turns: Turn[] = [];
  const byToolUseId = new Map<string, ActivityStep>();
  let turnIndex = -1;
  let seq = opts.indexOffset ?? 0;
  let lastTimestamp: number | undefined;
  let title = '';
  let agentModel: string | undefined;
  /** Sidechain steps belong to the Task that spawned them, not to the main timeline. */
  let lastTaskStep: ActivityStep | undefined;
  let sawTools = false;
  let lastAssistantHadToolUse = false;

  const currentTurn = (): Turn => {
    if (turnIndex < 0) {
      turnIndex = 0;
      turns.push({ index: 0, status: 'active', stepIds: [] });
    }
    return turns[turnIndex];
  };

  const closeTurn = (status: Turn['status']): void => {
    const turn = turns[turnIndex];
    if (!turn || turn.status !== 'active') return;
    turn.status = status;
    for (const id of turn.stepIds) {
      const step = steps.find((s) => s.id === id);
      if (step?.status === 'running') step.status = status === 'error' ? 'error' : 'done';
    }
  };

  for (const raw of jsonl.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let record: ClaudeRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // partial write while the agent is mid-stream
    }

    const at = parseIso(record.timestamp);
    if (at) lastTimestamp = at;

    if (record.type === 'system') {
      // `turn_duration` is written once the agent stops working, so it closes the turn.
      if (record.subtype === 'turn_duration') closeTurn('success');
      continue;
    }

    if (record.type !== 'user' && record.type !== 'assistant') continue;
    const blocks = contentBlocks(record.message?.content);

    if (record.type === 'user') {
      applyToolResults(blocks, byToolUseId, record.toolUseResult);
      // Tool results and injected context arrive as `user` lines; only real prose starts a turn.
      if (record.isSidechain || record.isMeta) continue;
      const request = humanText(blocks);
      if (!request) continue;
      closeTurn('success');
      turnIndex = turns.length;
      turns.push({ index: turnIndex, userRequest: request, timestamp: at, status: 'active', stepIds: [] });
      if (!title) title = request.split('\n')[0].slice(0, 80);
      continue;
    }

    if (record.message?.model) agentModel = record.message.model;
    if (record.isApiErrorMessage) {
      closeTurn('error');
      continue;
    }

    const sidechain = Boolean(record.isSidechain) && Boolean(lastTaskStep);
    const turn = sidechain ? turns[lastTaskStep!.turnIndex] ?? currentTurn() : currentTurn();
    let narration = '';
    let hadToolUse = false;

    for (const block of blocks) {
      if (block.type === 'text') {
        const text = String(block.text ?? '').trim();
        if (!text) continue;
        narration = narration ? `${narration}\n${text}` : text;
        if (!sidechain) turn.finalResponse = text;
        continue;
      }
      if (block.type !== 'tool_use') continue;

      hadToolUse = true;
      sawTools = true;
      const { toolName, input } = normalizeClaudeTool(String(block.name ?? 'unknown'), block.input);
      const subagentId = sidechain ? lastTaskStep!.id : opts.subagentId;
      const step: ActivityStep = {
        id: subagentId ? `${conversationId}:${subagentId}:${seq}` : `${conversationId}:${seq}`,
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
        subagentId,
        parentStepId: sidechain ? lastTaskStep!.id : opts.parentStepId,
      };
      narration = '';
      steps.push(step);
      // Sidechain steps hang off their Task card, so they must not appear in the turn's own list.
      if (!sidechain) turn.stepIds.push(step.id);
      if (typeof block.id === 'string') byToolUseId.set(block.id, step);
      if (toolName === 'Task' && !sidechain) lastTaskStep = step;
    }

    if (!sidechain) lastAssistantHadToolUse = hadToolUse;
    // `end_turn` is Claude saying it has nothing left to do.
    const stop = record.message?.stop_reason;
    if (!sidechain && (stop === 'end_turn' || stop === 'stop_sequence')) closeTurn('success');
  }

  // Older Claude builds omit `stop_reason` on the final message. Same rule as the Cursor
  // parser: a text-only reply after tools have run means the agent is done.
  const lastTurn = turns[turns.length - 1];
  if (lastTurn?.status === 'active' && sawTools && !lastAssistantHadToolUse && lastTurn.stepIds.length > 0) {
    lastTurn.status = 'success';
    for (const id of lastTurn.stepIds) {
      const step = steps.find((s) => s.id === id);
      if (step?.status === 'running') step.status = 'done';
    }
  }

  for (const step of steps) {
    if (step.status === 'running' && (!lastTurn || step.turnIndex !== lastTurn.index || lastTurn.status !== 'active')) step.status = 'done';
  }

  return { conversationId, turns, steps, title: title || 'Untitled chat', agentModel };
}

function contentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content.filter((b): b is ContentBlock => Boolean(b) && typeof b === 'object');
  return [];
}

/** Resolve the steps whose results just came back. */
function applyToolResults(blocks: ContentBlock[], byToolUseId: Map<string, ActivityStep>, toolUseResult: unknown): void {
  for (const block of blocks) {
    if (block.type !== 'tool_result') continue;
    const step = typeof block.tool_use_id === 'string' ? byToolUseId.get(block.tool_use_id) : undefined;
    if (!step) continue;
    const failed = block.is_error === true;
    step.status = failed ? 'error' : 'done';
    const text = resultText(block.content) || resultText(toolUseResult);
    if (failed) step.errorMessage = text || 'The tool reported an error.';
    else if (text) step.output = text;
  }
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 4000);
  if (Array.isArray(value)) {
    return value
      .map((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n')
      .slice(0, 4000);
  }
  if (value && typeof value === 'object') return JSON.stringify(value).slice(0, 4000);
  return '';
}

/** The human's words, with Claude's injected context blocks removed. */
function humanText(blocks: ContentBlock[]): string {
  return cleanClaudePrompt(
    blocks
      .filter((b) => b.type === 'text')
      .map((b) => String(b.text ?? ''))
      .join('\n'),
  );
}

/**
 * Strip Claude's wrapper tags from a raw prompt. Exported because `sessions-index.json`
 * stores `firstPrompt` verbatim, tags and all, and it becomes the conversation title.
 *
 * A slash command is nothing but wrapper tags, so stripping them would leave an empty
 * request. `/design` is what the user typed, so that is what we keep.
 */
export function cleanClaudePrompt(raw: string): string {
  const command = COMMAND_NAME.exec(raw)?.[1]?.trim();
  const text = raw.replace(INJECTED_BLOCK, '').trim();
  if (!text && command) {
    const args = COMMAND_ARGS.exec(raw)?.[1]?.trim();
    return args ? `${command} ${args}` : command;
  }
  // A caveat-only line ("Caveat: The messages below were generated by…") is not a request.
  return /^caveat:/i.test(text) ? '' : text;
}

function parseIso(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}
