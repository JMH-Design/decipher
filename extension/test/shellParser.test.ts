import { describe, expect, it } from 'vitest';
import { firstProgram, redactCommand, splitShellCommand, tokenize } from '../src/parser/shellParser';

describe('splitShellCommand', () => {
  it('splits on && ; || but not inside quotes', () => {
    expect(splitShellCommand(`rg -n 'a && b' . && git status; ls || echo "x; y"`)).toEqual([`rg -n 'a && b' .`, 'git status', 'ls', 'echo "x; y"']);
  });

  it('keeps pipelines in one segment', () => {
    expect(splitShellCommand('rg foo | head -5 && ls')).toEqual(['rg foo | head -5', 'ls']);
  });

  it('keeps heredocs intact', () => {
    const cmd = `git add a.ts && git commit -m "$(cat <<'EOF'\nSubject line\n\nBody; with && operators\nEOF\n)" && git status`;
    const segs = splitShellCommand(cmd);
    expect(segs).toHaveLength(3);
    expect(segs[1]).toContain('Subject line');
  });

  it('does not split inside subshells', () => {
    expect(splitShellCommand('find . \\( -name a -o -name b \\) && ls')).toHaveLength(2);
    expect(splitShellCommand('echo $(a && b) && c')).toHaveLength(2);
  });
});

describe('tokenize / firstProgram', () => {
  it('drops quotes and handles escapes', () => {
    expect(tokenize(`rg -n "home-field|data-home-field" . --glob '!node_modules'`)).toEqual(['rg', '-n', 'home-field|data-home-field', '.', '--glob', '!node_modules']);
  });

  it('skips env assignments, wrappers and redirections', () => {
    const p = firstProgram('NODE_ENV=production sudo head -n 10 /tmp/*.txt 2>/dev/null | wc -l');
    expect(p.program).toBe('head');
    expect(p.args).toEqual(['-n', '10', '/tmp/*.txt']);
    expect(p.filters).toEqual(['wc -l']);
    expect(p.env).toEqual(['NODE_ENV=production']);
  });
});

describe('redactCommand', () => {
  it('hides tokens and secrets', () => {
    expect(redactCommand('curl -H "Authorization: Bearer abcdefghijklmnop" x')).toContain('Bearer [redacted]');
    expect(redactCommand('export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz')).not.toContain('ghp_abc');
    expect(redactCommand('npm login --password hunter22')).toContain('[redacted]');
  });
});
