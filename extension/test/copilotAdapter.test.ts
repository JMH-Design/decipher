import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findCopilotWorkspaceStorage, fileUriToPath, listCopilotTranscripts, vscodeUserDataDir } from '../src/host/copilotPaths';
import { parseCopilotChatSession } from '../src/parser/adapters/copilotChatSession';
import { parseCopilotTranscript } from '../src/parser/adapters/copilotTranscript';
import { normalizeCopilotTool } from '../src/parser/adapters/copilotTools';

// ---------------------------------------------------------------------------
// Transcript event stream (Copilot Chat 0.51+)
// ---------------------------------------------------------------------------

const event = (type: string, data: Record<string, unknown>, timestamp: string) => JSON.stringify({ type, data, timestamp });

/** Shaped after a real `GitHub.copilot-chat/transcripts/<id>.jsonl`. */
const TRANSCRIPT = [
  event('session.start', { sessionId: 'sess-1', producer: 'copilot-agent', copilotVersion: '0.57.0' }, '2026-07-21T14:41:03.000Z'),
  event('user.message', { content: 'Rename the hero heading\nand keep the styles', attachments: [] }, '2026-07-21T14:41:10.000Z'),
  event('assistant.turn_start', { turnId: '0' }, '2026-07-21T14:41:10.100Z'),
  event('assistant.message', { content: 'Reading the component first.', toolRequests: [] }, '2026-07-21T14:41:11.000Z'),
  event('tool.execution_start', { toolCallId: 'c1', toolName: 'read_file', arguments: { filePath: '/repo/src/Hero.tsx', startLine: 10, endLine: 19 } }, '2026-07-21T14:41:12.000Z'),
  event('tool.execution_complete', { toolCallId: 'c1', success: true }, '2026-07-21T14:41:12.500Z'),
  event('tool.execution_start', { toolCallId: 'c2', toolName: 'replace_string_in_file', arguments: { filePath: '/repo/src/Hero.tsx', oldString: 'Welcome', newString: 'Hello' } }, '2026-07-21T14:41:13.000Z'),
  event('tool.execution_complete', { toolCallId: 'c2', success: false, error: 'String not found' }, '2026-07-21T14:41:14.000Z'),
  event('assistant.message', { content: 'The heading text had already changed.', toolRequests: [] }, '2026-07-21T14:41:15.000Z'),
  event('assistant.turn_end', { turnId: '0' }, '2026-07-21T14:41:15.100Z'),
].join('\n');

describe('parseCopilotTranscript', () => {
  const parsed = parseCopilotTranscript('sess-1', TRANSCRIPT);

  it('starts a turn at each user message and closes it on assistant.turn_end', () => {
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].status).toBe('success');
    expect(parsed.turns[0].userRequest).toBe('Rename the hero heading\nand keep the styles');
    expect(parsed.title).toBe('Rename the hero heading');
  });

  it('translates Copilot tool names and arguments into the shared vocabulary', () => {
    expect(parsed.steps.map((s) => s.toolName)).toEqual(['Read', 'StrReplace']);
    expect(parsed.steps[0].input.path).toBe('/repo/src/Hero.tsx');
    expect(parsed.steps[0].input.offset).toBe(10);
    expect(parsed.steps[0].input.limit).toBe(10);
    expect(parsed.steps[0].category).toBe('reading');
    expect(parsed.steps[1].input.old_string).toBe('Welcome');
    expect(parsed.steps[1].category).toBe('editing');
  });

  it('pairs start and complete events for status, duration, and the error message', () => {
    expect(parsed.steps[0].status).toBe('done');
    expect(parsed.steps[0].durationMs).toBe(500);
    expect(parsed.steps[1].status).toBe('error');
    expect(parsed.steps[1].errorMessage).toBe('String not found');
  });

  it('attaches the prose before a tool call as its narration, and the last line as the outcome', () => {
    expect(parsed.steps[0].narration).toBe('Reading the component first.');
    expect(parsed.steps[1].narration).toBeUndefined();
    expect(parsed.turns[0].finalResponse).toBe('The heading text had already changed.');
  });

  it('leaves the turn active while a tool is still running', () => {
    // Everything up to and including the first `tool.execution_start`.
    const midTurn = TRANSCRIPT.split('\n').slice(0, 5).join('\n');
    const live = parseCopilotTranscript('sess-1', midTurn);
    expect(live.turns[0].status).toBe('active');
    expect(live.steps[0].status).toBe('running');
  });

  it('stays active when a new round opens after the previous one ended', () => {
    // Copilot runs several turn_start/turn_end rounds per user request. A trailing
    // turn_start means it is still working, even though a turn_end came before it.
    const multiRound = [
      TRANSCRIPT,
      event('assistant.turn_start', { turnId: '1' }, '2026-07-21T14:41:16.000Z'),
    ].join('\n');
    const parsed = parseCopilotTranscript('sess-1', multiRound);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].status).toBe('active');
  });

  it('groups every round of one user request under a single turn', () => {
    const twoRounds = [
      TRANSCRIPT,
      event('assistant.turn_start', { turnId: '1' }, '2026-07-21T14:41:16.000Z'),
      event('assistant.message', { content: 'Anything else?', toolRequests: [] }, '2026-07-21T14:41:17.000Z'),
      event('assistant.turn_end', { turnId: '1' }, '2026-07-21T14:41:17.100Z'),
    ].join('\n');
    const parsed = parseCopilotTranscript('sess-1', twoRounds);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].status).toBe('success');
    expect(parsed.turns[0].finalResponse).toBe('Anything else?');
  });

  it('tolerates a half-written trailing line', () => {
    const truncated = `${TRANSCRIPT.split('\n').slice(0, 4).join('\n')}\n{"type":"tool.exec`;
    expect(() => parseCopilotTranscript('sess-1', truncated)).not.toThrow();
    expect(parseCopilotTranscript('sess-1', truncated).steps).toHaveLength(0);
  });
});

describe('normalizeCopilotTool', () => {
  it('maps the todo tool onto the shared checklist shape', () => {
    const { toolName, input } = normalizeCopilotTool('manage_todo_list', {
      operation: 'write',
      todoList: [
        { id: 1, title: 'Extract the keyframes', status: 'in-progress' },
        { id: 2, title: 'Write the prompt', status: 'not-started' },
      ],
    });
    expect(toolName).toBe('TodoWrite');
    expect(input.todos).toEqual([
      { content: 'Extract the keyframes', status: 'in_progress' },
      { content: 'Write the prompt', status: 'pending' },
    ]);
  });

  it('turns terminal calls into Shell steps with the agent’s own description', () => {
    const { toolName, input } = normalizeCopilotTool('run_in_terminal', { command: 'npm test', explanation: 'Run the suite' });
    expect(toolName).toBe('Shell');
    expect(input.description).toBe('Run the suite');
  });

  it('unpacks `mcp_<server>_<tool>` into a dynamic tool call', () => {
    const { toolName, input } = normalizeCopilotTool('mcp_figma_get_screenshot', { nodeId: '1:2' });
    expect(toolName).toBe('CallDynamicTool');
    expect(input.namespace).toBe('figma');
    expect(input.toolName).toBe('get_screenshot');
    expect(input.arguments).toEqual({ nodeId: '1:2' });
  });

  it('survives a tool call with no arguments at all', () => {
    expect(normalizeCopilotTool('get_errors', undefined).input).toEqual({ paths: undefined });
  });
});

// ---------------------------------------------------------------------------
// chatSessions fallback (VS Code's own delta log)
// ---------------------------------------------------------------------------

describe('parseCopilotChatSession', () => {
  const base = {
    kind: 0,
    v: {
      sessionId: 'sess-2',
      customTitle: 'Greeting',
      requests: [{ requestId: 'r0', timestamp: 100, modelId: 'gpt-5-mini', message: { text: 'hello' }, response: [{ value: 'Hi there.' }], result: { timings: {} } }],
    },
  };

  it('replays the snapshot plus its deltas into one session', () => {
    const jsonl = [
      JSON.stringify(base),
      JSON.stringify({ kind: 2, k: ['requests'], v: [{ requestId: 'r1', timestamp: 200, message: { text: 'now list the files' }, response: [{ kind: 'toolInvocationSerialized', toolId: 'list_dir', toolSpecificData: { path: '/repo/src' }, isComplete: true }] }] }),
      JSON.stringify({ kind: 1, k: ['requests', 1, 'result'], v: { timings: {} } }),
    ].join('\n');

    const parsed = parseCopilotChatSession('sess-2', jsonl);
    expect(parsed.turns.map((t) => t.userRequest)).toEqual(['hello', 'now list the files']);
    expect(parsed.turns.every((t) => t.status === 'success')).toBe(true);
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0].toolName).toBe('Glob');
    expect(parsed.agentModel).toBeUndefined();
  });

  it('marks the request still streaming as the active turn', () => {
    const jsonl = [JSON.stringify({ kind: 0, v: { requests: [{ message: { text: 'go' }, response: [] }] } })].join('\n');
    expect(parseCopilotChatSession('sess-3', jsonl).turns[0].status).toBe('active');
  });

  it('reports a failed request as an error turn', () => {
    const jsonl = JSON.stringify({ kind: 0, v: { requests: [{ message: { text: 'go' }, response: [], result: { errorDetails: { message: 'Rate limited' } } }] } });
    expect(parseCopilotChatSession('sess-4', jsonl).turns[0].status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Workspace storage discovery
// ---------------------------------------------------------------------------

describe('vscodeUserDataDir', () => {
  it('points at the Insiders folder when running in Insiders', () => {
    expect(vscodeUserDataDir('vscode', {}, 'darwin', '/home/me')).toBe('/home/me/Library/Application Support/Code/User');
    expect(vscodeUserDataDir('vscode-insiders', {}, 'darwin', '/home/me')).toBe('/home/me/Library/Application Support/Code - Insiders/User');
  });

  it('follows the platform convention on Windows and Linux', () => {
    expect(vscodeUserDataDir('vscode', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me')).toBe(path.join('C:\\Users\\me\\AppData\\Roaming', 'Code', 'User'));
    expect(vscodeUserDataDir('vscode', {}, 'linux', '/home/me')).toBe('/home/me/.config/Code/User');
  });
});

describe('fileUriToPath', () => {
  it('decodes escaped characters and strips the scheme', () => {
    expect(fileUriToPath('file:///Users/me/My%20Site')).toBe('/Users/me/My Site');
    expect(fileUriToPath('file:///c%3A/src/app')).toBe('c:/src/app');
    expect(fileUriToPath('vscode-remote://ssh/home/me')).toBe('vscode-remote://ssh/home/me');
  });
});

describe('findCopilotWorkspaceStorage', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function userDataDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decipher-vscode-'));
    roots.push(dir);
    fs.mkdirSync(path.join(dir, 'workspaceStorage'), { recursive: true });
    return dir;
  }

  function storage(userDir: string, hash: string, meta: object, transcripts: string[] = []): string {
    const dir = path.join(userDir, 'workspaceStorage', hash);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(meta));
    if (transcripts.length) {
      const t = path.join(dir, 'GitHub.copilot-chat', 'transcripts');
      fs.mkdirSync(t, { recursive: true });
      for (const name of transcripts) fs.writeFileSync(path.join(t, name), '{}');
    }
    return dir;
  }

  it('matches on the folder URI, not on which storage folder was touched most recently', () => {
    const userDir = userDataDir();
    storage(userDir, 'aaa', { folder: 'file:///repo/other' }, ['newest.jsonl']);
    const wanted = storage(userDir, 'bbb', { folder: 'file:///repo/mine' }, ['s1.jsonl']);
    expect(findCopilotWorkspaceStorage(userDir, '/repo/mine')?.storageDir).toBe(wanted);
  });

  it('matches a folder inside a multi-root .code-workspace', () => {
    const userDir = userDataDir();
    const wsFile = path.join(userDir, 'my.code-workspace');
    fs.writeFileSync(wsFile, '// roots\n{"folders":[{"path":"/repo/api"},{"path":"/repo/web"}]}');
    const wanted = storage(userDir, 'ccc', { workspace: `file://${wsFile}` }, ['s1.jsonl']);
    expect(findCopilotWorkspaceStorage(userDir, '/repo/web')?.storageDir).toBe(wanted);
  });

  it('prefers the duplicate entry that actually has transcripts', () => {
    const userDir = userDataDir();
    storage(userDir, 'empty', { folder: 'file:///repo/mine' });
    const withChats = storage(userDir, 'full', { folder: 'file:///repo/mine' }, ['s1.jsonl']);
    expect(findCopilotWorkspaceStorage(userDir, '/repo/mine')?.storageDir).toBe(withChats);
  });

  it('returns nothing when the workspace was never opened in VS Code', () => {
    const userDir = userDataDir();
    storage(userDir, 'aaa', { folder: 'file:///repo/other' });
    expect(findCopilotWorkspaceStorage(userDir, '/repo/mine')).toBeUndefined();
    expect(findCopilotWorkspaceStorage(path.join(userDir, 'nope'), '/repo/mine')).toBeUndefined();
  });

  it('falls back to the VS Code chat log when Copilot wrote no transcript', () => {
    const userDir = userDataDir();
    const dir = storage(userDir, 'aaa', { folder: 'file:///repo/mine' });
    fs.mkdirSync(path.join(dir, 'chatSessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chatSessions', 'old.jsonl'), '{}');
    const ws = findCopilotWorkspaceStorage(userDir, '/repo/mine')!;
    expect(listCopilotTranscripts(ws).map((t) => t.format)).toEqual(['chat-session']);
  });
});
