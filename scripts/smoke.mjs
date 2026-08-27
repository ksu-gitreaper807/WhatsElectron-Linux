#!/usr/bin/env node
/**
 * Headless end-to-end smoke test.
 *
 * Runs the *real* application against a real (if minimal) desktop stack:
 *
 *   Xvfb            -> an X server, so GTK, the tray and the window exist
 *   dbus-run-session-> a private session bus, so nothing of the user's leaks in
 *   dunst           -> a real org.freedesktop.Notifications server
 *   fake-sni-watcher-> a StatusNotifierWatcher, so `new Tray()` has a host
 *
 * The assertions themselves live in the application (`--smoke`,
 * src/main/lifecycle/SmokeHarness.ts) and are reported as structured log lines,
 * which this script reads from the profile directory. That split is deliberate:
 * the harness can use the real objects (no re-implementation to drift), and the
 * runner only has to own a process tree.
 *
 * Usage:
 *   npm run smoke
 *   npm run smoke -- --keep              # keep the temp profile for inspection
 *   SMOKE_VERBOSE=1 npm run smoke        # stream the app's stderr
 *   DISPLAY=:0 DBUS_SESSION_BUS_ADDRESS=... npm run smoke   # use the real session
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const argv = process.argv.slice(2);
const keepProfile = argv.includes('--keep');
const verbose = process.env.SMOKE_VERBOSE === '1' || argv.includes('--verbose');
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 240_000);
const requireTray = !argv.includes('--allow-no-tray');

const find = (name) => {
  if (path.isAbsolute(name)) return existsSync(name) ? name : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

const hasDisplay = Boolean(process.env.DISPLAY);
const hasSessionBus = Boolean(process.env.DBUS_SESSION_BUS_ADDRESS);
const XVFB_RUN = hasDisplay ? null : find('xvfb-run');
const DBUS_RUN = hasSessionBus ? null : find('dbus-run-session');
const DUNST = find('dunst');
const NOTIFICATION_DAEMON = find('notification-daemon');
const ELECTRON = path.join(root, 'node_modules', '.bin', 'electron');
const ENTRY = path.join(root, 'out', 'main', 'main.js');
const WATCHER = path.join(here, 'fake-sni-watcher.mjs');

const missing = [];
if (!existsSync(ELECTRON)) missing.push('node_modules/.bin/electron (run `npm install`)');
if (!existsSync(ENTRY)) missing.push('out/main/main.js (run `npm run build`)');
if (!hasDisplay && XVFB_RUN === null) missing.push('xvfb-run (apt install xvfb) or set DISPLAY');
if (!hasSessionBus && DBUS_RUN === null)
  missing.push('dbus-run-session (apt install dbus-x11) or set DBUS_SESSION_BUS_ADDRESS');
if (missing.length > 0) {
  console.error('smoke: cannot run, missing:');
  for (const item of missing) console.error(`  - ${item}`);
  process.exit(2);
}

const profile = mkdtempSync(path.join(tmpdir(), 'wa-desktop-smoke-'));
const logs = path.join(profile, 'logs');
mkdirSync(logs, { recursive: true });
const logFile = path.join(logs, 'main.jsonl');
const stderrFile = path.join(profile, 'electron.stderr.log');
const dumpFile = path.join(profile, 'notifications.jsonl');

const appArgs = [
  `"${ENTRY}"`,
  '--dev',
  '--smoke',
  `--user-data-dir="${profile}"`,
  // Containers without user namespaces cannot start Chromium's setuid sandbox.
  // The application logs a loud warning when it sees this flag, which is exactly
  // right: it is a test concession, not a deployment option.
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
].filter(Boolean);

const daemon = DUNST ?? NOTIFICATION_DAEMON;
const body = [
  daemon === null ? null : `"${daemon}" -config /dev/null >/dev/null 2>&1 &`,
  `node "${WATCHER}" >/dev/null 2>&1 &`,
  // The watcher and the notification daemon must own their bus names before the
  // application probes for them, or the tray check would race with startup.
  'sleep 1.5',
  `exec "${ELECTRON}" ${appArgs.join(' ')}`,
]
  .filter(Boolean)
  .join('\n');

// Write the script to the profile directory instead of quoting it through two
// wrappers: a heredoc inside `dbus-run-session -- bash -c '...'` inside
// `xvfb-run` is unreadable when it fails.
const scriptPath = path.join(profile, 'smoke-run.sh');
writeFileSync(scriptPath, `#!/bin/sh\nset -e\n${body}\n`, { mode: 0o700 });

// Innermost first, then wrapped outwards.
const chain = [['bash', [scriptPath]]];
if (DBUS_RUN !== null) chain.unshift([DBUS_RUN, ['--']]);
if (XVFB_RUN !== null) chain.unshift([XVFB_RUN, ['-a', '--auto-servernum']]);
const command = chain[0][0];
const args = chain.flatMap(([file, fileArgs], index) => (index === 0 ? fileArgs : [file, ...fileArgs]));

console.log(
  `smoke: profile=${profile}`,
  `\n       display=${hasDisplay ? process.env.DISPLAY : 'Xvfb'}, bus=${hasSessionBus ? 'inherited' : 'private'},` +
    ` daemon=${daemon ? path.basename(daemon) : 'none'}, watcher=${requireTray ? 'fake-sni' : 'skipped'}`,
);

const child = spawn(command, args, {
  cwd: root,
  env: {
    ...process.env,
    // Make the tray requirement visible to the harness; everything else about
    // the environment is the harness's business.
    WA_SMOKE_REQUIRE_TRAY: requireTray ? '1' : '0',
    ...(daemon === null ? {} : { WA_SMOKE_NOTIFICATION_DAEMON: path.basename(daemon) }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stdout.on('data', (chunk) => {
  if (verbose) process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
  if (verbose) process.stderr.write(chunk);
});

const readRecords = () => {
  let content = '';
  try {
    content = readFileSync(logFile, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const raw of content.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      /* partial line, will be complete on the next poll */
    }
  }
  return out;
};

const result = await new Promise((resolve) => {
  const started = Date.now();
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    clearTimeout(killer);
    resolve(value);
  };
  const readAndFinish = () => {
    const records = readRecords();
    const summary = records.find((record) => typeof record.msg === 'string' && record.msg.startsWith('smoke: summary'));
    if (!summary) return finish({ ok: false, records, summary: null, noSummary: true });
    const failed = Array.isArray(summary.data?.failed) ? summary.data.failed : [];
    return finish({ ok: failed.length === 0, records, summary, failed });
  };

  child.on('exit', () => {
    // The harness quits the application itself. The log transport flushes before
    // exit, but give the filesystem a beat: poll for the summary for 5 s, then
    // call it a failure. A process that dies before writing a summary is a hard
    // failure either way, and its exit code is reported.
    const deadline = Date.now() + 5_000;
    const poll = () => {
      const records = readRecords();
      const summary = records.find(
        (record) => typeof record.msg === 'string' && record.msg.startsWith('smoke: summary'),
      );
      if (summary) {
        const failed = Array.isArray(summary.data?.failed) ? summary.data.failed : [];
        finish({ ok: failed.length === 0, records, summary, failed });
        return;
      }
      if (Date.now() > deadline) return readAndFinish();
      setTimeout(poll, 250);
    };
    poll();
  });

  const timer = setInterval(() => {
    const records = readRecords();
    const summary = records.find((record) => typeof record.msg === 'string' && record.msg.startsWith('smoke: summary'));
    if (summary) {
      const failed = Array.isArray(summary.data?.failed) ? summary.data.failed : [];
      finish({ ok: failed.length === 0, records, summary, failed });
      return;
    }
    if (Date.now() - started > timeoutMs) {
      finish({ ok: false, records, summary: null, timedOut: true });
    }
  }, 500);
  const killer = setTimeout(
    () => finish({ ok: false, records: readRecords(), summary: null, timedOut: true }),
    timeoutMs,
  );
});

// Teardown: TERM, wait, KILL. The app tears itself down (unregistering the global
// shortcut); this only covers the case where it never got that far.
if (child.exitCode === null) child.kill('SIGTERM');
await new Promise((resolve) => setTimeout(resolve, 1_500));
if (child.exitCode === null) child.kill('SIGKILL');

const records = result.records ?? [];
const smoke = records.filter((record) => typeof record.msg === 'string' && record.msg.startsWith('smoke:'));
const passed = smoke.filter((record) => record.msg.startsWith('smoke: pass'));
const failed = smoke.filter((record) => record.msg.startsWith('smoke: FAIL'));
const info = smoke.filter((record) => !/smoke: (pass|FAIL)/.test(record.msg));

console.log(`smoke: ${smoke.length} harness lines, ${passed.length} passed, ${failed.length} failed`);
for (const record of info) {
  const detail = record.data === undefined ? '' : ` ${JSON.stringify(record.data)}`;
  console.log(`  ·  ${record.msg.replace('smoke: ', '')}${detail}`);
}
for (const record of passed) console.log(`  ok   ${record.msg.slice('smoke: pass '.length)}`);
for (const record of failed) console.log(`  FAIL ${record.msg.slice('smoke: FAIL '.length)}`);

const errors = records.filter((record) => record.level === 'error' && !record.msg.startsWith('smoke: FAIL'));
if (errors.length > 0) {
  console.log(`smoke: ${errors.length} error line(s) in the log`);
  for (const record of errors.slice(0, 15)) {
    console.log(`  !  [${record.scope}] ${record.msg} ${record.data ? JSON.stringify(record.data) : ''}`);
  }
}

if (existsSync(dumpFile)) {
  const dumped = readFileSync(dumpFile, 'utf8').split('\n').filter(Boolean).length;
  console.log(`smoke: notification dump contains ${dumped} line(s) at ${path.relative(root, dumpFile) || dumpFile}`);
}

const ok = result.ok === true && failed.length === 0 && passed.length >= 12;
if (!ok) {
  writeFileSync(path.join(profile, 'smoke-stderr.log'), stderr, 'utf8');
  const why = result.timedOut
    ? ' (timed out)'
    : result.noSummary
      ? ` (no summary written; child exit code ${child.exitCode ?? 'unknown'})`
      : '';
  console.error(`smoke: FAILED${why}`);
  if (!verbose && stderr.length > 0) console.error(`--- stderr tail ---\n${stderr.slice(-2_500)}`);
  console.error(`smoke: artifacts kept in ${profile}`);
  process.exit(1);
}

console.log('smoke: PASSED');
if (!keepProfile) rmSync(profile, { recursive: true, force: true });
else console.log(`smoke: profile kept at ${profile}`);
process.exit(0);
