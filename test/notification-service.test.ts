import { describe, expect, it } from 'vitest';

import type { AppNotification } from '../src/shared/types.js';
import { Logger, MemoryLogWriter } from '../src/main/lib/logger.js';
import { MockNotificationBackend } from '../src/main/notifications/backends/MockNotificationBackend.js';
import { NotificationBackendBase } from '../src/main/notifications/backends/INotificationBackend.js';
import { NotificationService } from '../src/main/notifications/NotificationService.js';

const logger = new Logger({ level: 'silly', writer: new MemoryLogWriter(), console: false });

const notification = (overrides: Partial<AppNotification> = {}): AppNotification => ({
  id: 'wa:group1',
  title: 'Alice',
  body: 'hello',
  iconPath: null,
  silent: false,
  urgency: 'normal',
  expireTimeoutMs: 0,
  category: 'im.received',
  actions: [],
  payload: { chatId: 'chat:a', chatName: 'Alice', groupKey: 'g', activation: 'click' },
  count: 1,
  ...overrides,
});

/** A backend that is present but refuses everything. */
class BrokenBackend extends NotificationBackendBase {
  constructor() {
    super('broken');
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
  protected async probe() {
    return {
      available: true,
      clickEvents: false,
      actions: false,
      inPlaceGrouping: false,
      silent: false,
      urgency: false,
      reason: null,
    };
  }
  async show(): Promise<never> {
    throw new Error('daemon exploded');
  }
  async close(): Promise<void> {
    /* nothing */
  }
  async closeAll(): Promise<void> {
    /* nothing */
  }
}

/** A backend that is not there at all. */
class AbsentBackend extends NotificationBackendBase {
  constructor() {
    super('absent');
  }
  async isAvailable(): Promise<boolean> {
    return false;
  }
  protected async probe() {
    return {
      available: false,
      clickEvents: false,
      actions: false,
      inPlaceGrouping: false,
      silent: false,
      urgency: false,
      reason: 'no session bus',
    };
  }
  async show(): Promise<never> {
    throw new Error('must not be called');
  }
  async close(): Promise<void> {
    /* nothing */
  }
  async closeAll(): Promise<void> {
    /* nothing */
  }
}

describe('NotificationService', () => {
  it('picks the first available backend', async () => {
    const good = new MockNotificationBackend({ name: 'first' });
    const service = new NotificationService({ logger, backends: [new AbsentBackend(), good] });
    await service.initialize();
    expect(service.activeName).toBe('first');
    await service.dispose();
  });

  it('reports capabilities of every backend for the diagnostics view', async () => {
    const mock = new MockNotificationBackend();
    const service = new NotificationService({ logger, backends: [new AbsentBackend(), mock] });
    await service.initialize();
    const described = await service.describe();
    expect(described.map((entry) => [entry.name, entry.available])).toEqual([
      ['absent', false],
      ['mock', true],
    ]);
    expect(described[0]?.reason).toBe('no session bus');
    await service.dispose();
  });

  it('falls back when the active backend throws', async () => {
    const broken = new BrokenBackend();
    const mock = new MockNotificationBackend();
    const service = new NotificationService({ logger, backends: [broken, mock] });
    await service.initialize();
    expect(service.activeName).toBe('broken');

    const result = await service.show(notification());
    expect(result.ok).toBe(true);
    expect(result.backend).toBe('mock');
    expect(mock.deliveries).toHaveLength(1);
    await service.dispose();
  });

  it('disables a backend after repeated failures and re-selects', async () => {
    const broken = new BrokenBackend();
    const mock = new MockNotificationBackend();
    const service = new NotificationService({ logger, backends: [broken, mock] });
    await service.initialize();
    for (let index = 0; index < 3; index += 1) await service.show(notification({ id: `wa:g${index}` }));
    expect(service.activeName).toBe('mock');
    await service.dispose();
  });

  it('reports failure instead of throwing when nothing can deliver', async () => {
    const service = new NotificationService({ logger, backends: [new AbsentBackend()] });
    await service.initialize();
    const result = await service.show(notification());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no notification backend');
    await service.dispose();
  });

  it('honours an explicit preference', async () => {
    const first = new MockNotificationBackend({ name: 'dbus-like' });
    const second = new MockNotificationBackend({ name: 'electron-like' });
    const service = new NotificationService({ logger, backends: [first, second] });
    await service.initialize();
    expect(service.activeName).toBe('dbus-like');
    expect(await service.setPreference('electron-like')).toBe('electron-like');
    await service.dispose();
  });

  it('routes clicks back with our own id, which is how a notification opens a chat', async () => {
    const mock = new MockNotificationBackend();
    const service = new NotificationService({ logger, backends: [mock] });
    await service.initialize();
    const clicks: string[] = [];
    service.on('click', (event) => clicks.push(`${event.id}:${event.actionId}`));

    await service.show(notification({ id: 'wa:alice' }));
    mock.simulateClick('wa:alice', 'default');
    expect(clicks).toEqual(['wa:alice:default']);
    await service.dispose();
  });

  it('closes across all backends without complaining', async () => {
    const mock = new MockNotificationBackend();
    const service = new NotificationService({ logger, backends: [new AbsentBackend(), mock] });
    await service.initialize();
    await service.show(notification());
    expect(mock.open.size).toBe(1);
    await service.close('wa:group1');
    expect(mock.open.size).toBe(0);
    await service.close('unknown-id');
    await service.dispose();
  });
});
