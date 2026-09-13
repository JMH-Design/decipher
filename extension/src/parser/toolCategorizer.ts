import type { StepCategory } from '../../../shared/activity-schema';
import { splitShellCommand, firstProgram } from './shellParser';

/**
 * Cursor's hooks and transcripts do not always agree on tool names
 * (e.g. `run_terminal_cmd` vs `Shell`). Normalize to the transcript vocabulary.
 */
const TOOL_ALIASES: Record<string, string> = {
  run_terminal_cmd: 'Shell',
  run_terminal_command: 'Shell',
  bash: 'Shell',
  Bash: 'Shell',
  read_file: 'Read',
  read: 'Read',
  write: 'Write',
  write_file: 'Write',
  edit_file: 'StrReplace',
  search_replace: 'StrReplace',
  edit: 'StrReplace',
  Edit: 'StrReplace',
  MultiEdit: 'StrReplace',
  delete_file: 'Delete',
  grep: 'Grep',
  grep_search: 'Grep',
  codebase_search: 'Grep',
  glob: 'Glob',
  glob_file_search: 'Glob',
  file_search: 'Glob',
  list_dir: 'Glob',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  fetch: 'WebFetch',
  todo_write: 'TodoWrite',
  create_plan: 'CreatePlan',
  ask_question: 'AskQuestion',
  task: 'Task',
  read_lints: 'ReadLints',
  switch_mode: 'SwitchMode',
  edit_notebook: 'EditNotebook',
};

export function normalizeToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

const GIT_CHECKING = new Set(['status', 'diff', 'log', 'show', 'branch', 'remote', 'rev-parse', 'blame', 'stash']);
const GIT_SAVING = new Set(['add', 'commit', 'push', 'pull', 'merge', 'rebase', 'tag', 'fetch', 'checkout', 'switch']);
const SEARCH_PROGRAMS = new Set(['rg', 'grep', 'ag', 'ack', 'find', 'fd', 'locate']);
const READ_PROGRAMS = new Set(['cat', 'head', 'tail', 'less', 'more', 'ls', 'tree', 'wc', 'file', 'stat', 'pwd', 'which', 'bat']);

/** Categorize a shell command by its first (or dominant) program. */
export function categorizeShell(command: string): StepCategory {
  const segments = splitShellCommand(command);
  const categories = segments.map((seg) => categorizeShellSegment(seg));
  // Prefer the most "consequential" category present in a chain.
  const priority: StepCategory[] = ['saving', 'editing', 'running', 'checking', 'searching', 'reading', 'other'];
  for (const p of priority) if (categories.includes(p)) return p;
  return 'running';
}

export function categorizeShellSegment(segment: string): StepCategory {
  const { program, args } = firstProgram(segment);
  if (!program) return 'other';
  if (program === 'git') {
    const sub = args.find((a) => !a.startsWith('-')) ?? '';
    if (GIT_SAVING.has(sub)) return 'saving';
    if (GIT_CHECKING.has(sub)) return 'checking';
    return 'running';
  }
  if (SEARCH_PROGRAMS.has(program)) return 'searching';
  if (READ_PROGRAMS.has(program)) return 'reading';
  if (['echo', 'printf'].includes(program) && args.includes('>')) return 'editing';
  if (['rm', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'sed', 'tee'].includes(program)) return 'editing';
  return 'running';
}

export function categorizeTool(toolName: string, input: Record<string, unknown>): StepCategory {
  const name = normalizeToolName(toolName);
  switch (name) {
    case 'Read':
    case 'Glob':
    case 'ReadLints':
      return 'reading';
    case 'Grep':
      return 'searching';
    case 'Write':
    case 'StrReplace':
    case 'Delete':
    case 'EditNotebook':
      return 'editing';
    case 'Shell':
      return categorizeShell(String(input.command ?? ''));
    case 'AwaitShell':
      return 'running';
    case 'AskQuestion':
      return 'asking';
    case 'TodoWrite':
    case 'CreatePlan':
    case 'UpdateCurrentStep':
    case 'SwitchMode':
      return 'planning';
    case 'Task':
      return 'delegating';
    case 'WebSearch':
    case 'WebFetch':
      return 'browsing';
    case 'CallDynamicTool':
    case 'GetDynamicTools':
    case 'FetchMcpResource':
      return 'external';
    case 'SendToUser':
      return 'thinking';
    default:
      if (/^mcp_|^browser_/i.test(name)) return 'external';
      return 'other';
  }
}

export const CATEGORY_LABELS: Record<StepCategory, string> = {
  reading: 'Looking at files',
  searching: 'Searching the project',
  editing: 'Changing files',
  running: 'Running a command',
  checking: 'Reviewing changes',
  saving: 'Saving / uploading changes',
  asking: 'Waiting for your answer',
  planning: 'Planning next steps',
  delegating: 'Working on a sub-task',
  external: 'Using an outside tool',
  browsing: 'Looking something up online',
  thinking: 'Explaining',
  other: 'Doing something else',
};
