import * as esbuild from 'esbuild';
import { chmod, cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

if (production) await rm('dist', { recursive: true, force: true }); // drop stale dev source maps
await mkdir('dist', { recursive: true });

/** Bundle the companion Cursor plugin so the extension can install it with one click. */
async function copyPlugin() {
  await cp('../plugin', 'dist/plugin', { recursive: true, force: true });
  await chmod('dist/plugin/hooks/capture-event.mjs', 0o755);
}
await copyPlugin();

/** Extension host bundle (Node / CommonJS, `vscode` stays external). */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** Webview bundle (browser, React). */
const webviewConfig = {
  entryPoints: { webview: 'src/webview/index.tsx' },
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  outdir: 'dist',
  sourcemap: !production,
  minify: production,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  logLevel: 'info',
};

if (watch) {
  const [a, b] = await Promise.all([esbuild.context(extensionConfig), esbuild.context(webviewConfig)]);
  await Promise.all([a.watch(), b.watch()]);
  console.log('[decipher] watching…');
} else {
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
}
