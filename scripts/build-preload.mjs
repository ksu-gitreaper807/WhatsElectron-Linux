#!/usr/bin/env node
/**
 * esbuild step for the two preloads and the settings renderer.
 *
 * Why a separate bundler when `tsc` already runs:
 *  - the main process uses Node's *native* ESM loader, which type checks and
 *    emits one file per module. That is the most debuggable option there.
 *  - the preloads and the settings renderer must be a *single file each* (no
 *    import graph inside the renderer), need CommonJS/IIFE formats that tsc
 *    cannot emit, and must resolve `../shared/*` relative imports - which is
 *    exactly what a bundler is for.
 *
 * `electron` stays external: a sandboxed preload resolves it from the runtime,
 * and bundling it would be both wrong and huge.
 */

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const out = path.join(root, 'out');
const isProduction = process.argv.includes('--production');

/** @param {string} file */
async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    label: 'preload:whatsapp',
    entryPoints: [path.join(root, 'src/preload/whatsapp.ts')],
    outfile: path.join(out, 'preload/whatsapp.cjs'),
    format: 'cjs',
    platform: 'browser',
    target: ['chrome120'],
    external: ['electron'],
  },
  {
    label: 'preload:settings',
    entryPoints: [path.join(root, 'src/preload/settings.ts')],
    outfile: path.join(out, 'preload/settings.cjs'),
    format: 'cjs',
    platform: 'browser',
    target: ['chrome120'],
    external: ['electron'],
  },
  {
    label: 'renderer:settings',
    entryPoints: [path.join(root, 'src/renderer/settings/main.ts')],
    outfile: path.join(out, 'renderer/settings/settings.js'),
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    external: [],
  },
];

await mkdir(path.join(out, 'renderer/settings'), { recursive: true });

const started = Date.now();
const results = await Promise.all(
  targets.map(async (target) => {
    const { label, ...options } = target;
    const result = await build({
      ...options,
      bundle: true,
      sourcemap: isProduction ? false : 'linked',
      minify: isProduction,
      legalComments: 'none',
      charset: 'utf8',
      treeShaking: true,
      logLevel: 'warning',
      metafile: true,
      define: {
        'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development'),
      },
    });
    const bytes = result.metafile ? Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0) : 0;
    return { label, bytes };
  }),
);

// Static assets for the settings window.
for (const file of ['index.html', 'settings.css']) {
  const from = path.join(root, 'src/renderer/settings', file);
  if (await exists(from)) await cp(from, path.join(out, 'renderer/settings', file));
}

// A stray `settings.js.map` from an earlier production-ish build would break the
// CSP (it is fine, but confusing); drop maps we did not ask for.
if (isProduction) {
  for (const dir of ['preload', 'renderer/settings']) {
    const base = path.join(out, dir);
    for (const file of ['whatsapp.cjs.map', 'settings.cjs.map', 'settings.js.map']) {
      const target = path.join(base, file);
      if (await exists(target)) await rm(target);
    }
  }
}

const total = results.reduce((sum, entry) => sum + entry.bytes, 0);
process.stdout.write(
  `esbuild: ${results.map((r) => `${r.label} ${(r.bytes / 1024).toFixed(1)}kB`).join(', ')} (${(total / 1024).toFixed(1)}kB total, ${Date.now() - started}ms)\n`,
);
