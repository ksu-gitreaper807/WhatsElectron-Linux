import { describe, expect, it } from 'vitest';

import { DNDService, NullDndSource, type DndSource } from '../src/main/dnd/DNDService.js';
import { Logger, MemoryLogWriter } from '../src/main/lib/logger.js';
import { MemorySettingsStore } from '../src/main/settings/SettingsStore.js';
import { SettingsService } from '../src/main/settings/SettingsService.js';
import { FakeClock } from './helpers/fakeTimers.js';

class FakeSource implements DndSource {
  readonly name = 'fake';
  readonly canWrite = false;
  value: boolean | null = false;
  listener: ((enabled: boolean) => void) | null = null;
  disposed = false;

  async read(): Promise<boolean | null> {
    return this.value;
  }
  subscribe(onChange: (enabled: boolean) => void): () => void {
    this.listener = onChange;
    return () => {
      this.listener = null;
    };
  }
  dispose(): void {
    this.disposed = true;
  }
}

async function make(options: { syncSystemDnd?: boolean; dndEnabled?: boolean } = {}) {
  const clock = new FakeClock();
  const logger = new Logger({ level: 'silly', writer: new MemoryLogWriter(), console: false });
  const settings = new SettingsService({
    store: new MemorySettingsStore(),
    logger,
    overrides: {
      syncSystemDnd: options.syncSystemDnd ?? false,
      dndEnabled: options.dndEnabled ?? false,
    },
  });
  await settings.load();
  const source = new FakeSource();
  const dnd = new DNDService({ settings, logger, source, clock: () => clock.now });
  // start() subscribes to the system source and pulls its current value.
  dnd.start();
  await dnd.refresh();
  return { dnd, settings, source, clock };
}

describe('DNDService', () => {
  it('is off by default and toggles through settings (so it persists)', async () => {
    const { dnd, settings } = await make();
    expect(dnd.isEnabled()).toBe(false);
    await dnd.enable();
    expect(dnd.isEnabled()).toBe(true);
    expect(settings.get('dndEnabled')).toBe(true);
    await dnd.disable();
    expect(dnd.isEnabled()).toBe(false);
    expect(settings.get('dndEnabled')).toBe(false);
  });

  it('toggle() goes both ways', async () => {
    const { dnd } = await make();
    expect((await dnd.toggle()).active).toBe(true);
    expect((await dnd.toggle()).active).toBe(false);
  });

  it('ignores the system state unless mirroring is enabled', async () => {
    const withMirror = await make({ syncSystemDnd: true });
    expect(withMirror.source.listener).not.toBeNull();
    withMirror.source.value = true;
    withMirror.source.listener?.(true);
    expect(withMirror.dnd.isEnabled()).toBe(true);
    expect(withMirror.dnd.state().reason).toBe('system');
    withMirror.source.listener?.(false);
    expect(withMirror.dnd.isEnabled()).toBe(false);

    const without = await make({ syncSystemDnd: false });
    without.source.value = true;
    without.source.listener?.(true);
    expect(without.dnd.isEnabled()).toBe(false);
  });

  it('treats an undetectable system state as "not on"', async () => {
    const { dnd, source } = await make({ syncSystemDnd: true });
    source.value = null;
    await dnd.refresh();
    expect(dnd.isEnabled()).toBe(false);
    expect(dnd.state().system).toBeNull();
  });

  it('snoozes for a bounded time and resumes on its own', async () => {
    const { dnd, clock } = await make();
    dnd.snooze(10);
    expect(dnd.isEnabled()).toBe(true);
    expect(dnd.state().reason).toBe('snooze');
    clock.advance(9 * 60_000);
    expect(dnd.isEnabled()).toBe(true);
    clock.advance(2 * 60_000);
    expect(dnd.isEnabled()).toBe(false);
  });

  it('clamps nonsense snooze values', async () => {
    const { dnd } = await make();
    expect(dnd.snooze(-5).active).toBe(true);
    dnd.clearSnooze();
    expect(dnd.snooze(Number.NaN).active).toBe(true);
    dnd.clearSnooze();
    expect(dnd.isEnabled()).toBe(false);
  });

  it('does not persist a snooze as the user switch', async () => {
    const { dnd, settings } = await make();
    dnd.snooze(30);
    expect(settings.get('dndEnabled')).toBe(false);
  });

  it('describes itself for the tray menu', async () => {
    const { dnd } = await make();
    expect(dnd.describe()).toBe('off');
    await dnd.enable();
    expect(dnd.describe()).toContain('you turned it on');
    await dnd.disable();
    dnd.snooze(5);
    expect(dnd.describe()).toContain('snoozed');
  });

  it('falls back to a null source and survives dispose', async () => {
    const { dnd, source } = await make();
    dnd.setSource(new NullDndSource());
    expect(dnd.isEnabled()).toBe(false);
    dnd.dispose();
    expect(source.disposed).toBe(true);
  });
});
