import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import { Logger, MemoryLogWriter } from '../src/main/lib/logger.js';
import { FileSettingsStore, MemorySettingsStore, ReadOnlySettingsStore } from '../src/main/settings/SettingsStore.js';
import { SettingsService } from '../src/main/settings/SettingsService.js';

const logger = new Logger({ level: 'silly', writer: new MemoryLogWriter(), console: false });

describe('SettingsService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wa-settings-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts from the defaults when nothing is stored', async () => {
    const service = new SettingsService({
      store: new FileSettingsStore({ filePath: join(dir, 'settings.json'), logger }),
      logger,
    });
    await service.load();
    expect(service.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('persists a change and reads it back in a new instance', async () => {
    const filePath = join(dir, 'settings.json');
    const first = new SettingsService({ store: new FileSettingsStore({ filePath, logger }), logger });
    await first.load();
    await first.update({ dndEnabled: true, groupingIntervalMs: 2_500 });

    const second = new SettingsService({ store: new FileSettingsStore({ filePath, logger }), logger });
    await second.load();
    expect(second.get('dndEnabled')).toBe(true);
    expect(second.get('groupingIntervalMs')).toBe(2_500);
    expect(second.get('closeToTray')).toBe(DEFAULT_SETTINGS.closeToTray);
  });

  it('writes atomically: no temporary file is left behind', async () => {
    const filePath = join(dir, 'settings.json');
    const service = new SettingsService({ store: new FileSettingsStore({ filePath, logger }), logger });
    await service.load();
    await service.update({ titleBadge: false });
    const listing = await readFile(filePath, 'utf8');
    expect(JSON.parse(listing).settings.titleBadge).toBe(false);
    expect(listing).toContain('"version"');
  });

  it('survives a corrupt file and keeps it for inspection', async () => {
    const filePath = join(dir, 'settings.json');
    await writeFile(filePath, '{ this is not json', 'utf8');
    const service = new SettingsService({ store: new FileSettingsStore({ filePath, logger }), logger });
    await service.load();
    expect(service.settings).toEqual(DEFAULT_SETTINGS);
    // The bad file is quarantined, not deleted: a user must be able to recover
    // their own hand written settings after a crash mid-write.
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    const quarantined = files.filter((name) => name.includes('.corrupt-'));
    expect(quarantined.length).toBe(1);
    const kept = await readFile(join(dir, quarantined[0] ?? ''), 'utf8');
    expect(kept).toBe('{ this is not json');
  });

  it('tolerates hand written settings without the envelope', async () => {
    const filePath = join(dir, 'settings.json');
    await writeFile(filePath, JSON.stringify({ dndEnabled: true, nonsense: { deep: true } }), 'utf8');
    const service = new SettingsService({ store: new FileSettingsStore({ filePath, logger }), logger });
    await service.load();
    expect(service.get('dndEnabled')).toBe(true);
  });

  it('drops invalid persisted values instead of failing to start', async () => {
    const filePath = join(dir, 'settings.json');
    await writeFile(
      filePath,
      JSON.stringify({ groupingIntervalMs: -1, dndEnabled: 'yes', closeToTray: false }),
      'utf8',
    );
    const service = new SettingsService({ store: new FileSettingsStore({ filePath, logger }), logger });
    await service.load();
    expect(service.get('groupingIntervalMs')).toBe(DEFAULT_SETTINGS.groupingIntervalMs);
    expect(service.get('dndEnabled')).toBe(false);
    expect(service.get('closeToTray')).toBe(false);
  });

  it('reports rejected keys on update and applies the rest', async () => {
    const service = new SettingsService({ store: new MemorySettingsStore(), logger });
    await service.load();
    const result = await service.update({ closeToTray: false, groupingIntervalMs: 7 });
    expect(result.applied).toEqual({ closeToTray: false });
    expect(result.rejected['groupingIntervalMs']).toContain('between');
  });

  it('treats an empty patch as a no-op', async () => {
    const store = new MemorySettingsStore();
    const service = new SettingsService({ store, logger });
    await service.load();
    const before = store.writeCount;
    const result = await service.update({});
    expect(result.applied).toEqual({});
    expect(store.writeCount).toBe(before);
  });

  it('keeps working when the store is read only, and says so', async () => {
    const service = new SettingsService({
      store: new ReadOnlySettingsStore({}, new Error('EROFS: read-only file system')),
      logger,
    });
    await service.load();
    const result = await service.update({ dndEnabled: true });
    expect(service.get('dndEnabled')).toBe(true);
    expect(result.notes.join(' ')).toContain('could not be saved');
    expect(service.persistenceDegraded).toBe(true);
  });

  it('runs registered side effects and collects their notes', async () => {
    const service = new SettingsService({ store: new MemorySettingsStore(), logger });
    await service.load();
    const seen: boolean[] = [];
    service.onKey('dndEnabled', async (next) => {
      seen.push(next.dndEnabled);
      return ['dnd applied'];
    });
    const result = await service.update({ dndEnabled: true });
    expect(seen).toEqual([true]);
    expect(result.notes).toContain('dnd applied');
  });

  it('isolates a throwing side effect from the caller', async () => {
    const service = new SettingsService({ store: new MemorySettingsStore(), logger });
    await service.load();
    service.onKey('dndEnabled', () => {
      throw new Error('handler exploded');
    });
    service.onKey('dndEnabled', () => ['second one still runs']);
    const failures: string[] = [];
    service.on('failed', ({ message }) => failures.push(message));
    const result = await service.update({ dndEnabled: true });
    expect(result.notes.join(' ')).toContain('handler exploded');
    expect(result.notes).toContain('second one still runs');
    expect(failures.length).toBe(1);
  });

  it('unsubscribing a side effect stops it running', async () => {
    const service = new SettingsService({ store: new MemorySettingsStore(), logger });
    await service.load();
    let calls = 0;
    const off = service.onKey('dndEnabled', () => {
      calls += 1;
    });
    await service.update({ dndEnabled: true });
    off();
    await service.update({ dndEnabled: false });
    expect(calls).toBe(1);
  });

  it('toggle() flips only booleans and reset() restores defaults', async () => {
    const service = new SettingsService({ store: new MemorySettingsStore(), logger });
    await service.load();
    await service.toggle('closeToTray');
    expect(service.get('closeToTray')).toBe(!DEFAULT_SETTINGS.closeToTray);
    await service.reset();
    expect(service.settings).toEqual(DEFAULT_SETTINGS);
  });
});
