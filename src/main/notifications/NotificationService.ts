/**
 * NotificationService: backend selection and routing.
 *
 * Responsibilities (and nothing else):
 *  - probe every registered backend once at startup,
 *  - pick the first one that is available for this desktop session,
 *  - hand notifications to it, falling back on the next one on failure,
 *  - re-export activation/dismissal events with a normalised shape,
 *  - expose what the current desktop can and cannot do (status view).
 *
 * It is intentionally *stateless* with respect to chats, grouping and unread
 * counts: that is the NotificationManager's job. Swapping this layer out (for
 * example to talk to the XDG Notification portal instead of the raw bus) does
 * not touch the queueing logic, and vice versa.
 */

import type { AppNotification, NotificationBackendCapabilities, ShowNotificationResult } from '../../shared/types.js';
import type { Logger } from '../lib/logger.js';
import { TypedEmitter, type EventMap } from '../lib/typedEmitter.js';
import type { BackendClickEvent, BackendDismissEvent, INotificationBackend } from './backends/INotificationBackend.js';

export interface ServiceEvents extends EventMap {
  click: BackendClickEvent;
  dismiss: BackendDismissEvent;
  /** Emitted when the active backend changed (failure, or a re-probe). */
  backendChanged: { readonly previous: string | null; readonly next: string | null; readonly reason: string };
}

export interface NotificationServiceOptions {
  readonly logger: Logger;
  /** All backends this session can offer, in fallback order. */
  readonly backends: readonly INotificationBackend[];
  /** Do not retry a failed backend before this many ms have passed. */
  readonly retryIntervalMs?: number;
  /** Initial user preference (`auto` by default). */
  readonly preferred?: string;
}

interface BackendRecord {
  readonly backend: INotificationBackend;
  capabilities: NotificationBackendCapabilities | null;
  available: boolean;
  failures: number;
  lastError: string | null;
  disabledUntil: number;
}

export class NotificationService extends TypedEmitter<ServiceEvents> {
  readonly #records: BackendRecord[];
  readonly #logger: Logger;
  readonly #retryIntervalMs: number;
  #activeIndex = -1;
  #initialized = false;
  #preferred: string;
  #unsubscribers: readonly (() => void)[] = [];

  constructor(options: NotificationServiceOptions) {
    super();
    this.#logger = options.logger.child('notifications.service');
    this.#retryIntervalMs = options.retryIntervalMs ?? 60_000;
    this.#preferred = options.preferred ?? 'auto';
    this.#records = options.backends.map((backend) => ({
      backend,
      capabilities: null,
      available: false,
      failures: 0,
      lastError: null,
      disabledUntil: 0,
    }));
  }

  get active(): INotificationBackend | null {
    return this.#activeIndex >= 0 ? (this.#records[this.#activeIndex]?.backend ?? null) : null;
  }

  get activeName(): string {
    return this.active?.name ?? 'none';
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;

    for (const record of this.#records) {
      try {
        await record.backend.initialize();
        record.capabilities = await record.backend.capabilities();
        record.available = record.capabilities.available;
      } catch (error: unknown) {
        record.available = false;
        record.lastError = error instanceof Error ? error.message : String(error);
        this.#logger.error('backend failed to initialise', error, { backend: record.backend.name });
      }
      // Listen once, forever: a click on any backend must reach the manager.
      const offClick = record.backend.on('click', (payload) => this.#onClick(payload));
      const offDismiss = record.backend.on('dismiss', (payload) => this.emit('dismiss', payload));
      this.#unsubscribers = [
        ...this.#unsubscribers,
        offClick,
        typeof offDismiss === 'function' ? offDismiss : () => undefined,
      ];
    }

    this.#select('startup');
    this.#logger.info('notification service ready', {
      active: this.activeName,
      backends: this.#records.map((record) => ({
        name: record.backend.name,
        available: record.available,
        reason: record.capabilities?.reason ?? null,
      })),
    });
  }

  #onClick(payload: BackendClickEvent): void {
    this.#logger.debug('notification activated', {
      backend: payload.backend,
      id: payload.id,
      action: payload.actionId,
    });
    this.emit('click', payload);
  }

  /**
   * Choose the active backend: usable (available and not temporarily disabled),
   * then the user's explicit preference, then registration order.
   */
  #select(reason: string): void {
    const previous = this.active?.name ?? null;
    const ranked = this.#usable();
    this.#activeIndex = ranked.length > 0 ? this.#records.indexOf(ranked[0] as BackendRecord) : -1;
    const next = this.active?.name ?? null;
    if (next !== previous) {
      this.emit('backendChanged', { previous, next, reason });
      this.#logger.info('notification backend changed', { previous, next, reason });
    }
  }

  /** Re-probe every backend (used after a D-Bus reconnect or a settings change). */
  async refresh(): Promise<void> {
    this.#initialized = false;
    for (const record of this.#records) {
      record.disabledUntil = 0;
      record.failures = 0;
      record.lastError = null;
    }
    this.#initialized = true;
    for (const record of this.#records) {
      try {
        await record.backend.initialize();
        const available = await record.backend.isAvailable();
        record.available = available;
        if (available) record.capabilities = await record.backend.capabilities();
      } catch (error: unknown) {
        record.available = false;
        record.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    this.#select('refresh');
  }

  async show(notification: AppNotification): Promise<ShowNotificationResult> {
    if (!this.#initialized) await this.initialize();

    const order = this.#candidateOrder();
    let lastError = 'no notification backend is available on this system';

    for (const record of order) {
      try {
        const result = await record.backend.show(notification);
        if (result.ok) {
          if (record.failures > 0) {
            record.failures = 0;
            this.#logger.info('backend recovered', { backend: record.backend.name });
          }
          return result;
        }
        lastError = result.error ?? lastError;
        this.#noteFailure(record, lastError);
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
        this.#noteFailure(record, lastError, error);
      }
    }

    this.#logger.warn('notification not delivered', { id: notification.id, error: lastError });
    return { ok: false, backend: this.activeName, nativeId: null, error: lastError };
  }

  /** Available backends in preference order, with temporary failures excluded. */
  #usable(): BackendRecord[] {
    const now = Date.now();
    const usable = this.#records.filter((record) => record.available && record.disabledUntil <= now);
    const rank = (record: BackendRecord): number => (this.#matchesPreference(record.backend.name) ? 0 : 1);
    // Array.prototype.sort is stable, so registration order survives ties.
    return [...usable].sort((a, b) => rank(a) - rank(b));
  }

  /** Active backend first, then every other usable one, as a fallback chain. */
  #candidateOrder(): BackendRecord[] {
    const usable = this.#usable();
    const active = this.#activeIndex >= 0 ? this.#records[this.#activeIndex] : undefined;
    if (active === undefined || !usable.includes(active)) return usable;
    return [active, ...usable.filter((record) => record !== active)];
  }

  /**
   * Settings use short names ('dbus'), backends use descriptive ones
   * ('linux-dbus'). One mapping, so the preference cannot silently do nothing.
   */
  #matchesPreference(name: string): boolean {
    if (this.#preferred === 'auto') return false;
    const alias: Readonly<Record<string, string>> = { dbus: 'linux-dbus', 'linux-dbus': 'linux-dbus' };
    return name === this.#preferred || alias[this.#preferred] === name;
  }

  /** Called when `settings.notificationBackend` changes. */
  async setPreference(preference: string): Promise<string> {
    this.#preferred = preference;
    this.#select(`preference:${preference}`);
    await this.refresh();
    return this.activeName;
  }

  get preference(): string {
    return this.#preferred;
  }

  #noteFailure(record: BackendRecord, message: string, error?: unknown): void {
    record.failures += 1;
    record.lastError = message;
    if (error !== undefined) {
      this.#logger.error('backend show() threw', error, { backend: record.backend.name });
    } else {
      this.#logger.warn('backend rejected the notification', { backend: record.backend.name, error: message });
    }
    if (record.failures >= 3) {
      record.disabledUntil = Date.now() + this.#retryIntervalMs;
      this.#logger.warn('disabling notification backend for a while', {
        backend: record.backend.name,
        until: new Date(record.disabledUntil).toISOString(),
      });
      this.#select(`failures:${record.backend.name}`);
    }
  }

  async close(id: string): Promise<void> {
    for (const record of this.#records) {
      try {
        await record.backend.close(id);
      } catch (error: unknown) {
        this.#logger.debug('close() failed', { backend: record.backend.name, error: String(error) });
      }
    }
  }

  async closeAll(): Promise<void> {
    for (const record of this.#records) {
      try {
        await record.backend.closeAll();
      } catch (error: unknown) {
        this.#logger.debug('closeAll() failed', { backend: record.backend.name, error: String(error) });
      }
    }
  }

  /** For the status view in the settings window. */
  async describe(): Promise<
    readonly (NotificationBackendCapabilities & { failures: number; lastError: string | null })[]
  > {
    const out = [];
    for (const record of this.#records) {
      const capabilities = record.capabilities ?? (await record.backend.capabilities());
      out.push({ ...capabilities, failures: record.failures, lastError: record.lastError });
    }
    return out;
  }

  async dispose(): Promise<void> {
    for (const unsubscribe of this.#unsubscribers) {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
    }
    this.#unsubscribers = [];
    for (const record of this.#records) await record.backend.dispose();
    this.#activeIndex = -1;
    this.removeAllListeners();
  }
}
