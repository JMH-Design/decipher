import type { AgentProvider, DataSourcePreference, HostKind } from '../../../shared/activity-schema';

/**
 * Decipher runs in more than one editor, and each editor stores its agent transcripts
 * somewhere different. Host detection is the first thing the extension does: it decides which
 * agent sources are plausible before any directory is touched.
 */

export type { AgentProvider, DataSourcePreference, HostKind };

/**
 * Map `vscode.env.appName` to a host. Insiders is checked first because its name contains
 * "Visual Studio Code" too.
 */
export function detectHost(appName: string | undefined): HostKind {
  const name = (appName ?? '').toLowerCase();
  if (!name) return 'unknown';
  if (name.includes('cursor')) return 'cursor';
  if (name.includes('insiders')) return 'vscode-insiders';
  if (name.includes('visual studio code') || name.includes('code - oss') || name.includes('vscodium')) return 'vscode';
  return 'unknown';
}

/**
 * Providers worth trying for this host, best first. Claude Code is a terminal agent, so it can
 * be running inside any editor — it is always a candidate, just never the first guess.
 */
export function candidateProviders(host: HostKind, preference: DataSourcePreference = 'auto'): AgentProvider[] {
  if (preference !== 'auto') return [preference];
  switch (host) {
    case 'cursor':
      return ['cursor', 'claude-code'];
    case 'vscode':
    case 'vscode-insiders':
      return ['copilot', 'claude-code'];
    default:
      return ['cursor', 'copilot', 'claude-code'];
  }
}

/** Only Cursor exposes a hook API Decipher can install into, so only there do we offer it. */
export function hooksSupported(host: HostKind, provider: AgentProvider): boolean {
  return host === 'cursor' && provider === 'cursor';
}

/** Long form, used in sentences: "Watching GitHub Copilot work". */
export const AGENT_LABEL: Record<AgentProvider, string> = {
  cursor: 'the Cursor agent',
  copilot: 'GitHub Copilot',
  'claude-code': 'Claude Code',
};

/** Short form, used where space is tight: the loader stage line and the footer. */
export const AGENT_SHORT_LABEL: Record<AgentProvider, string> = {
  cursor: 'the agent',
  copilot: 'Copilot',
  'claude-code': 'Claude',
};

export const HOST_LABEL: Record<HostKind, string> = {
  cursor: 'Cursor',
  vscode: 'VS Code',
  'vscode-insiders': 'VS Code Insiders',
  unknown: 'this editor',
};
