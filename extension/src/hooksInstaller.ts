import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PLUGIN_NAME = 'decipher-hooks';

export function localPluginDir(): string {
  return path.join(os.homedir(), '.cursor', 'plugins', 'local', PLUGIN_NAME);
}

/** True when the Decipher hooks plugin is installed locally or hook events have ever been written. */
export function hooksInstalled(eventsDir: string): boolean {
  if (fs.existsSync(path.join(localPluginDir(), '.cursor-plugin', 'plugin.json'))) return true;
  try {
    return fs.existsSync(eventsDir) && fs.readdirSync(eventsDir).some((f) => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

/**
 * Copy the bundled plugin (extension/dist/plugin, mirrored from /plugin at build time) into
 * `~/.cursor/plugins/local/decipher-hooks`. Cursor loads local plugins after a window reload.
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
