import type { Explanation } from '../../../../shared/activity-schema';
import { friendlyFile, pluralize, shortPath } from '../friendlyNames';
import { countSearchMatches, firstLine } from '../outputParsers';
import { makeExplanation, type Template, type TemplateContext } from '../types';

const str = (v: unknown, max = 200): string => {
  const s = v === undefined || v === null ? '' : String(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

function tool(names: string | string[], id: string, build: (ctx: TemplateContext) => Partial<Explanation> & Pick<Explanation, 'title' | 'summary'>): Template {
  const list = Array.isArray(names) ? names : [names];
  return {
    id: `tool.${id}`,
    match: (ctx) => (list.includes(ctx.toolName) ? 1 : 0),
    explain: (ctx) => {
      const e = build(ctx);
      return makeExplanation({ ...e, templateId: `tool.${id}`, vocabulary: ['tool-call', ...(e.vocabulary ?? [])] });
    },
  };
}

function editIntent(ctx: TemplateContext): string | undefined {
  // Narration like "Now `.hf-word` in CSS, then FieldHero props." is the best intent signal we have.
  const n = ctx.step.narration;
  if (!n) return undefined;
  const line = firstLine(n.replace(/\*\*/g, ''), 140).replace(/[.:]+$/, '');
  return line && !/^(now|next|then|ok|okay)[,.]?$/i.test(line) ? line : undefined;
}

function editSize(oldStr: unknown, newStr: unknown): string {
  const o = String(oldStr ?? '').split('\n').length;
  const n = String(newStr ?? '').split('\n').length;
  if (!String(oldStr ?? '').length) return `adding ${pluralize(n, 'line')}`;
  if (!String(newStr ?? '').length) return `removing ${pluralize(o, 'line')}`;
  if (n > o) return `replacing ${pluralize(o, 'line')} with ${n}`;
  if (n < o) return `trimming ${pluralize(o, 'line')} down to ${n}`;
  return `rewriting ${pluralize(o, 'line')}`;
}

const read = tool('Read', 'read', (ctx) => {
  const p = str(ctx.input.path);
  const f = friendlyFile(p);
  const offset = Number(ctx.input.offset ?? 0);
  const limit = Number(ctx.input.limit ?? 0);
  const range = limit > 0 ? ` (lines ${offset || 1}–${(offset || 1) + limit - 1})` : offset > 0 ? ` (from line ${offset})` : offset < 0 ? ` (the last ${-offset} lines)` : '';
  const isSkill = /SKILL\.md$/.test(p);
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(p);
  return {
    title: isSkill ? 'Reading an instruction guide' : isImage ? 'Looking at an image' : 'Reading a file',
    summary: isSkill
      ? `Read the "${p.split('/').slice(-2, -1)[0]}" skill guide to learn how to do this task well.`
      : isImage
        ? `Looked at ${f.basename}${ctx.step.narration ? '' : ' to understand what it shows'}.`
        : `Opened ${f.phrase}${range} to understand how it works.`,
    whatHappened: isSkill
      ? 'Skills are step-by-step playbooks. The agent consults one before tackling a specialised task, like an animation library.'
      : f.sensitive
        ? 'This file may contain secrets, so Decipher does not display its contents.'
        : `The agent read the file's contents into its working memory. Reading does not change anything.`,
    whyItMatters: isSkill ? undefined : 'Agents read before they write so edits fit the existing code.',
    technical: shortPath(p, ctx.workspaceRoot),
    vocabulary: isSkill ? ['skill'] : ['path', ...f.vocabulary],
  };
});

const glob = tool('Glob', 'glob', (ctx) => ({
  title: 'Finding files by name',
  summary: `Looked for files matching "${str(ctx.input.glob_pattern)}"${ctx.input.target_directory ? ` in ${shortPath(str(ctx.input.target_directory), ctx.workspaceRoot)}` : ''}.`,
  whatHappened: 'A glob is a wildcard pattern: "**/*.css" means "every .css file in any folder". This finds files by name, not contents.',
  technical: str(ctx.input.glob_pattern),
  vocabulary: ['glob', 'path'],
}));

const grep = tool('Grep', 'grep', (ctx) => {
  const pattern = str(ctx.input.pattern, 80);
  const rawPath = str(ctx.input.path);
  const where = rawPath && rawPath !== '.' && rawPath !== ctx.workspaceRoot ? `in ${shortPath(rawPath, ctx.workspaceRoot)}` : 'across the project';
  const filter = ctx.input.glob ? ` (only ${str(ctx.input.glob)} files)` : ctx.input.type ? ` (only ${str(ctx.input.type)} files)` : '';
  const out = ctx.output;
  const count = out ? countSearchMatches(out) : undefined;
  const result = count ? (count.matches ? ` Found ${pluralize(count.matches, 'match', 'matches')} in ${pluralize(count.files, 'file')}.` : ' Found nothing.') : '';
  const alternatives = pattern.includes('|') ? pattern.split('|').map((p) => `"${p.replace(/\\/g, '')}"`).join(' or ') : `"${pattern}"`;
  return {
    title: 'Searching the project',
    summary: `Searched ${where}${filter} for ${alternatives}.${result}`,
    whatHappened: `The agent ran a text search — like Ctrl+F across every file at once${ctx.input.output_mode === 'files_with_matches' ? ', asking only for the list of files that contain it' : ''}.${result}`,
    whyItMatters: 'Searching first tells the agent where something lives before it edits anything.',
    technical: pattern,
    vocabulary: ['rg', ...(/[|.*+?()\[\]\\]/.test(pattern) ? ['regex'] : []), ...(ctx.input.glob ? ['glob'] : [])],
  };
});

const write = tool('Write', 'write', (ctx) => {
  const p = str(ctx.input.path);
  const f = friendlyFile(p);
  const lines = String(ctx.input.contents ?? '').split('\n').length;
  const intent = editIntent(ctx);
  return {
    title: 'Creating or rewriting a file',
    summary: `Wrote ${f.phrase} from scratch (${pluralize(lines, 'line')})${intent ? ` — ${intent}` : ''}.`,
    whatHappened: `The agent produced the entire contents of ${f.basename}. If the file already existed it was replaced.`,
    whyItMatters: 'New files usually mean a new component, page, or configuration was added to the project.',
    technical: shortPath(p, ctx.workspaceRoot),
    vocabulary: ['file-edit', ...f.vocabulary],
  };
});

const strReplace = tool('StrReplace', 'edit', (ctx) => {
  const p = str(ctx.input.path);
  const f = friendlyFile(p);
  const intent = editIntent(ctx);
  const size = editSize(ctx.input.old_string, ctx.input.new_string);
  return {
    title: 'Editing a file',
    summary: `Updated ${f.phrase}, ${size}${intent ? ` — ${intent}` : ''}.`,
    whatHappened: `The agent found one exact block of text in ${f.basename} and swapped it for a new version${ctx.input.replace_all ? ', everywhere it appeared' : ''}. Nothing else in the file changed.`,
    whyItMatters: 'Targeted edits are safer than rewriting whole files because the rest of the code stays exactly as it was.',
    technical: shortPath(p, ctx.workspaceRoot),
    vocabulary: ['file-edit', ...f.vocabulary],
  };
});

const del = tool('Delete', 'delete', (ctx) => {
  const f = friendlyFile(str(ctx.input.path));
  return { title: 'Deleting a file', summary: `Deleted ${f.phrase}.`, whyItMatters: 'If the project uses git, the file can be restored from the last checkpoint.', technical: shortPath(str(ctx.input.path), ctx.workspaceRoot), vocabulary: ['path', 'git'] };
});

const notebook = tool('EditNotebook', 'notebook', (ctx) => ({
  title: 'Editing a notebook',
  summary: `${ctx.input.is_new_cell ? 'Added a new cell to' : 'Edited a cell in'} the notebook ${friendlyFile(str(ctx.input.target_notebook)).basename}.`,
  technical: shortPath(str(ctx.input.target_notebook), ctx.workspaceRoot),
  vocabulary: ['file-edit'],
}));

const task = tool('Task', 'task', (ctx) => {
  const type = str(ctx.input.subagent_type);
  const desc = str(ctx.input.description, 80);
  const kind: Record<string, string> = {
    explore: 'a fast helper to explore the codebase',
    generalPurpose: 'a general helper',
    'browser-use': 'a browser-testing helper',
    'cursor-guide': 'a helper that reads Cursor documentation',
    bugbot: 'an automated code reviewer',
    'security-review': 'a security reviewer',
    'best-of-n-runner': 'a parallel worker in its own copy of the project',
  };
  return {
    title: 'Delegating a sub-task',
    summary: `Handed "${desc}" to ${kind[type] ?? `a "${type}" helper agent`} and waited for its report.`,
    whatHappened: 'The main agent spun up a smaller agent with its own focused instructions. Its findings come back as a summary, keeping the main conversation uncluttered.',
    whyItMatters: 'Sub-agents let the agent research several things in parallel or run long browser checks without losing its place.',
    technical: `${type}: ${firstLine(str(ctx.input.prompt, 300), 200)}`,
    vocabulary: ['subagent', 'agent'],
  };
});

const ask = tool('AskQuestion', 'ask', (ctx) => {
  const qs = Array.isArray(ctx.input.questions) ? (ctx.input.questions as Array<{ prompt?: string }>) : [];
  const first = qs[0]?.prompt ? firstLine(qs[0].prompt, 120) : undefined;
  return {
    title: 'Asking you a question',
    summary: qs.length > 1 ? `Paused to ask you ${qs.length} questions${first ? `, starting with: "${first}"` : ''}.` : `Paused to ask: "${first ?? str(ctx.input.title)}".`,
    whatHappened: 'The agent hit a decision it did not want to make for you and stopped for input.',
    whyItMatters: 'Good agents ask before making choices that would change the outcome significantly.',
    technical: qs.map((q) => q.prompt).filter(Boolean).join(' | '),
    vocabulary: ['agent'],
  };
});

const todo = tool('TodoWrite', 'todo', (ctx) => {
  const todos = Array.isArray(ctx.input.todos) ? (ctx.input.todos as Array<{ content?: string; status?: string }>) : [];
  const done = todos.filter((t) => t.status === 'completed').map((t) => t.content).filter(Boolean);
  const started = todos.filter((t) => t.status === 'in_progress').map((t) => t.content).filter(Boolean);
  const isCreate = ctx.input.merge === false;
  const doneCount = todos.filter((t) => t.status === 'completed').length;
  const startedCount = todos.filter((t) => t.status === 'in_progress').length;
  const parts: string[] = [];
  if (done.length) parts.push(`finished "${firstLine(done[0], 70)}"${done.length > 1 ? ` and ${done.length - 1} more` : ''}`);
  else if (doneCount) parts.push(`marked ${pluralize(doneCount, 'step')} as finished`);
  if (started.length) parts.push(`started "${firstLine(started[0], 70)}"`);
  else if (startedCount) parts.push(`started the next step`);
  return {
    title: isCreate ? 'Planning the steps' : 'Updating progress',
    summary: isCreate ? `Wrote a checklist of ${pluralize(todos.length, 'step')} for this task.` : parts.length ? `Checked off progress: ${parts.join('; ')}.` : 'Updated its checklist.',
    whatHappened: 'The agent keeps a to-do list for itself so multi-step work stays organised and visible to you.',
    technical: todos.map((t) => `[${t.status}]${t.content ? ` ${t.content}` : ''}`).join('\n'),
    vocabulary: ['todo'],
  };
});

const plan = tool('CreatePlan', 'plan', (ctx) => ({
  title: 'Proposing a plan',
  summary: `Wrote up a plan called "${str(ctx.input.name, 80)}" for you to review before any changes are made.`,
  whatHappened: 'In plan mode the agent researches and proposes; nothing in the project changes until you approve.',
  technical: str(ctx.input.overview, 300),
  vocabulary: ['plan-mode'],
}));

const step = tool('UpdateCurrentStep', 'currentstep', (ctx) => ({
  title: 'Noting progress',
  summary: `Set its status to: "${str(ctx.input.current_step, 100)}".`,
  technical: str(ctx.input.current_step),
  vocabulary: [],
  confidence: 0.95,
}));

const shellWait = tool('AwaitShell', 'await', (ctx) => ({
  title: 'Waiting for a command to finish',
  summary: ctx.input.shell_id ? `Waited for a background command to finish${ctx.input.pattern ? ` or print "${str(ctx.input.pattern, 40)}"` : ''}.` : `Paused for up to ${Math.round(Number(ctx.input.block_until_ms ?? 30000) / 1000)} seconds.`,
  whatHappened: 'Long-running commands (installs, servers, tests) are left running in the background and checked on later.',
  vocabulary: ['background-process'],
}));

const lints = tool('ReadLints', 'lints', (ctx) => ({
  title: 'Checking for code problems',
  summary: `Asked the editor for any warnings or errors${Array.isArray(ctx.input.paths) && ctx.input.paths.length ? ` in ${(ctx.input.paths as string[]).map((p) => friendlyFile(p).basename).join(', ')}` : ''}.`,
  whatHappened: 'The editor continuously proofreads code; the agent reads that list after making edits to catch mistakes early.',
  vocabulary: ['lint'],
}));

const webSearch = tool('WebSearch', 'websearch', (ctx) => ({
  title: 'Searching the web',
  summary: `Searched online for "${str(ctx.input.search_term, 100)}".`,
  whatHappened: str(ctx.input.explanation) || 'The agent looked something up rather than relying on memory, which may be out of date.',
  technical: str(ctx.input.search_term),
  vocabulary: ['web-search'],
}));

const webFetch = tool('WebFetch', 'webfetch', (ctx) => {
  const url = str(ctx.input.url);
  const host = url.replace(/^https?:\/\//, '').split('/')[0];
  return {
    title: 'Reading a web page',
    summary: `Read the page at ${host}${/docs/.test(url) ? ' (documentation)' : ''}.`,
    whatHappened: 'The agent fetched a web page and read its text.',
    technical: url,
    vocabulary: ['web-search'],
  };
});

const dynamicTool = tool(['CallDynamicTool', 'GetDynamicTools', 'FetchMcpResource'], 'mcp', (ctx) => {
  const ns = str(ctx.input.namespace ?? ctx.input.server);
  const toolName = str(ctx.input.toolName ?? ctx.input.pattern ?? '');
  const service = friendlyNamespace(ns);
  if (ctx.toolName === 'GetDynamicTools') {
    return { title: 'Checking an outside tool', summary: `Looked up what ${service} can do before using it.`, technical: `${ns} ${toolName}`.trim(), vocabulary: ['mcp'] };
  }
  const isBrowser = /browser/i.test(ns) || /^browser_/.test(toolName);
  return {
    title: isBrowser ? 'Using the browser' : `Using ${service}`,
    summary: isBrowser ? describeBrowserTool(toolName, ctx.input.arguments as Record<string, unknown> | undefined) : `Used ${service} (${toolName}).`,
    whatHappened: isBrowser
      ? 'The agent controls a real browser tab to look at pages, click things, and take screenshots, the same way you would test a site by hand.'
      : 'Outside services are connected through MCP, a plug-in system that turns them into tools the agent can call.',
    technical: `${ns}.${toolName}`,
    vocabulary: isBrowser ? ['browser-automation', 'mcp'] : ['mcp', 'api'],
  };
});

function friendlyNamespace(ns: string): string {
  const cleaned = ns.replace(/^plugin-/, '').replace(/^user-/, '').split('-')[0];
  const map: Record<string, string> = { figma: 'Figma', slack: 'Slack', gmail: 'Gmail', google: 'Google', neon: 'the Neon database', context: 'Context.dev', crustdata: 'Crustdata', mobbin: 'Mobbin design references', x: 'X (Twitter)', cursor: 'a built-in Cursor tool' };
  return map[cleaned.toLowerCase()] ?? (cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : 'an outside tool');
}

function describeBrowserTool(name: string, args?: Record<string, unknown>): string {
  const a = args ?? {};
  switch (name) {
    case 'browser_navigate':
      return `Opened ${str(a.url, 80)} in the browser.`;
    case 'browser_snapshot':
      return 'Took a structured snapshot of the page to see what is on it.';
    case 'browser_take_screenshot':
      return 'Took a screenshot of the page to check how it looks.';
    case 'browser_click':
      return 'Clicked something on the page.';
    case 'browser_type':
    case 'browser_fill':
      return 'Typed into a field on the page.';
    case 'browser_press_key':
      return `Pressed the "${str(a.key)}" key.`;
    case 'browser_scroll':
      return 'Scrolled the page.';
    case 'browser_cdp':
      return `Ran a low-level browser inspection (${str(a.method, 40)}).`;
    case 'browser_lock':
      return a.action === 'unlock' ? 'Released the browser tab.' : 'Reserved the browser tab for automation.';
    case 'browser_tabs':
      return 'Checked which browser tabs are open.';
    default:
      return `Used the browser (${name}).`;
  }
}

const sendToUser = tool('SendToUser', 'send', (ctx) => ({ title: 'Sending you an update', summary: `Posted a progress message: "${firstLine(str(ctx.input.message, 200), 120)}".`, vocabulary: [] }));

const switchMode = tool('SwitchMode', 'mode', (ctx) => ({
  title: 'Asking to switch modes',
  summary: `Asked to switch to ${str(ctx.input.target_mode_id)} mode${ctx.input.explanation ? `: ${firstLine(str(ctx.input.explanation), 100)}` : ''}.`,
  whatHappened: 'Plan mode is read-only research; agent mode can make changes.',
  vocabulary: ['plan-mode'],
}));

const connectScm = tool('ConnectScm', 'scm', () => ({ title: 'Requesting GitHub access', summary: 'Offered to connect your GitHub account so it can work with pull requests.', vocabulary: ['github'] }));

const unknown: Template = {
  id: 'tool.unknown',
  match: () => 0.05,
  explain: (ctx) =>
    makeExplanation({
      templateId: 'tool.unknown',
      title: `Using the ${ctx.toolName} tool`,
      summary: `Used a tool called "${ctx.toolName}".`,
      whatHappened: 'Decipher does not have a description for this tool yet; the raw input is shown below.',
      technical: JSON.stringify(ctx.input).slice(0, 300),
      vocabulary: ['tool-call'],
      confidence: 0.15,
    }),
};

export const TOOL_TEMPLATES: Template[] = [read, glob, grep, write, strReplace, del, notebook, task, ask, todo, plan, step, shellWait, lints, webSearch, webFetch, dynamicTool, sendToUser, switchMode, connectScm, unknown];
