import type { Explanation } from '../../../../shared/activity-schema';
import { describeFilters, hasFileRedirect, redactCommand } from '../../parser/shellParser';
import { friendlyFile, pluralize, shortPath } from '../friendlyNames';
import { countLines, countSearchMatches, firstLine, parseCommitOutput, parseDiffStat, parseGitLog, parseGitStatus } from '../outputParsers';
import { makeExplanation, type ShellContext, type Template } from '../types';

type ShellTemplate = Template<ShellContext>;

const sub = (ctx: ShellContext) => ctx.positional[0] ?? '';
const stdout = (ctx: ShellContext) => ctx.shellResult?.stdout;
const withFilters = (ctx: ShellContext, text: string) => {
  const f = describeFilters(ctx.filters);
  return f ? `${text}, then ${f}.` : `${text}.`;
};
const tech = (ctx: ShellContext) => redactCommand(ctx.segment);

function git(subcommand: string | string[], build: (ctx: ShellContext) => Partial<Explanation> & Pick<Explanation, 'title' | 'summary'>): ShellTemplate {
  const subs = Array.isArray(subcommand) ? subcommand : [subcommand];
  return {
    id: `shell.git.${subs[0]}`,
    match: (ctx) => (ctx.program === 'git' && subs.includes(sub(ctx)) ? 1 : 0),
    explain: (ctx) => {
      const e = build(ctx);
      return makeExplanation({ ...e, templateId: `shell.git.${subs[0]}`, technical: tech(ctx), vocabulary: ['git', ...(e.vocabulary ?? [])] });
    },
  };
}

function prog(programs: string | string[], id: string, build: (ctx: ShellContext) => Partial<Explanation> & Pick<Explanation, 'title' | 'summary'>, score = 1): ShellTemplate {
  const list = Array.isArray(programs) ? programs : [programs];
  return {
    id: `shell.${id}`,
    match: (ctx) => (list.includes(ctx.program) ? score : 0),
    explain: (ctx) => {
      const e = build(ctx);
      return makeExplanation({ ...e, templateId: `shell.${id}`, technical: tech(ctx), vocabulary: ['terminal', ...(e.vocabulary ?? [])] });
    },
  };
}

/** `$(cat <<'EOF'\nSubject\n\nBody\nEOF\n)` → `Subject\n\nBody` */
function unwrapHeredoc(text: string): string {
  const m = text.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n\2\s*(\n|\)|$)/);
  return m ? m[3] : text;
}

function quoteList(files: string[], max = 3): string {
  const names = files.slice(0, max).map((f) => friendlyFile(f).basename);
  const rest = files.length - names.length;
  return names.join(', ') + (rest > 0 ? ` and ${rest} more` : '');
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

const gitStatus = git('status', (ctx) => {
  const out = stdout(ctx);
  const base = { title: 'Checking which files changed', vocabulary: ['status', 'modified', 'untracked'] };
  if (!out) {
    return {
      ...base,
      summary: 'Checked which files have changed since the last save point.',
      whatHappened: 'The agent asked git to list every file that is modified, new, or deleted compared with the last checkpoint.',
      whyItMatters: 'Before saving or editing, the agent confirms what state the project is in so nothing unexpected gets included.',
    };
  }
  const s = parseGitStatus(out);
  if (s.clean) {
    return { ...base, summary: 'Checked for changes — everything is already saved.', whatHappened: 'Git reported a clean working tree: no files differ from the last checkpoint.' };
  }
  const parts: string[] = [];
  if (s.modified.length) parts.push(`${pluralize(s.modified.length, 'file was', 'files were')} edited (${quoteList(s.modified)})`);
  if (s.added.length) parts.push(`${pluralize(s.added.length, 'file was', 'files were')} added and staged (${quoteList(s.added)})`);
  if (s.deleted.length) parts.push(`${pluralize(s.deleted.length, 'file was', 'files were')} deleted (${quoteList(s.deleted)})`);
  if (s.renamed.length) parts.push(`${pluralize(s.renamed.length, 'file was', 'files were')} renamed`);
  if (s.untracked.length) parts.push(`${pluralize(s.untracked.length, 'new file is', 'new files are')} not yet tracked by git (${quoteList(s.untracked)})`);
  const branch = s.branch ? ` on the "${s.branch}" branch` : '';
  const sync = s.ahead ? ` ${pluralize(s.ahead, 'checkpoint has', 'checkpoints have')} not been uploaded yet.` : '';
  return {
    ...base,
    summary: `Checked which files changed: ${parts.join('; ')}.`,
    whatHappened: `Git listed the differences${branch}. ${parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('. ')}.${sync}`,
    whyItMatters: 'This is the agent double-checking exactly what will be included before it saves a checkpoint.',
  };
});

const gitDiff = git('diff', (ctx) => {
  const out = stdout(ctx);
  const isStat = ctx.has('--stat') || ctx.has('--shortstat') || ctx.has('--numstat');
  const cached = ctx.has('--cached') || ctx.has('--staged');
  const what = cached ? 'the changes selected for the next checkpoint' : 'the unsaved changes';
  if (isStat) {
    const st = out ? parseDiffStat(out) : undefined;
    return {
      title: 'Reviewing a summary of changes',
      summary: st
        ? `Summarized ${what}: ${pluralize(st.files, 'file')} changed, ${st.insertions} lines added, ${st.deletions} removed.`
        : `Summarized how many lines changed in each file.`,
      whatHappened: `Instead of showing every changed line, git printed a compact per-file tally of ${what}.`,
      whyItMatters: 'A quick way to sanity-check the size and spread of a change before saving it.',
      vocabulary: ['diff', 'diff-stat'],
    };
  }
  return {
    title: 'Reviewing exact changes',
    summary: `Looked at the exact lines that changed in ${what}.`,
    whatHappened: `Git showed a line-by-line comparison (a diff) — lines starting with "+" were added, "-" were removed.`,
    whyItMatters: 'The agent reads the diff to confirm its edits did what it intended and nothing else.',
    vocabulary: ['diff'],
  };
});

const gitLog = git('log', (ctx) => {
  const n = ctx.args.find((a) => /^-\d+$/.test(a))?.slice(1) ?? ctx.args[ctx.args.indexOf('-n') + 1];
  const out = stdout(ctx);
  const entries = out ? parseGitLog(out) : [];
  const recent = entries.length ? ` The most recent is "${entries[0].message}".` : '';
  return {
    title: 'Reading recent save history',
    summary: `Listed the last ${n && /^\d+$/.test(n) ? n : 'few'} checkpoints to see what was done recently.${recent}`,
    whatHappened: `Git printed the history of saved checkpoints, newest first — each with a short ID and the message written when it was saved.${recent}`,
    whyItMatters: 'Understanding recent history helps the agent write a consistent commit message and avoid redoing work.',
    vocabulary: ['log', 'commit-hash', 'commit'],
  };
});

const gitAdd = git('add', (ctx) => {
  const targets = ctx.positional.slice(1);
  const all = ctx.has('-A') || ctx.has('--all') || targets.includes('.') || targets.length === 0;
  const files = targets.filter((p) => p !== '.');
  return {
    title: 'Selecting changes to save',
    summary: all ? 'Selected all changed files to include in the next checkpoint.' : `Selected ${quoteList(files)} to include in the next checkpoint.`,
    whatHappened: 'Git has a two-step save: first you choose which changes to include ("staging"), then you save them as a checkpoint ("commit"). This was step one.',
    whyItMatters: 'Staging lets you save related changes together and leave unrelated ones out.',
    vocabulary: ['staged', 'commit'],
  };
});

const gitCommit = git('commit', (ctx) => {
  const mIdx = ctx.args.findIndex((a) => a === '-m' || a === '--message');
  const msgArg = mIdx >= 0 ? ctx.args[mIdx + 1] : ctx.args.find((a) => /^-m./.test(a))?.slice(2);
  const message = msgArg ? firstLine(unwrapHeredoc(msgArg), 140) : undefined;
  const amend = ctx.has('--amend');
  const out = stdout(ctx);
  const parsed = out ? parseCommitOutput(out) : undefined;
  const statText = parsed?.stat ? ` It covered ${pluralize(parsed.stat.files, 'file')} (${parsed.stat.insertions} lines added, ${parsed.stat.deletions} removed).` : '';
  return {
    title: amend ? 'Updating the last save point' : 'Saving a checkpoint',
    summary: amend
      ? 'Rewrote the most recent checkpoint instead of creating a new one.'
      : message
        ? `Saved a checkpoint with the message: "${message}".`
        : 'Saved a checkpoint of the current changes.',
    whatHappened: `A commit is a named snapshot of the project you can always return to.${message ? ` The message "${message}" describes what changed.` : ''}${statText}${parsed?.hash ? ` Its short ID is ${parsed.hash}.` : ''}`,
    whyItMatters: 'Frequent checkpoints make it safe to experiment — anything can be undone by going back to a previous one.',
    vocabulary: ['commit', 'commit-hash', ...(ctx.has('-a') || ctx.has('-am') ? ['staged'] : [])],
  };
});

const gitPush = git('push', (ctx) => {
  const setUpstream = ctx.has('-u') || ctx.has('--set-upstream');
  const force = ctx.has('--force') || ctx.has('-f') || ctx.has('--force-with-lease');
  return {
    title: 'Uploading to GitHub',
    summary: force ? 'Force-uploaded local checkpoints, overwriting the online history.' : 'Uploaded the saved checkpoints to the online copy of the project (GitHub).',
    whatHappened: `Your local checkpoints were sent to the remote repository so they are backed up and visible to collaborators.${setUpstream ? ' This also linked the local branch to its online counterpart for future pushes.' : ''}`,
    whyItMatters: force
      ? 'Force pushes rewrite shared history — safe on a personal branch, risky on a shared one.'
      : 'Until you push, checkpoints exist only on this computer.',
    vocabulary: ['push', 'remote', 'github'],
  };
});

const gitPull = git(['pull', 'fetch'], (ctx) => {
  const isFetch = sub(ctx) === 'fetch';
  return {
    title: isFetch ? 'Checking for updates online' : 'Downloading updates',
    summary: isFetch ? 'Checked the online copy for new changes without applying them.' : 'Downloaded and applied the latest changes from the online copy.',
    whatHappened: isFetch
      ? 'Git contacted the remote and learned what is new there, but left your files untouched.'
      : 'Git downloaded any checkpoints made elsewhere and merged them into your local copy.',
    vocabulary: [isFetch ? 'fetch' : 'pull', 'remote'],
  };
});

const gitBranch = git(['branch', 'checkout', 'switch'], (ctx) => {
  const s = sub(ctx);
  const target = ctx.positional[1];
  if (s === 'branch') {
    if (ctx.has('--show-current')) return { title: 'Checking the current branch', summary: 'Asked git which branch is currently active.', vocabulary: ['branch'] };
    if (ctx.has('-d') || ctx.has('-D')) return { title: 'Deleting a branch', summary: `Deleted the "${target}" branch.`, vocabulary: ['branch'] };
    if (target) return { title: 'Creating a branch', summary: `Created a new branch called "${target}".`, whatHappened: 'A branch is a separate line of work so experiments do not disturb the main version.', vocabulary: ['branch'] };
    return { title: 'Listing branches', summary: 'Listed the branches in this project.', vocabulary: ['branch'] };
  }
  const creating = ctx.has('-b') || ctx.has('-c');
  return {
    title: creating ? 'Creating and switching branch' : 'Switching branch',
    summary: creating ? `Created a new branch "${target}" and switched to it.` : target ? `Switched the working files to "${target}".` : 'Switched branches.',
    whatHappened: 'Switching branches swaps the files in your folder to that branch\'s version.',
    vocabulary: ['checkout', 'branch'],
  };
});

const gitMisc = git(['init', 'clone', 'stash', 'merge', 'rebase', 'remote', 'rev-parse', 'show', 'rm', 'mv', 'restore', 'reset', 'tag', 'blame'], (ctx) => {
  const s = sub(ctx);
  const map: Record<string, Partial<Explanation> & Pick<Explanation, 'title' | 'summary'>> = {
    init: { title: 'Starting version control', summary: 'Turned this folder into a git project so changes can be tracked.', vocabulary: ['git'] },
    clone: { title: 'Downloading a project', summary: `Downloaded a complete copy of ${ctx.positional[1] ?? 'a project'} including its history.`, vocabulary: ['clone', 'remote'] },
    stash: { title: 'Setting changes aside', summary: ctx.positional[1] === 'pop' ? 'Restored changes that were set aside earlier.' : 'Temporarily set aside unsaved changes to get a clean slate.', vocabulary: ['stash'] },
    merge: { title: 'Combining branches', summary: `Merged the "${ctx.positional[1] ?? 'other'}" branch into the current one.`, vocabulary: ['merge', 'branch'] },
    rebase: { title: 'Replaying changes on top of the latest', summary: 'Rebased the current branch to sit on top of newer work.', vocabulary: ['rebase', 'branch'] },
    remote: { title: 'Checking the online copy', summary: 'Looked up where the online copy of this project lives.', vocabulary: ['remote'] },
    'rev-parse': { title: 'Looking up a git detail', summary: ctx.has('--show-toplevel') ? 'Found the root folder of this project.' : 'Looked up an internal git identifier.', vocabulary: ['commit-hash'] },
    show: { title: 'Inspecting a checkpoint', summary: `Displayed the details of ${ctx.positional[1] ? `checkpoint ${ctx.positional[1]}` : 'the latest checkpoint'}.`, vocabulary: ['commit', 'diff'] },
    rm: { title: 'Removing a file from git', summary: `Deleted ${quoteList(ctx.positional.slice(1))} and told git to stop tracking it.`, vocabulary: ['staged'] },
    mv: { title: 'Renaming a tracked file', summary: `Renamed ${ctx.positional[1] ?? 'a file'} to ${ctx.positional[2] ?? 'a new name'} in a way git understands.`, vocabulary: ['git'] },
    restore: { title: 'Undoing unsaved edits', summary: `Reverted ${quoteList(ctx.positional.slice(1)) || 'files'} back to the last checkpoint.`, whyItMatters: 'This discards work that was not committed — the agent uses it to back out of a change.', vocabulary: ['checkout'] },
    reset: { title: 'Rewinding the save state', summary: ctx.has('--hard') ? 'Discarded all uncommitted changes and rewound to a checkpoint.' : 'Un-staged changes or moved the branch pointer to an earlier checkpoint.', vocabulary: ['staged', 'commit'] },
    tag: { title: 'Labelling a checkpoint', summary: `Tagged a checkpoint${ctx.positional[1] ? ` as "${ctx.positional[1]}"` : ''} — usually a release version.`, vocabulary: ['commit'] },
    blame: { title: 'Finding who changed each line', summary: `Looked up which checkpoint last changed each line of ${ctx.positional[1] ?? 'a file'}.`, vocabulary: ['log'] },
  };
  return map[s] ?? { title: 'Running a git command', summary: `Ran git ${s}.`, vocabulary: ['git'] };
});

const gitFallback: ShellTemplate = {
  id: 'shell.git.other',
  match: (ctx) => (ctx.program === 'git' ? 0.5 : 0),
  explain: (ctx) => makeExplanation({ templateId: 'shell.git.other', title: 'Running a git command', summary: `Ran a git command (${sub(ctx)}).`, technical: tech(ctx), vocabulary: ['git'], confidence: 0.4 }),
};

// ---------------------------------------------------------------------------
// search & read
// ---------------------------------------------------------------------------

const ripgrep = prog(['rg', 'grep', 'ag', 'ack'], 'search', (ctx) => {
  const flags = ctx.args.filter((a) => a.startsWith('-'));
  const eIdx = ctx.args.findIndex((a) => a === '-e' || a === '--regexp');
  const pattern = eIdx >= 0 ? ctx.args[eIdx + 1] : ctx.positional[0];
  const where = ctx.positional.slice(eIdx >= 0 ? 0 : 1);
  const scope = where.length && !(where.length === 1 && where[0] === '.') ? `in ${where.map((w) => shortPath(w, ctx.workspaceRoot)).join(', ')}` : 'across the whole project';
  const out = stdout(ctx);
  const alternatives = pattern?.includes('|') ? pattern.split('|').map((p) => `"${p.replace(/\\/g, '')}"`).join(' or ') : undefined;
  let result = '';
  if (out !== undefined) {
    const c = countSearchMatches(out);
    result = c.matches === 0 ? ' It found nothing.' : ` It found ${pluralize(c.matches, 'match', 'matches')} in ${pluralize(c.files, 'file')}.`;
    if (ctx.filters.some((f) => /wc -l/.test(f))) result = ` The result was a count: ${firstLine(out)}.`;
  }
  const vocab = ['rg'];
  if (pattern && /[|.*+?()\[\]\\]/.test(pattern)) vocab.push('regex');
  if (flags.includes('--hidden')) vocab.push('hidden-files');
  if (flags.some((f) => f === '-g' || f === '--glob')) vocab.push('glob');
  if (ctx.args.some((a) => /node_modules/.test(a))) vocab.push('node-modules');
  return {
    title: 'Searching the project',
    summary: withFilters(ctx, `Searched ${scope} for ${alternatives ?? `"${pattern ?? ''}"`}`) + result,
    whatHappened: `The agent ran a fast text search ${scope}${flags.includes('--hidden') ? ', including hidden files' : ''}${ctx.args.some((a) => /!node_modules|!\.git/.test(a)) ? ' while skipping system folders like node_modules and .git' : ''}.${result}`,
    whyItMatters: 'Searching first tells the agent where something lives (or confirms it is gone) before it edits anything.',
    vocabulary: vocab,
  };
});

const findCmd = prog(['find', 'fd', 'locate'], 'find', (ctx) => ({
  title: 'Looking for files by name',
  summary: withFilters(ctx, `Looked for files ${ctx.args.includes('-name') ? `named like ${ctx.args[ctx.args.indexOf('-name') + 1]}` : 'matching a pattern'}`),
  whatHappened: 'Unlike a text search, this looks at file names and locations rather than their contents.',
  vocabulary: ['glob', 'path'],
}));

const ls = prog(['ls', 'tree', 'exa', 'eza'], 'ls', (ctx) => {
  const target = ctx.positional[0];
  const out = stdout(ctx);
  const count = out ? countLines(out) : undefined;
  return {
    title: 'Listing folder contents',
    summary: withFilters(ctx, `Listed what is inside ${target ? shortPath(target, ctx.workspaceRoot) : 'the current folder'}`) + (count !== undefined ? ` (${pluralize(count, 'item')})` : ''),
    whatHappened: 'The agent looked at the files and sub-folders present to orient itself.',
    vocabulary: ['ls', 'cwd'],
  };
});

const catCmd = prog(['cat', 'head', 'tail', 'less', 'more', 'bat'], 'cat', (ctx) => {
  const files = ctx.positional;
  const n = ctx.args.find((a) => /^-\d+$/.test(a))?.slice(1) ?? (ctx.args.includes('-n') ? ctx.args[ctx.args.indexOf('-n') + 1] : undefined);
  const part = ctx.program === 'head' ? `the first ${n ?? '10'} lines of` : ctx.program === 'tail' ? `the last ${n ?? '10'} lines of` : '';
  const sensitive = files.some((f) => friendlyFile(f).sensitive);
  return {
    title: 'Reading a file in the terminal',
    summary: withFilters(ctx, `Displayed ${part} ${files.length ? files.map((f) => friendlyFile(f).phrase).join(' and ') : 'some text'}`.replace(/\s+/g, ' ')),
    whatHappened: sensitive ? 'This file may contain secrets, so Decipher does not show its contents.' : 'The agent printed the file to read it.',
    vocabulary: ['cat', 'path'],
  };
});

const wc = prog('wc', 'wc', (ctx) => ({
  title: 'Counting',
  summary: `Counted ${ctx.has('-l') ? 'lines' : ctx.has('-w') ? 'words' : 'size'} in ${ctx.positional.map((p) => friendlyFile(p).basename).join(', ') || 'the input'}.`,
  vocabulary: ['terminal'],
}));

const pwdWhich = prog(['pwd', 'which', 'whoami', 'hostname', 'uname', 'date', 'echo', 'printf', 'true', 'sleep', 'type', 'command'], 'trivial', (ctx) => {
  const map: Record<string, string> = {
    pwd: 'Checked which folder the terminal is in.',
    which: `Checked whether "${ctx.positional[0] ?? 'a program'}" is installed and where.`,
    whoami: 'Checked which user account is running.',
    hostname: 'Checked the computer name.',
    uname: 'Checked the operating system details.',
    date: 'Checked the current date and time.',
    echo: hasFileRedirect(ctx.segment) ? `Wrote text into a file.` : `Printed a message: "${firstLine(ctx.args.filter((a) => !/^-[neE]+$/.test(a)).join(' '), 60)}".`,
    printf: 'Printed formatted text.',
    true: 'Ran a no-op placeholder.',
    sleep: `Waited ${ctx.positional[0] ?? 'a moment'} seconds.`,
    type: `Checked what kind of command "${ctx.positional[0] ?? ''}" is.`,
    command: `Checked whether "${ctx.positional.filter((p) => p !== '-v')[0] ?? 'a program'}" is available.`,
  };
  return { title: 'Quick check', summary: map[ctx.program] ?? `Ran ${ctx.program}.`, vocabulary: ['cwd'] };
});

const versionCheck: ShellTemplate = {
  id: 'shell.version',
  match: (ctx) => (ctx.args.length === 1 && ['--version', '-v', '-V', 'version'].includes(ctx.args[0]) ? 1.2 : 0),
  explain: (ctx) => makeExplanation({ templateId: 'shell.version', title: 'Checking a tool version', summary: `Checked which version of ${ctx.program} is installed${ctx.shellResult ? ` (${firstLine(ctx.shellResult.stdout, 40)})` : ''}.`, whatHappened: 'Knowing the version avoids using features the installed tool does not support.', technical: tech(ctx), vocabulary: ['terminal'] }),
};

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

const fileOps = prog(['rm', 'mv', 'cp', 'mkdir', 'touch', 'rmdir', 'ln'], 'fileops', (ctx) => {
  const p = ctx.positional;
  const f = (x?: string) => (x ? friendlyFile(x).phrase : 'a file');
  switch (ctx.program) {
    case 'rm':
      return { title: 'Deleting', summary: `Deleted ${ctx.has('-r') || ctx.has('-rf') || ctx.has('-R') ? `the folder ${p.map((x) => shortPath(x, ctx.workspaceRoot)).join(', ')} and everything in it` : p.map(f).join(' and ')}.`, whyItMatters: 'Deletions outside git are permanent — the agent usually only removes temporary or generated files this way.', vocabulary: ['path'] };
    case 'mv':
      return { title: 'Moving / renaming', summary: `Moved ${f(p[0])} to ${shortPath(p[1], ctx.workspaceRoot)}.`, vocabulary: ['path'] };
    case 'cp':
      return { title: 'Copying', summary: `Copied ${f(p[0])} to ${shortPath(p[p.length - 1], ctx.workspaceRoot)}.`, vocabulary: ['path'] };
    case 'mkdir':
      return { title: 'Creating a folder', summary: `Created the folder ${p.filter((x) => x !== '-p').map((x) => shortPath(x, ctx.workspaceRoot)).join(', ')}.`, vocabulary: ['path'] };
    case 'touch':
      return { title: 'Creating an empty file', summary: `Created ${f(p[0])} (empty) or refreshed its timestamp.`, vocabulary: ['path'] };
    case 'ln':
      return { title: 'Creating a shortcut', summary: `Created a link so ${p[1] ?? 'one path'} points at ${p[0] ?? 'another'}.`, vocabulary: ['path'] };
    default:
      return { title: 'File operation', summary: `Ran ${ctx.program}.`, vocabulary: ['path'] };
  }
});

const chmod = prog(['chmod', 'chown'], 'chmod', (ctx) => ({
  title: 'Changing file permissions',
  summary: ctx.program === 'chmod' && /\+x/.test(ctx.args.join(' ')) ? `Made ${ctx.positional.slice(1).map((p) => friendlyFile(p).basename).join(', ')} runnable as a program.` : 'Changed who can read, edit, or run a file.',
  whatHappened: 'Scripts need an "executable" permission before the system will run them directly.',
  vocabulary: ['chmod'],
}));

const sedAwk = prog(['sed', 'awk', 'cut', 'tr', 'sort', 'uniq', 'jq', 'xargs', 'tee', 'od', 'xxd', 'diff', 'cmp'], 'textproc', (ctx) => {
  const map: Record<string, [string, string]> = {
    sed: ['Editing text with a pattern', ctx.has('-i') ? 'Rewrote parts of a file in place using a find-and-replace pattern.' : 'Transformed text using a find-and-replace pattern.'],
    awk: ['Extracting columns of text', 'Pulled specific columns or fields out of text output.'],
    cut: ['Extracting columns of text', 'Cut specific columns out of each line.'],
    tr: ['Swapping characters', 'Replaced or deleted characters in text.'],
    sort: ['Sorting', 'Sorted lines of text.'],
    uniq: ['Removing duplicates', 'Collapsed repeated lines.'],
    jq: ['Reading JSON', 'Pulled specific fields out of JSON data.'],
    xargs: ['Running a command per result', 'Ran a follow-up command on each item from the previous step.'],
    tee: ['Saving a copy of output', 'Wrote the output to a file while also showing it.'],
    od: ['Inspecting raw bytes', 'Looked at the exact bytes of some text to spot invisible characters.'],
    xxd: ['Inspecting raw bytes', 'Looked at the exact bytes of some text.'],
    diff: ['Comparing two files', `Compared ${ctx.positional.map((p) => friendlyFile(p).basename).join(' with ')} line by line.`],
    cmp: ['Comparing two files', 'Checked whether two files are identical.'],
  };
  const [title, summary] = map[ctx.program] ?? ['Processing text', `Ran ${ctx.program}.`];
  return { title, summary, vocabulary: ['pipe', 'stdout'] };
});

// ---------------------------------------------------------------------------
// packages, builds, servers
// ---------------------------------------------------------------------------

const PKG_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx'];

const pkg = prog(PKG_MANAGERS, 'pkg', (ctx) => {
  const pm = ctx.program;
  const isRunner = ['npx', 'pnpx', 'bunx'].includes(pm) || (pm === 'bun' && sub(ctx) === 'x');
  const s = sub(ctx);
  const rest = ctx.positional.slice(1);
  if (isRunner) {
    const tool = pm === 'bun' ? rest[0] : s;
    const toolArgs = pm === 'bun' ? rest.slice(1) : rest;
    return describeToolRun(tool, toolArgs, ctx);
  }
  if (['install', 'i', 'add', 'ci'].includes(s)) {
    const names = rest.filter((r) => !r.startsWith('-'));
    const dev = ctx.has('-D') || ctx.has('--save-dev');
    return {
      title: 'Installing packages',
      summary: names.length ? `Downloaded and added ${names.join(', ')} to the project${dev ? ' (for development only)' : ''}.` : 'Downloaded all the packages the project depends on.',
      whatHappened: names.length
        ? `A package is reusable code written by someone else. ${pm} fetched ${names.join(', ')} into node_modules and recorded it in package.json.`
        : `${pm} read package.json and downloaded every listed dependency into node_modules.`,
      whyItMatters: 'Installing is how new capabilities (an animation library, a UI kit) enter the project.',
      vocabulary: ['npm', 'package', 'package-json', 'node-modules'],
    };
  }
  if (['uninstall', 'remove', 'rm', 'un'].includes(s)) {
    return { title: 'Removing packages', summary: `Removed ${rest.join(', ')} from the project.`, vocabulary: ['npm', 'package'] };
  }
  if (s === 'run' || s === 'run-script' || (pm === 'yarn' && !['add', 'install', 'remove'].includes(s))) {
    const script = s === 'run' || s === 'run-script' ? rest[0] : s;
    return describeScript(script, ctx);
  }
  if (['test', 'start', 'build', 'dev', 'lint', 'format', 'typecheck'].includes(s)) return describeScript(s, ctx);
  if (['init', 'create'].includes(s)) return { title: 'Creating a new project', summary: `Set up a new project${rest[0] ? ` using the "${rest[0]}" starter` : ''}.`, vocabulary: ['npm', 'package-json'] };
  if (['ls', 'list', 'outdated', 'audit', 'view', 'info', 'why'].includes(s)) return { title: 'Inspecting packages', summary: `Checked information about installed packages (${s}).`, vocabulary: ['npm', 'package'] };
  if (['publish', 'version', 'login', 'whoami'].includes(s)) return { title: 'Package registry action', summary: `Ran ${pm} ${s}.`, vocabulary: ['npm'] };
  if (['cache', 'config', 'set', 'get', 'prune', 'dedupe', 'link', 'exec', 'workspaces', 'pkg'].includes(s)) return { title: 'Package manager housekeeping', summary: `Ran ${pm} ${s} ${rest.join(' ')}.`.trim(), vocabulary: ['npm'] };
  return { title: 'Package manager command', summary: `Ran ${pm} ${s}.`, vocabulary: ['npm'] };
});

function describeScript(script: string | undefined, ctx: ShellContext): Partial<Explanation> & Pick<Explanation, 'title' | 'summary'> {
  const out = ctx.shellResult;
  const failed = out?.exitCode !== undefined && out.exitCode !== 0;
  const suffix = failed ? ' It reported errors.' : out ? ' It finished.' : '';
  switch (script) {
    case 'dev':
    case 'start':
    case 'serve':
    case 'preview':
      return { title: 'Starting a local preview', summary: `Started the ${script === 'preview' ? 'production preview' : 'development'} server so the site can be viewed at a localhost address.`, whatHappened: 'A dev server runs the site on your own computer and refreshes as files change. Nothing is published.', vocabulary: ['dev-server', 'localhost', 'npm-script'] };
    case 'build':
      return { title: 'Building the project', summary: `Compiled the source files into the optimized version a browser loads.${suffix}`, whatHappened: 'Building catches errors and produces the final files that would be deployed.', vocabulary: ['build', 'npm-script'] };
    case 'test':
    case 'test:unit':
    case 'test:e2e':
      return { title: 'Running tests', summary: `Ran the automated tests to make sure nothing broke.${suffix}`, vocabulary: ['test', 'npm-script'] };
    case 'lint':
    case 'lint:fix':
      return { title: 'Checking code style', summary: `Ran the linter, an automatic proofreader for code.${suffix}`, vocabulary: ['lint', 'npm-script'] };
    case 'format':
    case 'prettier':
      return { title: 'Formatting code', summary: 'Auto-formatted files for consistent spacing and style.', vocabulary: ['npm-script'] };
    case 'typecheck':
    case 'check':
    case 'tsc':
      return { title: 'Type-checking', summary: `Verified the code pieces fit together correctly.${suffix}`, vocabulary: ['typecheck', 'typescript'] };
    default:
      return { title: 'Running a project shortcut', summary: `Ran the "${script ?? ''}" shortcut defined in package.json.${suffix}`, whatHappened: 'Scripts in package.json are named shortcuts for longer commands.', vocabulary: ['npm-script', 'package-json'] };
  }
}

function describeToolRun(tool: string | undefined, args: string[], ctx: ShellContext): Partial<Explanation> & Pick<Explanation, 'title' | 'summary'> {
  const t = (tool ?? '').replace(/@.*$/, '');
  if (['astro', 'vite', 'next', 'nuxt', 'remix', 'gatsby', 'svelte-kit', 'webpack', 'parcel'].includes(t)) {
    const cmd = args[0];
    if (cmd === 'dev' && args.includes('--background')) return { title: 'Starting a local preview in the background', summary: `Started the ${t} dev server in the background so work can continue while it runs.`, vocabulary: ['dev-server', 'localhost', 'background-process'] };
    if (cmd === 'dev' && args.includes('logs')) return { title: 'Reading dev server logs', summary: 'Checked the dev server output for errors.', vocabulary: ['dev-server', 'stdout'] };
    if (cmd === 'dev' && args.includes('status')) return { title: 'Checking the dev server', summary: 'Checked whether the dev server is running.', vocabulary: ['dev-server'] };
    if (cmd === 'dev' || cmd === 'start') return describeScript('dev', ctx);
    if (cmd === 'build') return describeScript('build', ctx);
    if (cmd === 'check') return describeScript('typecheck', ctx);
    return { title: `Running ${t}`, summary: `Ran ${t} ${args.join(' ')}.`.trim(), vocabulary: ['framework', 'npx'] };
  }
  if (t === 'tsc') return describeScript('tsc', ctx);
  if (['vitest', 'jest', 'mocha', 'playwright', 'cypress'].includes(t)) return describeScript('test', ctx);
  if (['eslint', 'biome', 'stylelint'].includes(t)) return describeScript('lint', ctx);
  if (['prettier'].includes(t)) return describeScript('format', ctx);
  if (['vsce', 'ovsx'].includes(t)) return { title: 'Packaging the extension', summary: 'Bundled the editor extension into an installable file.', vocabulary: ['extension', 'build'] };
  if (['create-next-app', 'create-vite', 'create-astro', 'degit'].includes(t) || t.startsWith('create-')) return { title: 'Scaffolding a new project', summary: `Generated a starter project with ${t}.`, vocabulary: ['framework', 'npx'] };
  return { title: 'Running a package tool', summary: `Ran the "${t}" tool without installing it permanently.`, vocabulary: ['npx', 'package'] };
}

const node = prog(['node', 'tsx', 'ts-node', 'deno', 'python', 'python3', 'ruby', 'go', 'cargo', 'java', 'php', 'perl'], 'runtime', (ctx) => {
  const file = ctx.positional.find((p) => /\.[a-z]+$/i.test(p));
  const inline = ctx.has('-e') || ctx.has('--eval') || ctx.has('-c') || ctx.has('-p');
  return {
    title: 'Running a script',
    summary: inline ? `Ran a small one-off ${ctx.program} snippet.` : file ? `Ran ${friendlyFile(file).phrase} with ${ctx.program}.` : `Ran ${ctx.program} ${ctx.positional.slice(0, 2).join(' ')}.`.trim(),
    whatHappened: inline ? 'Instead of creating a file, the agent passed a tiny program directly on the command line — usually to check or transform something quickly.' : 'The agent executed a program and read its output.',
    vocabulary: ['javascript', 'terminal'],
  };
});

const curl = prog(['curl', 'wget', 'http', 'httpie'], 'curl', (ctx) => {
  const url = ctx.positional.find((p) => /^https?:\/\//.test(p)) ?? ctx.positional[0];
  const local = /localhost|127\.0\.0\.1/.test(url ?? '');
  const statusOnly = ctx.args.some((a) => /%\{http_code\}/.test(a)) || ctx.has('-I');
  const out = ctx.shellResult?.stdout;
  const code = out?.match(/\b([1-5]\d\d)\b\s*$/)?.[1];
  return {
    title: local ? 'Checking the local preview' : 'Fetching a web address',
    summary: local
      ? `Requested ${url} from the local dev server${statusOnly ? ' to confirm it responds' : ' and inspected the page it returned'}${code ? ` — it answered ${code}${code === '200' ? ' (OK)' : ''}` : ''}.`
      : `Downloaded ${url ?? 'a web page'}${statusOnly ? ' headers only' : ''}.`,
    whatHappened: local
      ? 'Instead of opening a browser, the agent asked the running site for a page directly and checked the response.'
      : 'The agent fetched content from the internet to read or save it.',
    vocabulary: ['curl', ...(local ? ['localhost', 'dev-server'] : ['api'])],
  };
});

const lsof = prog(['lsof', 'kill', 'pkill', 'killall', 'ps', 'top', 'open', 'osascript', 'pbcopy', 'pbpaste', 'say', 'defaults', 'brew', 'apt', 'apt-get', 'pip', 'pip3', 'gem', 'docker', 'docker-compose', 'kubectl', 'gh', 'vercel', 'netlify', 'wrangler', 'code', 'cursor', 'source', 'export', 'unset', 'alias', 'set', 'cd', 'exit', 'clear'], 'system', (ctx) => {
  const p = ctx.program;
  const map: Record<string, [string, string, string[]]> = {
    lsof: ['Checking what is using a port', `Checked which program is using ${ctx.args.find((a) => /^-i/.test(a)) ?? 'a network port'}.`, ['localhost']],
    kill: ['Stopping a program', 'Stopped a running background program.', ['background-process']],
    pkill: ['Stopping a program', `Stopped any running "${ctx.positional[0] ?? ''}" processes.`, ['background-process']],
    killall: ['Stopping a program', `Stopped all "${ctx.positional[0] ?? ''}" processes.`, ['background-process']],
    ps: ['Listing running programs', 'Listed the programs currently running.', ['background-process']],
    top: ['Watching system load', 'Looked at what is using the CPU and memory.', []],
    open: ['Opening something', `Opened ${ctx.positional[0] ?? 'a file or URL'} with the default app.`, []],
    osascript: ['Automating macOS', 'Ran a small macOS automation script.', []],
    pbcopy: ['Copying to clipboard', 'Copied text to the clipboard.', []],
    pbpaste: ['Reading the clipboard', 'Read the clipboard contents.', []],
    say: ['Speaking', 'Made the computer speak.', []],
    defaults: ['Reading macOS settings', 'Read or changed a macOS preference.', []],
    brew: ['Installing system software', `Ran Homebrew to ${sub(ctx)} ${ctx.positional.slice(1).join(' ')}.`.trim(), ['package']],
    apt: ['Installing system software', `Ran the system package manager (${sub(ctx)}).`, ['package']],
    'apt-get': ['Installing system software', `Ran the system package manager (${sub(ctx)}).`, ['package']],
    pip: ['Installing Python packages', `Ran pip ${sub(ctx)} ${ctx.positional.slice(1).join(' ')}.`.trim(), ['package']],
    pip3: ['Installing Python packages', `Ran pip ${sub(ctx)} ${ctx.positional.slice(1).join(' ')}.`.trim(), ['package']],
    gem: ['Installing Ruby packages', `Ran gem ${sub(ctx)}.`, ['package']],
    docker: ['Working with containers', `Ran docker ${sub(ctx)} — containers are self-contained mini-computers for running software consistently.`, []],
    'docker-compose': ['Working with containers', 'Managed a group of containers.', []],
    kubectl: ['Working with a cluster', `Ran kubectl ${sub(ctx)}.`, []],
    gh: ['Working with GitHub', describeGh(ctx), ['github', 'pull-request']],
    vercel: ['Deploying', 'Ran the Vercel deployment tool.', ['build']],
    netlify: ['Deploying', 'Ran the Netlify deployment tool.', ['build']],
    wrangler: ['Deploying', 'Ran the Cloudflare deployment tool.', ['build']],
    code: ['Opening in the editor', `Opened ${ctx.positional[0] ?? 'something'} in the editor.`, ['extension']],
    cursor: ['Opening in Cursor', `Opened ${ctx.positional[0] ?? 'something'} in Cursor.`, ['extension']],
    source: ['Loading shell settings', `Loaded settings from ${ctx.positional[0] ?? 'a file'} into the terminal.`, ['env-var']],
    export: ['Setting a variable', `Set an environment variable for later commands.`, ['env-var']],
    unset: ['Clearing a variable', 'Removed an environment variable.', ['env-var']],
    alias: ['Creating a shortcut', 'Defined a terminal shortcut.', ['command']],
    set: ['Adjusting shell options', 'Changed how the shell behaves for the rest of the command.', ['terminal']],
    cd: ['Changing folder', `Moved into ${ctx.positional[0] ? shortPath(ctx.positional[0], ctx.workspaceRoot) : 'the home folder'}.`, ['cwd']],
    exit: ['Ending', 'Ended the shell session.', ['exit-code']],
    clear: ['Clearing the screen', 'Cleared the terminal display.', ['terminal']],
  };
  const [title, summary, vocab] = map[p] ?? ['Running a system command', `Ran ${p}.`, []];
  return { title, summary, vocabulary: vocab };
});

function describeGh(ctx: ShellContext): string {
  const [a, b] = ctx.positional;
  if (a === 'pr' && b === 'create') return 'Opened a pull request on GitHub so the changes can be reviewed and merged.';
  if (a === 'pr') return `Worked with pull requests on GitHub (${b ?? ''}).`.trim();
  if (a === 'issue') return `Worked with GitHub issues (${b ?? ''}).`.trim();
  if (a === 'repo' && b === 'create') return 'Created a new repository on GitHub.';
  if (a === 'auth') return 'Checked or set up GitHub login.';
  if (a === 'run' || a === 'workflow') return 'Checked automated GitHub workflows (CI).';
  return `Ran the GitHub command-line tool (gh ${a ?? ''}).`.trim();
}

const testShell: ShellTemplate = {
  id: 'shell.test-expr',
  match: (ctx) => (ctx.program === 'test' || ctx.program === '[' ? 1 : 0),
  explain: (ctx) => makeExplanation({ templateId: 'shell.test-expr', title: 'Checking a condition', summary: `Checked whether ${ctx.has('-f') ? 'a file exists' : ctx.has('-d') ? 'a folder exists' : 'a condition holds'} before deciding what to do next.`, technical: tech(ctx), vocabulary: ['terminal'] }),
};

const forLoop: ShellTemplate = {
  id: 'shell.loop',
  match: (ctx) => (/^(for|while|if)\b/.test(ctx.segment) ? 1 : 0),
  explain: (ctx) => makeExplanation({ templateId: 'shell.loop', title: 'Running a small script', summary: `Ran a short ${ctx.segment.startsWith('if') ? 'if-then check' : 'loop'} in the terminal to repeat or branch a step.`, technical: tech(ctx), vocabulary: ['terminal'], confidence: 0.6 }),
};

const fallback: ShellTemplate = {
  id: 'shell.generic',
  match: () => 0.1,
  explain: (ctx) =>
    makeExplanation({
      templateId: 'shell.generic',
      title: 'Running a command',
      summary: `Ran the "${ctx.program}" command${ctx.positional[0] ? ` on ${shortPath(ctx.positional[0], ctx.workspaceRoot)}` : ''}.`,
      whatHappened: `Decipher does not have a plain-language description for "${ctx.program}" yet. The technical version is shown below.`,
      technical: tech(ctx),
      vocabulary: ['command', 'terminal'],
      confidence: 0.2,
    }),
};

export const SHELL_TEMPLATES: ShellTemplate[] = [
  versionCheck,
  gitStatus,
  gitDiff,
  gitLog,
  gitAdd,
  gitCommit,
  gitPush,
  gitPull,
  gitBranch,
  gitMisc,
  gitFallback,
  ripgrep,
  findCmd,
  ls,
  catCmd,
  wc,
  pwdWhich,
  fileOps,
  chmod,
  sedAwk,
  pkg,
  node,
  curl,
  lsof,
  testShell,
  forLoop,
  fallback,
];
