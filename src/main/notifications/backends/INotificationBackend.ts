/**
 * The notification backend contract.
 *
 * This is the seam that keeps "what we show" independent from "how Linux shows
 * it". A backend receives a fully rendered `AppNotification` and reports a
 * result; it knows nothing about chats, grouping, unread counters or WhatsApp.
 *
 * Adding a backend (XDG `Notification` portal, Windows toast, macOS center)
 * means implementing this interface and registering it in
 * `NotificationService` - no other file changes.
 *
 * Contract rules every backend must honour:
 *  - `show()` never rejects. Delivery problems come back as
 *    `{ ok: false, error }` so the queue always moves on.
 *  - `initialize()`, `dispose()`, `close()` never throw either: a backend that
 *    is broken degrades to `available: false`.
 *  - notifications are addressed by *our* id (`AppNotification.id`, one per
 *    group), never by a backend native handle: that is what makes "replace the
 *    existing group notification instead of stacking a new one" implementable
 *    portably.
 *  - activation (`click`) and dismissal are reported back through events with
 *    that same id.
 */

import type {
  AppNotification,
  NotificationBackendCapabilities,
  ShowNotificationResult,
} from '../../../shared/types.js';
import { TypedEmitter, type EventMap } from '../../lib/typedEmitter.js';

export interface BackendClickEvent {
  readonly backend: string;
  /** The `AppNotification.id` the user activated. */
  readonly id: string;
  /** 'default' for a plain click, otherwise the action id. */
  readonly actionId: string;
}

export type DismissReason = 'expired' | 'dismissed-by-user' | 'program' | 'unknown';

export interface BackendDismissEvent {
  readonly backend: string;
  readonly id: string;
  readonly reason: DismissReason;
}

export interface BackendEvents extends EventMap {
  click: BackendClickEvent;
  dismiss: BackendDismissEvent;
}

export interface INotificationBackend {
  readonly name: string;
  initialize(): Promise<void>;
  isAvailable(): Promise<boolean>;
  capabilities(): Promise<NotificationBackendCapabilities>;
  show(notification: AppNotification): Promise<ShowNotificationResult>;
  close(id: string): Promise<void>;
  closeAll(): Promise<void>;
  dispose(): Promise<void>;
  on<K extends 'click' | 'dismiss'>(event: K, listener: (payload: BackendEvents[K]) => void): () => void;
}

/** Shared plumbing: typed emitter, capability probing, error isolation. */
export abstract class NotificationBackendBase extends TypedEmitter<BackendEvents> implements INotificationBackend {
  readonly name: string;
  #initialized = false;
  #capabilities: NotificationBackendCapabilities | null = null;

  constructor(name: string) {
    super();
    this.name = name;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  abstract isAvailable(): Promise<boolean>;
  abstract show(notification: AppNotification): Promise<ShowNotificationResult>;
  abstract close(id: string): Promise<void>;
  abstract closeAll(): Promise<void>;
  protected abstract probe(): Promise<Omit<NotificationBackendCapabilities, 'name'>>;

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    try {
      await this.onInitialize();
    } catch (error: unknown) {
      this.onInitializeFailure(error);
    }
  }

  protected async onInitialize(): Promise<void> {
    /* optional hook */
  }

  protected onInitializeFailure(_error: unknown): void {
    /* optional hook: implementations may log */
  }

  async capabilities(): Promise<NotificationBackendCapabilities> {
    if (this.#capabilities) return this.#capabilities;
    let probed: Omit<NotificationBackendCapabilities, 'name'>;
    try {
      probed = await this.probe();
    } catch (error: unknown) {
      probed = {
        available: false,
        clickEvents: false,
        actions: false,
        inPlaceGrouping: false,
        silent: false,
        urgency: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    this.#capabilities = Object.freeze({ name: this.name, ...probed });
    return this.#capabilities;
  }

  /** Force a re-probe, e.g. after the session bus reconnects. */
  protected resetCapabilities(): void {
    this.#capabilities = null;
  }

  async dispose(): Promise<void> {
    this.#capabilities = null;
    this.#initialized = false;
    try {
      await this.onDispose();
    } catch {
      /* nothing useful to do while tearing down */
    }
    this.removeAllListeners();
  }

  protected async onDispose(): Promise<void> {
    /* optional hook */
  }

  protected success(id: string, nativeId: string | null): ShowNotificationResult {
    return { ok: true, backend: this.name, nativeId, error: null };
  }

  protected failure(error: string, nativeId: string | null = null): ShowNotificationResult {
    return { ok: false, backend: this.name, nativeId, error };
  }

  protected emitClick(payload: BackendClickEvent): void {
    this.emit('click', payload);
  }

  protected emitDismiss(payload: BackendDismissEvent): void {
    this.emit('dismiss', payload);
  }
}
