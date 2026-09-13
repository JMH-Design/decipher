import { normalizeToolName } from '../toolCategorizer';

/**
 * Copilot names its tools differently from Cursor and passes different argument keys
 * (`filePath` rather than `path`, `query` rather than `pattern`). The explanation templates
 * are written against Cursor's vocabulary, so adapters translate once, here, and everything
 * downstream stays provider-agnostic.
 */

export interface NormalizedTool {
  toolName: string;
  input: Record<string, unknown>;
}

const COPILOT_ALIASES: Record<string, string> = {
  read_file: 'Read',
  create_file: 'Write',
  create_directory: 'Write',
  replace_string_in_file: 'StrReplace',
  multi_replace_string_in_file: 'StrReplace',
  insert_edit_into_file: 'StrReplace',
  apply_patch: 'StrReplace',
  edit_notebook_file: 'EditNotebook',
  run_in_terminal: 'Shell',
  create_and_run_task: 'Shell',
  run_task: 'Shell',
  get_terminal_output: 'AwaitShell',
  runTests: 'RunTests',
  get_errors: 'ReadLints',
  test_failure: 'ReadLints',
  semantic_search: 'Grep',
  grep_search: 'Grep',
  file_search: 'Glob',
  list_dir: 'Glob',
  test_search: 'Glob',
  fetch_webpage: 'WebFetch',
  open_simple_browser: 'WebFetch',
  github_repo: 'WebFetch',
  manage_todo_list: 'TodoWrite',
  think: 'Think',
};

/** Copilot exposes MCP tools as `mcp_<server>_<tool>`. */
const MCP_TOOL = /^mcp_([^_]+)_(.+)$/;

export function normalizeCopilotTool(rawName: string, rawArgs: unknown): NormalizedTool {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;

  const mcp = MCP_TOOL.exec(rawName);
  if (mcp) return { toolName: 'CallDynamicTool', input: { namespace: mcp[1], toolName: mcp[2], arguments: args } };

  const toolName = COPILOT_ALIASES[rawName] ?? normalizeToolName(rawName);
  return { toolName, input: remapArgs(toolName, rawName, args) };
}

function remapArgs(toolName: string, rawName: string, a: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case 'Read': {
      const start = num(a.startLine);
      const end = num(a.endLine);
      return { ...a, path: a.filePath ?? a.path, offset: start, limit: start !== undefined && end !== undefined ? Math.max(1, end - start + 1) : undefined };
    }
    case 'Write':
      return { ...a, path: a.filePath ?? a.path, contents: a.content ?? a.contents };
    case 'StrReplace':
      return { ...a, ...editArgs(rawName, a), path: a.filePath ?? a.path };
    case 'EditNotebook':
      return { ...a, target_notebook: a.filePath ?? a.notebookUri, is_new_cell: a.editType === 'insert' };
    case 'Shell':
      return { ...a, command: a.command ?? a.task ?? '', description: a.explanation ?? a.description };
    case 'AwaitShell':
      return { ...a, shell_id: a.id ?? a.terminalId };
    case 'RunTests':
      return { ...a, paths: a.files ?? a.paths };
    case 'ReadLints':
      return { ...a, paths: a.filePaths ?? a.paths };
    case 'Grep':
      return { ...a, pattern: a.query ?? a.pattern, glob: a.includePattern ?? a.glob };
    case 'Glob':
      return { ...a, glob_pattern: a.query ?? a.path ?? a.glob_pattern, target_directory: a.path };
    case 'WebFetch':
      return { ...a, url: firstUrl(a) };
    case 'TodoWrite':
      return { ...a, todos: todoList(a.todoList), merge: a.operation !== 'write' };
    case 'Think':
      return { ...a, message: a.thoughts ?? a.thought ?? a.message };
    default:
      return a;
  }
}

/** `multi_replace_string_in_file` and `apply_patch` carry the edit somewhere other than the top level. */
function editArgs(rawName: string, a: Record<string, unknown>): Record<string, unknown> {
  if (rawName === 'insert_edit_into_file') return { old_string: '', new_string: a.code ?? '' };
  if (rawName === 'apply_patch') return { old_string: '', new_string: a.input ?? a.patch ?? '' };
  if (rawName === 'multi_replace_string_in_file') {
    const edits = Array.isArray(a.edits) ? (a.edits as Array<Record<string, unknown>>) : [];
    return {
      old_string: edits.map((e) => String(e.oldString ?? '')).join('\n'),
      new_string: edits.map((e) => String(e.newString ?? '')).join('\n'),
      replace_all: edits.length > 1,
    };
  }
  return { old_string: a.oldString ?? a.old_string ?? '', new_string: a.newString ?? a.new_string ?? '' };
}

const TODO_STATUS: Record<string, string> = { 'not-started': 'pending', 'in-progress': 'in_progress', completed: 'completed' };

function todoList(value: unknown): Array<{ content: string; status: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    return { content: String(t.title ?? t.content ?? ''), status: TODO_STATUS[String(t.status ?? '')] ?? 'pending' };
  });
}

function firstUrl(a: Record<string, unknown>): string {
  if (typeof a.url === 'string') return a.url;
  if (Array.isArray(a.urls) && typeof a.urls[0] === 'string') return a.urls[0];
  if (typeof a.repo === 'string') return `https://github.com/${a.repo}`;
  return '';
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
