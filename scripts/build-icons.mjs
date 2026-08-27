#!/usr/bin/env node
/**
 * Generate `build/icons/*.png` (and `build/icon.png`) from the same renderer the
 * application uses at runtime.
 *
 * The icons are *generated* rather than committed for two reasons: the project
 * ships no third-party artwork (see "Brand assets" in the README), and the
 * renderer is deterministic, so a rebuild is reproducible and a reviewer can
 * read the picture by reading the code.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const bundle = path.join(root, 'out/tools/buildIcons.cjs');

await mkdir(path.dirname(bundle), { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/tools/buildIcons.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  logLevel: 'warning',
  external: ['electron'],
});

const { generateIcons } = await import(`file://${bundle}`);
const written = await generateIcons(path.join(root, 'build'));

await mkdir(path.join(root, 'build'), { recursive: true });
await writeFile(path.join(root, 'build', '.icons-stamp'), `${written.join('\n')}\n`, 'utf8').catch(() => undefined);

process.stdout.write(`icons: ${written.length} files under build/\n`);
