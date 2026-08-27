/**
 * In-memory backend used by unit tests, by `--demo` runs and as the last
 * fallback when nothing else can deliver.
 *
 * It deliberately mimics the *contract* (ids, replacement, click events) rather
 * than the pixels, so a test written against it stays meaningful when the real
 * backend changes.
 */

import type {
  AppNotification,
  NotificationBackendCapabilities,
  ShowNotificationResult,
} from '../../../shared/types.js';
import { NotificationBackendBase } from './INotificationBackend.js';

export interface MockDelivery {
  readonly notification: AppNotification;
  readonly at: number;
  readonly replaced: string | null;
}

export class MockNotificationBackend extends NotificationBackendBase {
  readonly deliveries: MockDelivery[] = [];
  readonly open = new Map<string, AppNotification>();
  #available = true;
  #failWith: string | null = null;

  constructor(options: { readonly name?: string } = {}) {
    super(options.name ?? 'mock');
  }

  /** Test controls */
  setAvailable(value: boolean): void {
    this.#available = value;
    this.resetCapabilities();
  }

  failNext(message: string | null): void {
    this.#failWith = message;
  }

  simulateClick(id: string, actionId = 'default'): void {
    if (!this.open.has(id)) return;
    this.emitClick({ backend: this.name, id, actionId });
  }

  simulateClose(id: string, reason: 'expired' | 'dismissed-by-user' = 'dismissed-by-user'): void {
    if (!this.open.delete(id)) return;
    this.emitDismiss({ backend: this.name, id, reason });
  }

  lastDelivery(): AppNotification | null {
    return this.deliveries.at(-1)?.notification ?? null;
  }

  reset(): void {
    this.deliveries.length = 0;
    this.open.clear();
    this.#failWith = null;
    this.#available = true;
    this.resetCapabilities();
  }

  async isAvailable(): Promise<boolean> {
    return this.#available;
  }

  override async probe(): Promise<Omit<NotificationBackendCapabilities, 'name'>> {
    return {
      available: this.#available,
      clickEvents: true,
      actions: true,
      inPlaceGrouping: true,
      silent: true,
      urgency: true,
      reason: this.#available ? null : 'mock backend disabled by test',
    };
  }

  async show(notification: AppNotification): Promise<ShowNotificationResult> {
    if (!this.#available) return this.failure('mock backend is not available');
    if (this.#failWith !== null) {
      const message = this.#failWith;
      this.#failWith = null;
      return this.failure(message);
    }
    const replaced = this.open.has(notification.id) ? notification.id : null;
    this.open.set(notification.id, notification);
    this.deliveries.push({ notification, at: Date.now(), replaced });
    return this.success(notification.id, `mock-${this.deliveries.length}`);
  }

  async close(id: string): Promise<void> {
    this.open.delete(id);
  }

  async closeAll(): Promise<void> {
    this.open.clear();
  }

  override async onDispose(): Promise<void> {
    this.reset();
  }
}
