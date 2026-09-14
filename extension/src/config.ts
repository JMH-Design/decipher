import * as vscode from 'vscode';

/** Read `lumen.*` settings, falling back to the pre-rename `decipher.*` keys. */
export function lumenConfig<T>(key: string): T | undefined {
  const lumen = vscode.workspace.getConfiguration('lumen').get<T>(key);
  if (lumen !== undefined) return lumen;
  return vscode.workspace.getConfiguration('decipher').get<T>(key);
}

export function lumenConfigUpdate(key: string, value: unknown): Thenable<void> {
  return vscode.workspace.getConfiguration('lumen').update(key, value, vscode.ConfigurationTarget.Global);
}

/** Secret storage: prefer the Lumen key, fall back to Decipher for upgrades. */
export const SEARCH_KEY_SECRET = 'lumen.contextDevApiKey';
export const LEGACY_SEARCH_KEY_SECRET = 'decipher.contextDevApiKey';
