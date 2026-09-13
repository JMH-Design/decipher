import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore, resolveStore, type StoreContext } from '../src/host/transcriptStore';

/**
 * The store is where host detection, path discovery, and parser choice meet. These tests
 * build real directories in a temp folder rather than mocking `fs`, because the bugs worth
 * catching here are about layout, not about call counts.
 */

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const WORKSPACE = '/repo/mine';

function context(over: Partial<StoreContext> = {}): StoreContext {
  return { host: 'cursor', workspacePath: WORKSPACE, preference: 'auto', storageDir: tmp('decipher-storage-'), ...over };
}

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

// ---------------------------------------------------------------------------

const cursorLine = (role: string, content: unknown) => JSON.stringify({ role, message: { content } });

/** `<projectsDir>/repo-mine/agent-transcripts/<id>/<id>.jsonl`, the layout Cursor writes. */
function cursorProject(id: string, lines: string[]): string {
  const projectsDir = tmp('decipher-cursor-');
  write(path.join(projectsDir, 'repo-mine', 'agent-transcripts', id, `${id}.jsonl`), lines.join('\n'));
  return projectsDir;
}

describe('CursorStore', () => {
  const conversation = [
    cursorLine('user', [{ type: 'text', text: '<user_query>add a sitemap</user_query>' }]),
    cursorLine('assistant', [{ type: 'tool_use', name: 'Task', input: { description: 'explore', subagent_type: 'explore' } }]),
    cursorLine('assistant', [{ type: 'text', text: 'Done — the sitemap is generated at build time.' }]),
  ];

  it('lists conversations with the user’s own words as the title', () => {
    const projectsDir = cursorProject('conv-1', conversation);
    const sources = createStore('cursor', context({ cursorProjectsDir: projectsDir })).list();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ id: 'conv-1', provider: 'cursor', format: 'cursor', title: 'add a sitemap', hasMessages: true });
  });

  it('nests subagent transcripts under the Task step that spawned them', () => {
    const projectsDir = cursorProject('conv-1', conversation);
    write(
      path.join(projectsDir, 'repo-mine', 'agent-transcripts', 'conv-1', 'subagents', 'sub-a.jsonl'),
      [cursorLine('assistant', [{ type: 'tool_use', name: 'Grep', input: { pattern: 'sitemap' } }])].join('\n'),
    );

    const parsed = createStore('cursor', context({ cursorProjectsDir: projectsDir })).load('conv-1')!;
    const task = parsed.steps.find((s) => s.toolName === 'Task')!;
    const nested = parsed.steps.find((s) => s.subagentId === 'sub-a')!;
    expect(nested.parentStepId).toBe(task.id);
    expect(nested.turnIndex).toBe(task.turnIndex);
    // Steps stay in execution order after the subagent's are spliced in.
    expect(parsed.steps.map((s) => s.index)).toEqual([...parsed.steps.map((s) => s.index)].sort((a, b) => a - b));
  });

  it('exposes the hook events directory, which only exists in Cursor', () => {
    const store = createStore('cursor', context({ cursorProjectsDir: cursorProject('conv-1', conversation) }));
    expect(store.eventsDir).toContain(path.join('decipher', 'events'));
    expect(store.hooksSupported).toBe(true);
    expect(store.watchDirs).toHaveLength(2);
  });

  it('reports no hook support when Cursor transcripts are read from another editor', () => {
    const store = createStore('cursor', context({ host: 'vscode', cursorProjectsDir: cursorProject('conv-1', conversation) }));
    expect(store.hooksSupported).toBe(false);
  });

  it('returns undefined for a conversation that is not on disk', () => {
    expect(createStore('cursor', context({ cursorProjectsDir: cursorProject('conv-1', conversation) })).load('missing')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

/** `<claudeHome>/projects/-repo-mine/<id>.jsonl`. */
function claudeHome(sessions: Record<string, string>): string {
  const home = tmp('decipher-claude-home-');
  for (const [id, contents] of Object.entries(sessions)) write(path.join(home, 'projects', '-repo-mine', `${id}.jsonl`), contents);
  return home;
}

const claudeConversation = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'ship the nav fix' }, timestamp: '2026-09-12T19:00:00.000Z' }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/nav.tsx' } }], stop_reason: 'end_turn' } }),
].join('\n');

describe('ClaudeStore', () => {
  it('finds sessions, titles them, and parses them with the Claude adapter', () => {
    const store = createStore('claude-code', context({ claudeConfigDir: claudeHome({ 'sess-1': claudeConversation }) }));
    expect(store.list()[0]).toMatchObject({ id: 'sess-1', provider: 'claude-code', format: 'claude-code', title: 'ship the nav fix', hasMessages: true });
    expect(store.load('sess-1')!.steps[0].toolName).toBe('Read');
  });

  it('keeps Decipher’s own cache out of the agent’s directory', () => {
    const storageDir = tmp('decipher-storage-');
    const store = createStore('claude-code', context({ storageDir, claudeConfigDir: claudeHome({ 'sess-1': claudeConversation }) }));
    expect(store.researchDir.startsWith(storageDir)).toBe(true);
    expect(store.eventsDir).toBeUndefined();
    expect(store.hooksSupported).toBe(false);
  });

  it('titles a slash-command session with the command, not the wrapper tags', () => {
    const session = JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-message>design</command-message>\n<command-name>/design</command-name>' } });
    const store = createStore('claude-code', context({ claudeConfigDir: claudeHome({ 'sess-1': session }) }));
    expect(store.list()[0].title).toBe('/design');
  });

  it('surfaces a session Claude saved without its messages', () => {
    const home = claudeHome({ 'sess-1': JSON.stringify({ type: 'custom-title', customTitle: 'Stub' }) });
    expect(createStore('claude-code', context({ claudeConfigDir: home })).list()[0].hasMessages).toBe(false);
  });

  it('lists nothing, rather than failing, when Claude Code never ran here', () => {
    const store = createStore('claude-code', context({ claudeConfigDir: tmp('decipher-claude-empty-') }));
    expect(store.list()).toEqual([]);
    expect(store.watchDirs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('resolveStore', () => {
  it('prefers the host-native agent when it has conversations', () => {
    const ctx = context({
      cursorProjectsDir: cursorProject('conv-1', [cursorLine('user', [{ type: 'text', text: '<user_query>hi</user_query>' }])]),
      claudeConfigDir: claudeHome({ 'sess-1': claudeConversation }),
    });
    expect(resolveStore(ctx).provider).toBe('cursor');
  });

  it('falls through to Claude Code when the host-native agent has nothing', () => {
    const ctx = context({ cursorProjectsDir: tmp('decipher-cursor-empty-'), claudeConfigDir: claudeHome({ 'sess-1': claudeConversation }) });
    expect(resolveStore(ctx).provider).toBe('claude-code');
  });

  it('ignores a source whose only session has no messages', () => {
    const ctx = context({
      cursorProjectsDir: tmp('decipher-cursor-empty-'),
      claudeConfigDir: claudeHome({ 'sess-1': JSON.stringify({ type: 'custom-title', customTitle: 'Stub' }) }),
    });
    // Nothing is readable anywhere, so we fall back to the host's agent for the empty state.
    expect(resolveStore(ctx).provider).toBe('cursor');
  });

  it('obeys an explicit decipher.dataSource even when another agent has more to show', () => {
    const ctx = context({
      preference: 'claude-code',
      cursorProjectsDir: cursorProject('conv-1', [cursorLine('user', [{ type: 'text', text: '<user_query>hi</user_query>' }])]),
      claudeConfigDir: claudeHome({ 'sess-1': claudeConversation }),
    });
    expect(resolveStore(ctx).provider).toBe('claude-code');
  });

  it('looks for Copilot first in VS Code', () => {
    const ctx = context({ host: 'vscode', cursorProjectsDir: tmp('decipher-cursor-empty-'), claudeConfigDir: tmp('decipher-claude-empty-') });
    expect(resolveStore(ctx).provider).toBe('copilot');
  });
});
