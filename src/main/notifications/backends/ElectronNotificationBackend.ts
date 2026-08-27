/**
 * Fallback backend built on Electron's own `Notification` API.
 *
 * On Linux this also talks to `org.freedesktop.Notifications`, but through
 * Chromium's wrapper, which means:
 *   - no `replaces_id`: grouping has to be simulated by closing and re-showing,
 *   - no per-app `desktop-entry` hint on older servers,
 *   - `click` support depends on the notification server (KDE and recent GNOME
 *     deliver it, several lightweight servers do not).
 *
 * It is still the right fallback: it works when `dbus-next` is not installed,
 * and it is the only portable path on macOS/Windows, which keeps the code base
 * honest about being "Electron first, Linux deep".
 */

import { existsSync } from 'node:fs';
import { Notification, nativeImage } from 'electron';

import type {
  AppNotification,
  NotificationBackendCapabilities,
  ShowNotificationResult,
} from '../../../shared/types.js';
import type { Logger } from '../../lib/logger.js';
import { NotificationBackendBase } from './INotificationBackend.js';

type ElectronUrgency = 'normal' | 'critical' | 'low';

export interface ElectronNotificationBackendOptions {
  readonly logger: Logger;
  /**
   * When true, `close()` on an already open id re-shows instead of only
   * updating our bookkeeping. Enabled by the service when it selects this
   * backend, so grouping still *looks* like in-place replacement.
   */
  readonly replaceByRecreate?: boolean;
}

export class ElectronNotificationBackend extends NotificationBackendBase {
  readonly #logger: Logger;
  readonly #replaceByRecreate: boolean;
  readonly #active = new Map<string, Notification>();

  constructor(options: ElectronNotificationBackendOptions) {
    super('electron');
    this.#logger = options.logger.child('notifications.electron');
    this.#replaceByRecreate = options.replaceByRecreate ?? true;
  }

  override async probe(): Promise<Omit<NotificationBackendCapabilities, 'name'>> {
    let supported = false;
    try {
      supported = Notification.isSupported();
    } catch (error: unknown) {
      this.#logger.debug('Notification.isSupported() threw', { error: String(error) });
    }
    return {
      available: supported,
      // The event exists on every platform; whether the *server* sends it is a
      // runtime property we cannot probe. Reported optimistically, and the
      // manager never depends on receiving it.
      clickEvents: supported,
      actions: process.platform !== 'linux',
      inPlaceGrouping: false,
      silent: true,
      urgency: process.platform === 'linux' || process.platform === 'win32',
      reason: supported ? null : 'the desktop environment does not support notifications',
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      return Notification.isSupported();
    } catch {
      return false;
    }
  }

  async show(notification: AppNotification): Promise<ShowNotificationResult> {
    if (!(await this.isAvailable())) return this.failure('Electron notifications are not supported here');

    // Re-create semantics: drop the previous instance so the daemon does not
    // stack "Alice (1)", "Alice (2)", "Alice (3)".
    if (this.#replaceByRecreate) {
      const previous = this.#active.get(notification.id);
      if (previous) {
        try {
          previous.close();
        } catch {
          /* already gone */
        }
        this.#active.delete(notification.id);
      }
    }

    try {
      const instance = new Notification({
        title: notification.title,
        body: notification.body,
        silent: notification.silent,
        ...(notification.iconPath && existsSync(notification.iconPath)
          ? { icon: nativeImage.createFromPath(notification.iconPath) }
          : {}),
        urgency: mapUrgency(notification.urgency),
        timeoutType: notification.expireTimeoutMs < 0 ? 'never' : 'default',
      });

      instance.on('click', () => {
        this.#active.delete(notification.id);
        this.emitClick({ backend: this.name, id: notification.id, actionId: 'default' });
      });
      instance.on('close', () => {
        if (this.#active.get(notification.id) === instance) {
          this.#active.delete(notification.id);
          this.emitDismiss({ backend: this.name, id: notification.id, reason: 'dismissed-by-user' });
        }
      });

      instance.show();
      this.#active.set(notification.id, instance);
      return this.success(notification.id, notification.id);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.error('failed to show notification', error);
      return this.failure(message);
    }
  }

  async close(id: string): Promise<void> {
    const instance = this.#active.get(id);
    if (!instance) return;
    this.#active.delete(id);
    try {
      instance.close();
    } catch {
      /* the daemon already dropped it */
    }
  }

  async closeAll(): Promise<void> {
    for (const [id] of [...this.#active]) await this.close(id);
    this.#active.clear();
  }

  override async onDispose(): Promise<void> {
    await this.closeAll();
  }
}

function mapUrgency(urgency: string): ElectronUrgency {
  switch (urgency) {
    case 'critical':
      return 'critical';
    case 'low':
      return 'low';
    default:
      return 'normal';
  }
}
