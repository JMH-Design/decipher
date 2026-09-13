import { describe, expect, it } from 'vitest';
import { candidateProviders, detectHost, hooksSupported } from '../src/host/detectHost';

describe('detectHost', () => {
  it('recognises the editors Decipher ships to', () => {
    expect(detectHost('Cursor')).toBe('cursor');
    expect(detectHost('Visual Studio Code')).toBe('vscode');
    expect(detectHost('VSCodium')).toBe('vscode');
    expect(detectHost('Code - OSS')).toBe('vscode');
  });

  it('reads Insiders as Insiders, not as stable VS Code', () => {
    expect(detectHost('Visual Studio Code - Insiders')).toBe('vscode-insiders');
  });

  it('falls back to unknown rather than guessing', () => {
    expect(detectHost(undefined)).toBe('unknown');
    expect(detectHost('Some Other Editor')).toBe('unknown');
  });
});

describe('candidateProviders', () => {
  it('prefers the host-native agent, then Claude Code, which can run anywhere', () => {
    expect(candidateProviders('cursor')).toEqual(['cursor', 'claude-code']);
    expect(candidateProviders('vscode')).toEqual(['copilot', 'claude-code']);
    expect(candidateProviders('vscode-insiders')).toEqual(['copilot', 'claude-code']);
  });

  it('an explicit preference wins outright, so a pinned source is never second-guessed', () => {
    expect(candidateProviders('cursor', 'copilot')).toEqual(['copilot']);
    expect(candidateProviders('vscode', 'cursor')).toEqual(['cursor']);
  });
});

describe('hooksSupported', () => {
  it('is true only for the Cursor agent inside Cursor', () => {
    expect(hooksSupported('cursor', 'cursor')).toBe(true);
    expect(hooksSupported('cursor', 'claude-code')).toBe(false);
    expect(hooksSupported('vscode', 'copilot')).toBe(false);
  });
});
