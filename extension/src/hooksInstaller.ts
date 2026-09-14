import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const PLUGIN_NAME = 'lumen-hooks';
const LEGACY_PLUGIN_NAME = 'decipher-hooks';

export function localPluginDir(): string {
  return path.join(os.homedir(), '.cursor', 'plugins', 'local', PLUGIN_NAME);
}

export function legacyPluginDir(): string {
  return path.join(os.homedir(), '.cursor', 'plugins', 'local', LEGACY_PLUGIN_NAME);
}

/** True when the Lumen hooks plugin is installed locally or hook events have ever been written. */
export function hooksInstalled(eventsDir: string, legacyEventsDir?: string): boolean {
  if (fs.existsSync(path.join(localPluginDir(), '.cursor-plugin', 'plugin.json'))) return true;
  if (fs.existsSync(path.join(legacyPluginDir(), '.cursor-plugin', 'plugin.json'))) return true;
  return dirHasEvents(eventsDir) || (legacyEventsDir ? dirHasEvents(legacyEventsDir) : false);
}

function dirHasEvents(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

/**
 * Copy the bundled plugin (extension/dist/plugin, mirrored from /plugin at build time) into
 * `~/.cursor/plugins/local/lumen-hooks`. Cursor loads local plugins after a window reload.
 */
export function installHooks(bundledPluginDir: string): { target: string; installed: boolean; reason?: string } {
  const target = localPluginDir();
  if (!fs.existsSync(path.join(bundledPluginDir, '.cursor-plugin', 'plugin.json'))) {
    return { target, installed: false, reason: `Bundled plugin not found at ${bundledPluginDir}` };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(bundledPluginDir, target, { recursive: true });
  const script = path.join(target, 'hooks', 'capture-event.mjs');
  try {
    fs.chmodSync(script, 0o755);
  } catch {
    /* Windows */
  }
  return { target, installed: true };
}
