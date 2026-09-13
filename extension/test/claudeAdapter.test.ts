import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeHomeDir, claudeProjectSlug, findClaudeProjectDir, listClaudeSessions } from '../src/host/claudePaths';
import { parseClaudeTranscript } from '../src/parser/adapters/claudeTranscript';
import { normalizeClaudeTool } from '../src/parser/adapters/claudeTools';

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

let clock = 0;
const stamp = () => new Date(1_760_000_000_000 + ++clock * 1000).toISOString();

const user = (content: unknown, extra: object = {}) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content }, timestamp: stamp(), ...extra });
const assistant = (content: unknown, extra: object = {}) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-5', content, stop_reason: 'tool_use' }, timestamp: stamp(), ...extra });

describe('parseClaudeTranscript', () => {
  const jsonl = [
    JSON.stringify({ type: 'custom-title', customTitle: 'Ignore me', sessionId: 's1' }),
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'x' }),
    user('Tidy up the hero section'),
    assistant([{ type: 'text', text: 'Reading the component.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/repo/Hero.astro' } }]),
    user([{ type: 'tool_result', tool_use_id: 'tu1', content: 'file contents' }]),
    assistant([{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'npm run build', description: 'Build it' } }]),
    user([{ type: 'tool_result', tool_use_id: 'tu2', content: 'build failed', is_error: true }]),
    JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'The build is broken on main.' }], stop_reason: 'end_turn' },
      timestamp: stamp(),
    }),
  ].join('\n');

  const parsed = parseClaudeTranscript('s1', jsonl);

  it('treats only human prose as a turn boundary, not tool results or metadata lines', () => {
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].userRequest).toBe('Tidy up the hero section');
    expect(parsed.title).toBe('Tidy up the hero section');
  });

  it('translates Claude tool inputs into the shared vocabulary', () => {
    expect(parsed.steps.map((s) => s.toolName)).toEqual(['Read', 'Shell']);
    expect(parsed.steps[0].input.path).toBe('/repo/Hero.astro');
    expect(parsed.steps[0].category).toBe('reading');
  });

  it('resolves each step from the tool_result that came back for it', () => {
    expect(parsed.steps[0].status).toBe('done');
    expect(parsed.steps[0].output).toBe('file contents');
    expect(parsed.steps[1].status).toBe('error');
    expect(parsed.steps[1].errorMessage).toBe('build failed');
  });

  it('closes the turn on stop_reason: end_turn and records the model', () => {
    expect(parsed.turns[0].status).toBe('success');
    expect(parsed.turns[0].finalResponse).toBe('The build is broken on main.');
    expect(parsed.agentModel).toBe('claude-opus-5');
  });

  it('keeps a turn active while the agent is still working', () => {
    const live = parseClaudeTranscript('s2', [user('go'), assistant([{ type: 'tool_use', id: 't', name: 'Grep', input: { pattern: 'x' } }])].join('\n'));
    expect(live.turns[0].status).toBe('active');
    expect(live.steps[0].status).toBe('running');
  });

  it('closes the turn on the turn_duration record older builds write instead of end_turn', () => {
    const jsonlNoStop = [
      user('go'),
      assistant([{ type: 'tool_use', id: 't', name: 'Grep', input: { pattern: 'x' } }]),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 900, timestamp: stamp() }),
    ].join('\n');
    const t = parseClaudeTranscript('s3', jsonlNoStop);
    expect(t.turns[0].status).toBe('success');
    expect(t.steps[0].status).toBe('done');
  });

  it('hangs sidechain work off the Task that spawned it instead of the main timeline', () => {
    const withSidechain = [
      user('research this'),
      assistant([{ type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'explore', subagent_type: 'explore' } }]),
      JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'explore the repo' }, timestamp: stamp() }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'sub1', name: 'Glob', input: { pattern: '**/*.ts' } }] }, timestamp: stamp() }),
    ].join('\n');
    const t = parseClaudeTranscript('s4', withSidechain);

    expect(t.turns).toHaveLength(1);
    expect(t.turns[0].stepIds).toEqual([t.steps[0].id]);
    const sub = t.steps[1];
    expect(sub.toolName).toBe('Glob');
    expect(sub.subagentId).toBe(t.steps[0].id);
    expect(sub.parentStepId).toBe(t.steps[0].id);
  });

  it('strips the context Claude injects into user messages', () => {
    const injected = user([{ type: 'text', text: '<ide_opened_file>The user opened index.html</ide_opened_file>\nmake the header sticky' }]);
    expect(parseClaudeTranscript('s5', injected).turns[0].userRequest).toBe('make the header sticky');
  });

  it('reads a slash command invocation as the command the user typed', () => {
    // A slash command is nothing but wrapper tags, so stripping them all would
    // leave the turn with no request at all.
    const slash = [
      user('<command-message>design</command-message>\n<command-name>/design</command-name>'),
      assistant([{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/repo/Hero.astro' } }]),
    ].join('\n');
    const t = parseClaudeTranscript('s8', slash);
    expect(t.turns[0].userRequest).toBe('/design');
    expect(t.title).toBe('/design');
  });

  it('keeps the arguments passed to a slash command', () => {
    const slash = user('<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>5m /qa</command-args>');
    expect(parseClaudeTranscript('s9', slash).turns[0].userRequest).toBe('/loop 5m /qa');
  });

  it('marks the turn as an error when Claude records an API failure', () => {
    const failed = [user('go'), JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { content: [] }, timestamp: stamp() })].join('\n');
    expect(parseClaudeTranscript('s6', failed).turns[0].status).toBe('error');
  });

  it('yields an empty transcript for a metadata-only session rather than throwing', () => {
    const stub = [JSON.stringify({ type: 'custom-title', customTitle: 'Stub' }), JSON.stringify({ type: 'mode', mode: 'normal' }), '{"type":"assis'].join('\n');
    const t = parseClaudeTranscript('s7', stub);
    expect(t.turns).toHaveLength(0);
    expect(t.steps).toHaveLength(0);
  });
});

describe('normalizeClaudeTool', () => {
  it('flattens a MultiEdit into a single before/after pair', () => {
    const { toolName, input } = normalizeClaudeTool('MultiEdit', {
      file_path: '/repo/a.ts',
      edits: [
        { old_string: 'one', new_string: '1' },
        { old_string: 'two', new_string: '2' },
      ],
    });
    expect(toolName).toBe('StrReplace');
    expect(input.path).toBe('/repo/a.ts');
    expect(input.old_string).toBe('one\ntwo');
    expect(input.replace_all).toBe(true);
  });

  it('reads a slash command as the skill it invokes', () => {
    const { toolName, input } = normalizeClaudeTool('SlashCommand', { command: '/wayfinder' });
    expect(toolName).toBe('Skill');
    expect(input.skill).toBe('wayfinder');
  });

  it('reads ExitPlanMode as switching back to agent mode', () => {
    const { toolName, input } = normalizeClaudeTool('ExitPlanMode', { plan: 'Do the thing' });
    expect(toolName).toBe('SwitchMode');
    expect(input.target_mode_id).toBe('agent');
  });

  it('unpacks `mcp__<server>__<tool>` into a dynamic tool call', () => {
    const { toolName, input } = normalizeClaudeTool('mcp__linear-server__list_issues', { teamId: 't' });
    expect(toolName).toBe('CallDynamicTool');
    expect(input.namespace).toBe('linear-server');
    expect(input.toolName).toBe('list_issues');
  });
});

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

describe('claudeProjectSlug', () => {
  it('encodes the whole absolute path, leading slash included', () => {
    expect(claudeProjectSlug('/Users/me/Portfolio_DesignEngineer')).toBe('-Users-me-Portfolio-DesignEngineer');
    expect(claudeProjectSlug('/Users/me/My Site')).toBe('-Users-me-My-Site');
  });
});

describe('claudeHomeDir', () => {
  it('honours CLAUDE_CONFIG_DIR, and the setting ahead of it', () => {
    expect(claudeHomeDir(undefined, {}, '/home/me')).toBe('/home/me/.claude');
    expect(claudeHomeDir(undefined, { CLAUDE_CONFIG_DIR: '/opt/claude' }, '/home/me')).toBe('/opt/claude');
    expect(claudeHomeDir('~/alt', { CLAUDE_CONFIG_DIR: '/opt/claude' }, '/home/me')).toBe('/home/me/alt');
  });
});

describe('findClaudeProjectDir and listClaudeSessions', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function claudeHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decipher-claude-'));
    roots.push(dir);
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    return dir;
  }

  function project(home: string, slug: string): string {
    const dir = path.join(home, 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('finds the project folder for a workspace', () => {
    const home = claudeHome();
    const dir = project(home, '-repo-mine');
    expect(findClaudeProjectDir(home, '/repo/mine')).toBe(dir);
  });

  it('falls back to the newest folder with a matching basename when the encoding drifts', () => {
    const home = claudeHome();
    const dir = project(home, '-Volumes-disk-repo-mine');
    expect(findClaudeProjectDir(home, '/repo/mine')).toBe(dir);
  });

  it('returns nothing when Claude Code never ran here', () => {
    expect(findClaudeProjectDir(claudeHome(), '/repo/mine')).toBeUndefined();
  });

  it('flags a session that holds only bookkeeping records', () => {
    const home = claudeHome();
    const dir = project(home, '-repo-mine');
    fs.writeFileSync(path.join(dir, 'real.jsonl'), `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
    fs.writeFileSync(path.join(dir, 'stub.jsonl'), `${JSON.stringify({ type: 'custom-title', customTitle: 'Stub' })}\n`);

    const sessions = listClaudeSessions(dir);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.id === 'real')?.hasMessages).toBe(true);
    expect(sessions.find((s) => s.id === 'stub')?.hasMessages).toBe(false);
  });

  it('takes session titles from sessions-index.json when Claude wrote one', () => {
    const home = claudeHome();
    const dir = project(home, '-repo-mine');
    fs.writeFileSync(path.join(dir, 'abc.jsonl'), `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
    fs.writeFileSync(path.join(dir, 'sessions-index.json'), JSON.stringify({ version: 1, entries: [{ sessionId: 'abc', firstPrompt: 'Rework the nav' }] }));
    expect(listClaudeSessions(dir)[0].title).toBe('Rework the nav');
  });

  it('cleans the wrapper tags Claude stores verbatim in the index', () => {
    const home = claudeHome();
    const dir = project(home, '-repo-mine');
    fs.writeFileSync(path.join(dir, 'abc.jsonl'), `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
    fs.writeFileSync(
      path.join(dir, 'sessions-index.json'),
      JSON.stringify({ version: 1, entries: [{ sessionId: 'abc', firstPrompt: '<command-message>design</command-message>\n<command-name>/design</command-name>' }] }),
    );
    expect(listClaudeSessions(dir)[0].title).toBe('/design');
  });
});
