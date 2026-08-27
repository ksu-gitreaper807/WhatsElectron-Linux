/**
 * A wiring harness that builds the *real* object graph - settings service, DND
 * service, unread manager, notification service with the mock backend, and the
 * notification manager - with no Electron and no sleeping.
 *
 * This is possible because none of those modules import Electron, and it is the
 * reason the notification behaviour can be tested at all: the tests exercise the
 * same classes the application runs, not a re-implementation of them.
 */

import { DEFAULT_SETTINGS } from '../../src/shared/settings.js';
import type { AppSettings, DetectedMessage } from '../../src/shared/types.js';
import { DNDService } from '../../src/main/dnd/DNDService.js';
import { Logger, type LogRecord } from '../../src/main/lib/logger.js';
import { MemoryLogWriter } from '../../src/main/lib/logger.js';
import { MockNotificationBackend } from '../../src/main/notifications/backends/MockNotificationBackend.js';
import { NotificationManager } from '../../src/main/notifications/NotificationManager.js';
import { NotificationService } from '../../src/main/notifications/NotificationService.js';
import { MemorySettingsStore, type SettingsStore } from '../../src/main/settings/SettingsStore.js';
import { SettingsService } from '../../src/main/settings/SettingsService.js';
import { UnreadManager } from '../../src/main/unread/UnreadManager.js';
import { FakeClock } from './fakeTimers.js';

export interface HarnessOptions {
  readonly settings?: Partial<AppSettings>;
  readonly store?: SettingsStore;
  readonly focused?: boolean;
}

export interface Harness {
  readonly clock: FakeClock;
  readonly settings: SettingsService;
  readonly dnd: DNDService;
  readonly unread: UnreadManager;
  readonly service: NotificationService;
  readonly backend: MockNotificationBackend;
  readonly manager: NotificationManager;
  readonly logs: LogRecord[];
  readonly deliveryLog: string[];
  push(message: Partial<DetectedMessage>): NotificationManager;
  setFocused(value: boolean): void;
  dispose(): Promise<void>;
}

let sequence = 0;

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = new FakeClock();
  const writer = new MemoryLogWriter();
  const root = new Logger({ level: 'silly', writer, console: false, clock: () => new Date(clock.now) });
  const settings = new SettingsService({
    store: options.store ?? new MemorySettingsStore(),
    logger: root.child('settings'),
    overrides: { groupingIntervalMs: 500, expireAfterMs: 5_000, focusQuietMs: 0, ...options.settings },
  });
  await settings.load();

  const unread = new UnreadManager({ clock: () => clock.now });
  const dnd = new DNDService({ settings, logger: root.child('dnd'), clock: () => clock.now });
  const backend = new MockNotificationBackend();
  const service = new NotificationService({ logger: root.child('service'), backends: [backend] });
  await service.initialize();

  let focused = options.focused ?? false;
  const deliveryLog: string[] = [];
  const manager = new NotificationManager({
    service,
    dnd,
    unread,
    settings,
    logger: root.child('notifications'),
    timers: clock,
    clock: () => clock.now,
    isWindowActive: () => focused,
  });
  manager.start();
  manager.on('delivered', ({ notification }) => {
    deliveryLog.push(`${notification.title}|${notification.body}|${notification.count}`);
  });

  return {
    clock,
    settings,
    dnd,
    unread,
    service,
    backend,
    manager,
    logs: writer.records,
    deliveryLog,
    setFocused(value: boolean): void {
      focused = value;
    },
    push(message: Partial<DetectedMessage>): NotificationManager {
      // Unique id and a strictly increasing timestamp: the manager dedupes on
      // identity, so two pushes in the same fake tick must still look like two
      // messages to it (which is what happens on a real page).
      sequence += 1;
      const base: DetectedMessage = {
        id: `m${sequence}`,
        chatId: 'chat:alice',
        chatName: 'Alice',
        senderName: null,
        isGroup: false,
        body: `hello ${sequence}`,
        hasMedia: false,
        timestamp: clock.now + sequence,
        source: 'dom-notification',
        titleUnreadCount: null,
        ...message,
      };
      manager.ingest(base);
      return manager;
    },
    async dispose(): Promise<void> {
      await manager.dispose();
      await service.dispose();
    },
  };
}

export { DEFAULT_SETTINGS };
