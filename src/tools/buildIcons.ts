/**
 * Icon generation tool, shared with the runtime renderer.
 *
 * Run by `scripts/build-icons.mjs` before packaging, and safe to run repeatedly:
 * the drawing code is deterministic, so an unchanged tree produces byte
 * identical PNGs.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { renderIcon } from '../main/icons/IconRenderer.js';

const SIZES: readonly number[] = [16, 22, 24, 32, 48, 64, 128, 256, 512];

export async function generateIcons(buildDir: string): Promise<readonly string[]> {
  const iconsDir = path.join(buildDir, 'icons');
  await mkdir(iconsDir, { recursive: true });
  const written: string[] = [];

  for (const size of SIZES) {
    const { png } = renderIcon({ size });
    const flat = path.join(iconsDir, `${size}x${size}.png`);
    await writeFile(flat, png);
    written.push(path.relative(process.cwd(), flat));
    // A couple of "tray" variants, so the packaged app does not have to draw
    // them at runtime if the theme needs a light mark.
    if (size === 22 || size === 24) {
      const light = path.join(iconsDir, `symbolic-${size}x${size}.png`);
      await writeFile(light, renderIcon({ size, style: 'symbolic' }).png);
      written.push(path.relative(process.cwd(), light));
    }
  }

  // electron-builder looks for `build/icon.png` for the Linux target.
  const single = path.join(buildDir, 'icon.png');
  await writeFile(single, renderIcon({ size: 512 }).png);
  written.push(path.relative(process.cwd(), single));

  return written;
}

if (process.argv[1] && process.argv[1].endsWith('buildIcons.cjs')) {
  generateIcons(path.resolve(process.cwd(), 'build'))
    .then((files) => {
      process.stdout.write(`generated ${files.length} icon files\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`icon generation failed: ${String(error)}\n`);
      process.exitCode = 1;
    });
}
