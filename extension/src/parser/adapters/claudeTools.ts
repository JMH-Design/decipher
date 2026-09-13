import { normalizeToolName } from '../toolCategorizer';
import type { NormalizedTool } from './copilotTools';

/**
 * Claude Code's tool vocabulary is close to Cursor's — both descend from the same
 * Anthropic tool set — but the argument keys use snake_case file paths (`file_path` rather
 * than `path`) and a few tools have no Cursor equivalent (`Skill`, `SlashCommand`).
 */

const CLAUDE_ALIASES: Record<string, string> = {
  MultiEdit: 'StrReplace',
  NotebookEdit: 'EditNotebook',
  BashOutput: 'AwaitShell',
  SlashCommand: 'Skill',
  ExitPlanMode: 'SwitchMode',
  EnterPlanMode: 'SwitchMode',
  AskUserQuestion: 'AskQuestion',
};

/** Claude exposes MCP tools as `mcp__<server>__<tool>`. */
const MCP_TOOL = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/;

export function normalizeClaudeTool(rawName: string, rawInput: unknown): NormalizedTool {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;

  const mcp = MCP_TOOL.exec(rawName);
  if (mcp) return { toolName: 'CallDynamicTool', input: { namespace: mcp[1], toolName: mcp[2], arguments: input } };

  const toolName = CLAUDE_ALIASES[rawName] ?? normalizeToolName(rawName);
  return { toolName, input: remapInput(toolName, rawName, input) };
}

function remapInput(toolName: string, rawName: string, i: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case 'Read':
      return { ...i, path: i.file_path ?? i.path };
    case 'Write':
      return { ...i, path: i.file_path ?? i.path, contents: i.content ?? i.contents };
    case 'StrReplace':
      return { ...i, path: i.file_path ?? i.path, ...(rawName === 'MultiEdit' ? multiEdit(i.edits) : {}) };
    case 'Delete':
      return { ...i, path: i.file_path ?? i.path };
    case 'EditNotebook':
      return { ...i, target_notebook: i.notebook_path ?? i.target_notebook, is_new_cell: i.edit_mode === 'insert' };
    case 'AwaitShell':
      return { ...i, shell_id: i.bash_id ?? i.shell_id };
    case 'Glob':
      return { ...i, glob_pattern: i.pattern ?? i.glob_pattern, target_directory: i.path };
    case 'WebSearch':
      return { ...i, search_term: i.query ?? i.search_term };
    case 'Skill':
      return { ...i, skill: i.skill ?? String(i.command ?? '').replace(/^\//, ''), args: i.args ?? i.command };
    case 'SwitchMode':
      return { ...i, target_mode_id: rawName === 'ExitPlanMode' ? 'agent' : 'plan', explanation: i.plan ?? i.explanation };
    default:
      return i;
  }
}

function multiEdit(value: unknown): Record<string, unknown> {
  const edits = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
  return {
    old_string: edits.map((e) => String(e.old_string ?? '')).join('\n'),
    new_string: edits.map((e) => String(e.new_string ?? '')).join('\n'),
    replace_all: edits.length > 1,
  };
}
