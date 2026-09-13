import { describe, expect, it } from 'vitest';
import { extractUserQuery, parseTranscript } from '../src/parser/transcriptParser';

const user = (text: string) => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text }] } });
const assistant = (blocks: unknown[]) => JSON.stringify({ role: 'assistant', message: { content: blocks } });
const ended = (status = 'success') => JSON.stringify({ type: 'turn_ended', status });

describe('parseTranscript', () => {
  it('extracts turns, steps, narration and categories', () => {
    const jsonl = [
      user('<timestamp>Sunday, Sep 13, 2026, 12:19 PM (UTC-4)</timestamp>\n<user_query>\nremove the bake-off page\n</user_query>'),
      assistant([
        { type: 'text', text: 'Checking for leftover references first.' },
        { type: 'tool_use', name: 'Shell', input: { command: "rg -n 'home-field' . && git status" } },
        { type: 'tool_use', name: 'Read', input: { path: '/p/src/pages/index.astro' } },
      ]),
      assistant([{ type: 'text', text: 'Done.' }]),
      ended(),
    ].join('\n');
    const t = parseTranscript('conv', jsonl);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0].userRequest).toBe('remove the bake-off page');
    expect(t.turns[0].status).toBe('success');
    expect(t.turns[0].finalResponse).toBe('Done.');
    expect(t.steps).toHaveLength(2);
    expect(t.steps[0].category).toBe('checking');
    expect(t.steps[0].narration).toBe('Checking for leftover references first.');
    expect(t.steps[1].category).toBe('reading');
    expect(t.steps.every((s) => s.status === 'done')).toBe(true);
    expect(t.title).toBe('remove the bake-off page');
  });

  it('marks the last batch of an active turn as running and tolerates partial lines', () => {
    const jsonl = [user('<user_query>do it</user_query>'), assistant([{ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }]), '{"role":"assis'].join('\n');
    const t = parseTranscript('conv', jsonl);
    expect(t.turns[0].status).toBe('active');
    expect(t.steps[0].status).toBe('running');
  });

  it('normalises hook-style tool names', () => {
    const t = parseTranscript('c', assistant([{ type: 'tool_use', name: 'run_terminal_cmd', input: { command: 'git push' } }]));
    expect(t.steps[0].toolName).toBe('Shell');
    expect(t.steps[0].category).toBe('saving');
  });

  it('extractUserQuery strips wrapper tags', () => {
    expect(extractUserQuery('<attached_files>x</attached_files><user_query>hello\nworld</user_query>').query).toBe('hello\nworld');
  });
});
