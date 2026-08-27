import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NullAutostartBackend,
  XdgAutostartBackend,
  isHiddenDesktopEntry,
  parseDesktopEntry,
  quote,
} from '../src/main/autostart/AutostartBackends.js';
import { AutostartService } from '../src/main/autostart/AutostartService.js';
import { Logger, MemoryLogWriter } from '../src/main/lib/logger.js';

const logger = new Logger({ level: 'silly', writer: new MemoryLogWriter(), console: false });

function makeBackend(execPath = '/Applications/WhatsApp Desktop.AppImage', execArgs: readonly string[] = ['--hidden']) {
  return new XdgAutostartBackend({ logger, execPath, execArgs, appId: 'com.example.test' });
}

describe('desktop entry quoting and parsing', () => {
  it('quotes and escapes what an Exec line cares about', () => {
    expect(quote('/home/me/My App/appimage')).toBe('"/home/me/My App/appimage"');
    expect(quote('/tmp/a"b')).toBe('"/tmp/a\\"b"');
    expect(quote('/tmp/$HOME')).toBe('"/tmp/\\$HOME"');
    expect(quote('plain')).toBe('"plain"');
  });

  it('parses key files back into fields', () => {
    const parsed = parseDesktopEntry('[Desktop Entry]\nType=Application\nName=X\nExec=y\n');
    expect(parsed['Type']).toBe('Application');
    expect(parsed['Name']).toBe('X');
    expect(parsed['Exec']).toBe('y');
  });

  it('recognises a hidden entry regardless of spacing or case', () => {
    expect(isHiddenDesktopEntry('Hidden=true')).toBe(true);
    expect(isHiddenDesktopEntry('  HIDDEN = TRUE ')).toBe(true);
    expect(isHiddenDesktopEntry('Hidden=false')).toBe(false);
  });
});

describe('XdgAutostartBackend', () => {
  let dir: string;
  let previousConfigHome: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wa-autostart-'));
    previousConfigHome = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = dir;
  });

  afterEach(async () => {
    process.env['XDG_CONFIG_HOME'] = previousConfigHome;
    await rm(dir, { recursive: true, force: true });
  });

  it('reports "disabled" when no entry exists', async () => {
    const backend = makeBackend();
    expect(await backend.read()).toEqual({ enabled: false, reason: null });
  });

  it('writes a complete desktop entry into the autostart directory', async () => {
    const backend = makeBackend();
    await backend.write(true);
    const content = await readFile(backend.filePath, 'utf8');
    const fields = parseDesktopEntry(content);
    expect(content.startsWith('[Desktop Entry]\n')).toBe(true);
    expect(fields['Type']).toBe('Application');
    expect(fields['Exec']).toBe('"/Applications/WhatsApp Desktop.AppImage" "--hidden"');
    expect(fields['Terminal']).toBe('false');
    expect(fields['StartupWMClass']).toBe('whatsapp-desktop');
    // The file is named after the app id, the Icon after the *desktop entry*, so
    // notifications and the badge resolve to the same installed .desktop file.
    expect(fields['Icon']).toBe('whatsapp-desktop');
    expect(backend.filePath).toContain('com.example.test.desktop');
    expect(backend.location()).toBe(join(dir, 'autostart', 'com.example.test.desktop'));
  });

  it('round trips: read() agrees with what write() produced', async () => {
    const backend = makeBackend();
    await backend.write(true);
    const read = await backend.read();
    expect(read.enabled).toBe(true);
    expect(read.reason).toBeNull();
  });

  it('disabling removes the file', async () => {
    const backend = makeBackend();
    await backend.write(true);
    await backend.write(false);
    expect((await backend.read()).enabled).toBe(false);
    await expect(readFile(backend.filePath, 'utf8')).rejects.toThrow();
  });

  it('respects a Hidden=true entry written by a tool the user used', async () => {
    const backend = makeBackend();
    await backend.write(true);
    const content = await readFile(backend.filePath, 'utf8');
    await writeFile(backend.filePath, `${content}Hidden=true\n`, 'utf8');
    const read = await backend.read();
    expect(read.enabled).toBe(false);
    expect(read.reason).toContain('Hidden');
  });

  it('flags a stale Exec path (moved AppImage) as enabled-with-a-reason', async () => {
    const old = makeBackend('/old/path/AppImage');
    await old.write(true);
    const moved = makeBackend('/new/path/AppImage');
    const read = await moved.read();
    expect(read.enabled).toBe(true);
    expect(read.reason).toContain('Exec path');
  });

  it('refuses to write on a platform without autostart', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const backend = makeBackend();
      expect(backend.isSupported()).toBe(false);
      await expect(backend.write(true)).rejects.toThrow(/only implemented for Linux/);
      expect(await backend.read()).toEqual({ enabled: false, reason: 'not a Linux desktop' });
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});

describe('AutostartService', () => {
  it('keeps the preference but says the platform cannot honour it', async () => {
    const service = new AutostartService({ logger, backend: new NullAutostartBackend() });
    const notes = await service.sync(true);
    expect(notes.join(' ')).toContain('not available on this platform');
    const status = await service.status();
    expect(status.supported).toBe(false);
  });

  it('reports a write failure as a note instead of throwing', async () => {
    const failing = new NullAutostartBackend();
    // make it "supported" so the write path runs and throws
    vi.spyOn(failing, 'isSupported').mockReturnValue(true);
    const service = new AutostartService({ logger, backend: failing });
    const notes = await service.sync(true);
    expect(notes.join(' ')).toContain('could not be changed');
  });

  it('repairs an entry whose Exec went stale, and mentions it', async () => {
    const dirPath = await mkdtemp(join(tmpdir(), 'wa-autostart-svc-'));
    const previous = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = dirPath;
    try {
      const old = makeBackend('/old/AppImage');
      await old.write(true);
      const service = new AutostartService({ logger, backend: makeBackend('/new/AppImage') });
      const notes = await service.sync(true);
      expect(notes.join(' ')).toContain('repaired');
      const content = await readFile(makeBackend('/new/AppImage').filePath, 'utf8');
      expect(content).toContain('/new/AppImage');
    } finally {
      process.env['XDG_CONFIG_HOME'] = previous;
      await rm(dirPath, { recursive: true, force: true });
    }
  });
});
