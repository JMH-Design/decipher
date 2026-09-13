import * as path from 'node:path';

export interface FriendlyFile {
  /** e.g. "main stylesheet" */
  label: string;
  /** e.g. "global.css" */
  basename: string;
  /** e.g. "the main stylesheet (global.css)" */
  phrase: string;
  /** Glossary ids relevant to this file type. */
  vocabulary: string[];
  /** True for files where contents must never be displayed. */
  sensitive: boolean;
}

interface Rule {
  test: RegExp;
  label: string;
  vocabulary?: string[];
  sensitive?: boolean;
}

const RULES: Rule[] = [
  { test: /(^|\/)\.env(\.|$)/, label: 'secret settings file', vocabulary: ['env-var'], sensitive: true },
  { test: /\.(pem|key)$|id_rsa|id_ed25519/, label: 'private key file', vocabulary: ['env-var'], sensitive: true },
  { test: /(^|\/)package\.json$/, label: 'project settings file (lists packages and shortcuts)', vocabulary: ['package-json', 'npm'] },
  { test: /(^|\/)package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|bun\.lockb?$/, label: 'package lock file (exact versions of downloaded code)', vocabulary: ['npm', 'package'] },
  { test: /(^|\/)tsconfig[^/]*\.json$/, label: 'TypeScript settings', vocabulary: ['typescript', 'typecheck'] },
  { test: /(^|\/)\.gitignore$/, label: 'list of files git should ignore', vocabulary: ['gitignore'] },
  { test: /(^|\/)README\.md$/i, label: 'project README (the front-door explanation)', vocabulary: ['markdown'] },
  { test: /(^|\/)SKILL\.md$/, label: 'agent skill guide', vocabulary: ['skill'] },
  { test: /\.plan\.md$/, label: 'plan document', vocabulary: ['plan-mode', 'markdown'] },
  { test: /\.mdc$/, label: 'agent rule', vocabulary: ['rule'] },
  { test: /(^|\/)hooks\.json$/, label: 'hooks configuration', vocabulary: ['hook'] },
  { test: /\.canvas\.tsx$/, label: 'canvas panel', vocabulary: ['canvas'] },
  { test: /(^|\/)(global|globals|main|index|app|base|reset)\.(css|scss)$/, label: 'main stylesheet', vocabulary: ['css'] },
  { test: /\.(css|scss|sass|less)$/, label: 'stylesheet', vocabulary: ['css'] },
  { test: /\.astro$/, label: 'Astro page/component', vocabulary: ['component', 'framework'] },
  { test: /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/, label: 'test file', vocabulary: ['test'] },
  { test: /\.tsx$/, label: 'React component (TypeScript)', vocabulary: ['component', 'typescript'] },
  { test: /\.jsx$/, label: 'React component', vocabulary: ['component', 'javascript'] },
  { test: /\.d\.ts$/, label: 'type definitions', vocabulary: ['typescript'] },
  { test: /\.ts$/, label: 'TypeScript script', vocabulary: ['typescript'] },
  { test: /\.(js|mjs|cjs)$/, label: 'JavaScript script', vocabulary: ['javascript'] },
  { test: /\.(html|htm)$/, label: 'web page', vocabulary: ['html'] },
  { test: /\.(vue|svelte)$/, label: 'UI component', vocabulary: ['component', 'framework'] },
  { test: /\.py$/, label: 'Python script', vocabulary: ['source-code'] },
  { test: /\.(sh|zsh|bash)$/, label: 'shell script', vocabulary: ['terminal'] },
  { test: /\.jsonl$/, label: 'log file (one record per line)', vocabulary: ['jsonl'] },
  { test: /\.json$/, label: 'settings/data file', vocabulary: ['json'] },
  { test: /\.(ya?ml)$/, label: 'configuration file', vocabulary: ['yaml'] },
  { test: /\.(md|mdx)$/, label: 'notes/document', vocabulary: ['markdown'] },
  { test: /\.(png|jpe?g|gif|webp|svg|ico)$/, label: 'image', vocabulary: [] },
  { test: /\.(mp4|mov|webm)$/, label: 'video', vocabulary: [] },
  { test: /\.(woff2?|ttf|otf)$/, label: 'font file', vocabulary: [] },
  { test: /\.(csv|tsv)$/, label: 'spreadsheet-style data', vocabulary: [] },
  { test: /\.(sql)$/, label: 'database query file', vocabulary: ['api'] },
  { test: /\.(lock)$/, label: 'lock file', vocabulary: ['package'] },
];

/** Path segments that hint at the file's role. */
const DIR_HINTS: Array<[RegExp, string]> = [
  [/\/components?\//, 'component'],
  [/\/pages?\//, 'page'],
  [/\/layouts?\//, 'layout'],
  [/\/styles?\//, 'style'],
  [/\/scripts?\//, 'script'],
  [/\/(tests?|__tests__|spec)\//, 'test'],
  [/\/(utils?|helpers?|lib)\//, 'helper'],
  [/\/(api|server|backend)\//, 'server-side'],
  [/\/(public|static|assets)\//, 'static asset'],
  [/\/debug\//, 'debug'],
  [/\/lab\//, 'experimental'],
  [/\/\.cursor\//, 'Cursor settings'],
  [/\/node_modules\//, 'third-party package'],
];

export function friendlyFile(filePath: string | undefined): FriendlyFile {
  const p = String(filePath ?? '').replace(/\\/g, '/');
  const basename = path.posix.basename(p) || p || 'a file';
  const rule = RULES.find((r) => r.test.test(p));
  let label = rule?.label ?? 'file';
  const hint = DIR_HINTS.find(([re]) => re.test(p))?.[1];
  if (hint && !label.toLowerCase().includes(hint) && label === 'file') label = `${hint} file`;
  else if (hint && ['stylesheet', 'TypeScript script', 'JavaScript script'].includes(label) && hint !== 'style' && hint !== 'script') {
    label = `${hint} ${label}`;
  }
  const article = /^[aeiou]/i.test(label) ? 'an' : 'a';
  const phrase = label === 'main stylesheet' ? `the main stylesheet (${basename})` : `${article} ${label} (${basename})`;
  return { label, basename, phrase, vocabulary: rule?.vocabulary ?? ['source-code'], sensitive: rule?.sensitive ?? false };
}

/** Shorten an absolute path to something a person can scan, e.g. `src/styles/global.css`. */
export function shortPath(filePath: string | undefined, workspaceRoot?: string): string {
  if (!filePath) return '';
  let p = filePath.replace(/\\/g, '/');
  if (workspaceRoot && p.startsWith(workspaceRoot.replace(/\\/g, '/'))) p = p.slice(workspaceRoot.length).replace(/^\//, '');
  const parts = p.split('/');
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : p;
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
