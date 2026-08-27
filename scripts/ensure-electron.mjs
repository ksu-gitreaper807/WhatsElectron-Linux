#!/usr/bin/env node
/**
 * Make sure the Electron binary actually exists.
 *
 * `npm install` runs electron's postinstall to download `dist/electron`. Several
 * environments skip install scripts by policy (`--ignore-scripts`, npm's
 * `allowScripts` gating, some corporate/CI images), and the result is a project
 * that "installs fine" and then fails with `ENOENT ... dist/electron` on first
 * launch. This script detects that and runs the download explicitly.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = path.join(root, 'node_modules', 'electron');
const marker = process.platform === 'win32' ? 'electron.exe' : 'electron';
const binary = path.join(pkg, 'dist', marker);

if (!existsSync(pkg)) {
  console.error(`ensure-electron: ${pkg} is missing - run \`npm install\` first.`);
  process.exit(1);
}
if (existsSync(binary)) {
  if (process.env.ENSURE_ELECTRON_VERBOSE === '1') console.log(`ensure-electron: ok (${binary})`);
  process.exit(0);
}

console.log('ensure-electron: Electron binary missing (install scripts were skipped); downloading...');
try {
  execFileSync(process.execPath, [path.join(pkg, 'install.js')], { cwd: pkg, stdio: 'inherit' });
} catch (error) {
  console.error(`ensure-electron: the download failed. Run it by hand and check network access:
  cd ${pkg} && node install.js`);
  process.exit(1);
}
if (!existsSync(binary)) {
  console.error(
    `ensure-electron: still missing ${binary} - report this, and check whether a proxy blocked the GitHub release download.`,
  );
  process.exit(1);
}
console.log('ensure-electron: done');
