import type { ActivityStep, HookEvent, Turn } from '../../../shared/activity-schema';
import { categorizeTool, normalizeToolName } from '../parser/toolCategorizer';

export interface MergeResult {
  steps: ActivityStep[];
  turns: Turn[];
  /** Prompts captured by beforeSubmitPrompt, in order. */
  prompts: string[];
}

/**
 * Enrich transcript-derived steps with the tool outputs, durations, edits and failures
 * that only hooks provide. Transcripts do not record tool_use ids, so matching is by
 * (tool, key input) against the earliest step that has not been enriched yet.
 *
 * Also creates hook-only steps when the transcript has not caught up (or transcripts are
 * disabled), so the panel still updates live.
 */
export function mergeHookEvents(conversationId: string, steps: ActivityStep[], turns: Turn[], events: HookEvent[]): MergeResult {
  const out = steps.map((s) => ({ ...s }));
  const enriched = new Set<string>();
  const prompts: string[] = [];
  let nextIndex = out.length ? Math.max(...out.map((s) => s.index)) + 1 : 0;
  const lastTurn = () => turns[turns.length - 1];

  const findStep = (toolName: string, key: (s: ActivityStep) => boolean): ActivityStep | undefined => {
    return out.find((s) => s.toolName === toolName && !enriched.has(s.id) && key(s));
  };

  for (const ev of events) {
    const ts = Date.parse(ev.ts);
    switch (ev.hook) {
      case 'beforeSubmitPrompt': {
        if (ev.prompt) prompts.push(ev.prompt);
        break;
      }
      case 'afterShellExecution': {
        const cmd = (ev.command ?? '').trim();
        const step = findStep('Shell', (s) => String(s.input.command ?? '').trim() === cmd);
        if (step) {
          step.output = ev.output;
          step.durationMs = ev.durationMs;
          step.status = step.status === 'running' ? 'done' : step.status;
          step.source = 'hook';
          enriched.add(step.id);
        } else {
          out.push(hookStep(conversationId, nextIndex++, ts, 'Shell', { command: cmd }, ev.output, ev.durationMs, lastTurn()));
        }
        break;
      }
      case 'postToolUse':
      case 'postToolUseFailure': {
        const toolName = normalizeToolName(ev.toolName ?? '');
        if (!toolName) break;
        const input = ev.toolInput ?? {};
        const step = findStep(toolName, (s) => sameKeyInput(s.input, input));
        const failed = ev.hook === 'postToolUseFailure';
        if (step) {
          if (ev.toolOutput !== undefined && step.output === undefined) step.output = ev.toolOutput;
          step.durationMs = ev.durationMs ?? step.durationMs;
          if (failed) {
            step.status = 'error';
            step.errorMessage = ev.errorMessage;
          } else if (step.status === 'running') step.status = 'done';
          enriched.add(step.id);
        } else if (toolName !== 'Shell' || !out.some((s) => s.toolName === 'Shell' && String(s.input.command ?? '').trim() === String(input.command ?? '').trim())) {
          const created = hookStep(conversationId, nextIndex++, ts, toolName, input, ev.toolOutput, ev.durationMs, lastTurn());
          if (failed) {
            created.status = 'error';
            created.errorMessage = ev.errorMessage;
          }
          out.push(created);
        }
        break;
      }
      case 'afterFileEdit': {
        // Edits arrive as {old_string,new_string}; attach them so concept detection sees hook-only edits too.
        const file = ev.filePath ?? '';
        const step = out.find((s) => ['StrReplace', 'Write'].includes(s.toolName) && String(s.input.path ?? '') === file && !s.output);
        if (step) {
          step.output = `edited ${ev.edits?.length ?? 1} block(s)`;
        } else if (ev.edits?.length && !out.some((s) => String(s.input.path ?? '') === file)) {
          const edit = ev.edits[0];
          out.push(hookStep(conversationId, nextIndex++, ts, 'StrReplace', { path: file, old_string: edit.old_string ?? '', new_string: edit.new_string ?? '' }, undefined, undefined, lastTurn()));
        }
        break;
      }
      case 'subagentStop': {
        const step = out.find((s) => s.toolName === 'Task' && !enriched.has(s.id) && (!ev.subagentType || String(s.input.subagent_type) === ev.subagentType));
        if (step) {
          step.output = ev.summary;
          step.durationMs = ev.durationMs;
          step.status = ev.status === 'error' ? 'error' : 'done';
          enriched.add(step.id);
        }
        break;
      }
      case 'stop': {
        const t = lastTurn();
        if (t && t.status === 'active') t.status = ev.status === 'error' ? 'error' : ev.status === 'aborted' ? 'aborted' : 'success';
        break;
      }
      default:
        break;
    }
  }

  // Fill in turn prompts from hooks when the transcript lacks them.
  turns.forEach((t, i) => {
    if (!t.userRequest && prompts[i]) t.userRequest = prompts[i];
  });

  out.sort((a, b) => a.index - b.index);
  return { steps: out, turns, prompts };
}

function hookStep(conversationId: string, index: number, ts: number, toolName: string, input: Record<string, unknown>, output: string | undefined, durationMs: number | undefined, turn: Turn | undefined): ActivityStep {
  const step: ActivityStep = {
    id: `${conversationId}:hook:${index}`,
    conversationId,
    turnIndex: turn?.index ?? 0,
    index,
    timestamp: Number.isNaN(ts) ? undefined : ts,
    toolName,
    category: categorizeTool(toolName, input),
    input,
    output,
    durationMs,
    status: 'done',
    source: 'hook',
  };
  turn?.stepIds.push(step.id);
  return step;
}

const KEY_FIELDS = ['command', 'path', 'file_path', 'pattern', 'glob_pattern', 'url', 'search_term', 'toolName', 'prompt'];

function sameKeyInput(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const k of KEY_FIELDS) {
    if (k in a || k in b) return String(a[k] ?? '').trim() === String(b[k] ?? '').trim();
  }
  return true;
}
