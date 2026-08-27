#!/usr/bin/env node
/**
 * Remove every local trace of a previous login.
 *
 * The repository itself never stores session state - the WhatsApp Web login
 * (cookies, localStorage, IndexedDB, service workers, crypto keys) lives in
 * the persistent partition of the Electron user data directory:
 *
 *   ~/.config/whatsapp-desktop/Partitions/whatsapp
 *
 * together with the app's own files (settings.json, window-state.json, logs/,
 * icons/, notifications.jsonl) and Chromium's caches. This script deletes that
 * directory so the next start behaves like a fresh install: new QR code,
 * default settings, empty logs. Nothing is sent anywhere; deletion is local
 * and permanent.
 *
 * Usage:
 *   npm run reset                     interactive: shows what it found, asks y/N
 *   npm run reset -- --yes            no prompt (scripts, CI)
 *   npm run reset -- --session-only   log out but keep settings, window state, logs
 *   node scripts/reset-profile.mjs --path DIR   custom profile location
 *                                             (e.g. a smoke-test --user-data-dir)
 */

import { existsSync, lstatSync, readlinkSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const pathFlagAt = argv.indexOf('--path');
const yes = flags.has('--yes');
const sessionOnly = flags.has('--session-only');
const help = flags.has('--help') || flags.has('-h');

if (help) {
  console.log(
    [
      'reset-profile - wipe the local WhatsApp Desktop profile',
      '',
      '  --yes            do not ask for confirmation',
      '  --session-only   keep settings.json, window-state.json and logs/',
      '  --path DIR       profile directory (default: $XDG_CONFIG_HOME/whatsapp-desktop)',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

/** Default profile dir: mirrors Electron's userData resolution on Linux. */
function defaultProfileDir() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'whatsapp-desktop');
}

const profileDir = path.resolve(pathFlagAt !== -1 && argv[pathFlagAt + 1] ? argv[pathFlagAt + 1] : defaultProfileDir());

/** Recursive directory size in bytes (0 for anything unreadable). */
function directorySize(entry) {
  const st = lstatSync(entry);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of readdirSync(entry)) total += directorySize(path.join(entry, name));
  return total;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Refuse to delete under a running instance: two processes deleting while
 * Chromium writes LevelDB files is how a "clean" profile ends up corrupted.
 * Electron leaves `SingletonLock`, a symlink whose target ends in `-<pid>`.
 */
function runningInstancePid() {
  const lock = path.join(profileDir, 'SingletonLock');
  let target = '';
  try {
    target = readlinkSync(lock); // Electron: symlink -> "<hostname>-<pid>"
  } catch {
    return null; // no lock (or not a symlink): nothing is running
  }
  const pid = Number.parseInt(target.split('-').pop() ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // signal 0 probes for existence only
    return pid;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user: still running.
    if (error?.code === 'EPERM') return pid;
    return null; // ESRCH & friends: the lock is stale
  }
}

const SESSION_DIRS = [
  'Partitions', // the WhatsApp Web login itself (persist:whatsapp)
  'CachedData',
  'Code Cache',
  'Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Crashpad', // crash dumps can capture page memory - not worth keeping
];

function fail(message) {
  console.error(`reset-profile: ${message}`);
  process.exit(1);
}

if (!existsSync(profileDir)) {
  console.log(`reset-profile: no profile at ${profileDir} - nothing to clear.`);
  process.exit(0);
}
if (!statSync(profileDir).isDirectory()) fail(`${profileDir} is not a directory.`);

const livePid = runningInstancePid();
if (livePid !== null) {
  fail(
    `the application appears to be running (pid ${livePid} holds the singleton lock). ` +
      'Quit it first, then run this again.',
  );
}

const targets = sessionOnly
  ? SESSION_DIRS.filter((name) => existsSync(path.join(profileDir, name))).map((name) => path.join(profileDir, name))
  : [profileDir];

const bytes = targets.reduce((sum, t) => sum + directorySize(t), 0);

console.log(`reset-profile: profile directory ${profileDir}`);
for (const target of targets) console.log(`  will delete ${target}`);
console.log(`  (${human(bytes)}, ${sessionOnly ? 'session data only' : 'the entire profile'})`);

if (!yes) {
  if (!process.stdin.isTTY) fail('refusing to delete without a terminal; pass --yes to skip the prompt.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Delete? This cannot be undone. [y/N] ')).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') {
    console.log('reset-profile: cancelled, nothing was deleted.');
    process.exit(0);
  }
}

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
  console.log(`  deleted ${target}`);
}

console.log(
  sessionOnly
    ? 'reset-profile: session wiped. The next start shows the QR code again; settings were kept.'
    : 'reset-profile: profile wiped. The next start is a fresh install.',
);
