/**
 * Native Linux notifications over `org.freedesktop.Notifications`.
 *
 * Why not just Electron's `Notification`? On Linux the Electron wrapper is a
 * thin client over the same bus, but it exposes neither
 *  - `replaces_id` (the mechanism that turns "Alice: msg 1 / msg 2 / msg 3"
 *    into one notification whose counter updates in place), nor
 *  - `ActionInvoked` (the only reliable way to learn *which* notification was
 *    clicked on GNOME/KDE), nor
 *  - hints such as `desktop-entry`, which is what makes the notification
 *    attribute itself to our `.desktop` file (icon, "do not disturb for this
 *    app" menu, per-app settings) instead of to a generic `electron`.
 *
 * Everything here is best effort: if the bus, the service, or a single call is
 * unavailable, capabilities flip to `false` and the service falls back to the
 * Electron backend.
 */

import { NOTIFICATION_APP_NAME, APP_ID } from '../../../shared/constants.js';
import type {
  AppNotification,
  NotificationBackendCapabilities,
  NotificationUrgency,
  ShowNotificationResult,
} from '../../../shared/types.js';
import type { DBusConnection } from '../../dbus/DBusConnection.js';
import type { Logger } from '../../lib/logger.js';
import { NotificationBackendBase } from './INotificationBackend.js';

const BUS_NAME = 'org.freedesktop.Notifications';
const OBJECT_PATH = '/org/freedesktop/Notifications';
/** Notify(app_name, replaces_id, app_icon, summary, body, actions, hints, expire_timeout) */
const NOTIFY_SIGNATURE = 'susssasa{sv}i';
const HINT_URGENCY: Readonly<Record<NotificationUrgency, number>> = {
  low: 0,
  normal: 1,
  critical: 2,
};

/** freedesktop close reasons -> our normalised vocabulary. */
const CLOSE_REASON: Readonly<Record<number, 'expired' | 'dismissed-by-user' | 'program' | 'unknown'>> = {
  1: 'expired',
  2: 'dismissed-by-user',
  3: 'program',
  4: 'dismissed-by-user',
};

export interface LinuxDBusBackendOptions {
  readonly dbus: DBusConnection;
  readonly logger: Logger;
  /** Advertise the desktop file so the daemon can group us properly. */
  readonly desktopEntry?: string;
  /** Ask for buttons ("Open chat") when the server supports actions. */
  readonly useActions?: boolean;
  readonly appName?: string;
}

export class LinuxDBusBackend extends NotificationBackendBase {
  readonly #dbus: DBusConnection;
  readonly #logger: Logger;
  readonly #desktopEntry: string;
  readonly #useActions: boolean;
  readonly #appName: string;
  /** our id -> server id */
  readonly #open = new Map<string, number>();
  /** server id -> our id */
  readonly #reverse = new Map<number, string>();
  #serverCapabilities: readonly string[] = [];
  #unsubscribers: readonly (() => void)[] = [];
  #connected = false;

  constructor(options: LinuxDBusBackendOptions) {
    super('linux-dbus');
    this.#dbus = options.dbus;
    this.#logger = options.logger.child('notifications.dbus');
    this.#desktopEntry = options.desktopEntry ?? APP_ID;
    this.#useActions = options.useActions ?? true;
    this.#appName = options.appName ?? NOTIFICATION_APP_NAME;
  }

  override async onInitialize(): Promise<void> {
    this.#connected = await this.#dbus.connect();
    if (!this.#connected) {
      this.#logger.debug('skipping dbus notifications', { reason: this.#dbus.reason });
      return;
    }
    const caps = await this.#dbus.call({
      destination: BUS_NAME,
      path: OBJECT_PATH,
      interface: BUS_NAME,
      member: 'GetCapabilities',
    });
    if (caps?.[0] && Array.isArray(caps[0])) {
      this.#serverCapabilities = (caps[0] as unknown[]).filter((item): item is string => typeof item === 'string');
    }
    this.#unsubscribers = [await this.#subscribe('ActionInvoked'), await this.#subscribe('NotificationClosed')];
    this.#logger.info('dbus notification backend ready', {
      server: this.#serverName(),
      capabilities: this.#serverCapabilities,
    });
  }

  #serverName(): string {
    return 'org.freedesktop.Notifications';
  }

  async #subscribe(member: 'ActionInvoked' | 'NotificationClosed'): Promise<() => void> {
    return await this.#dbus.subscribe({
      interface: BUS_NAME,
      member,
      sender: BUS_NAME,
      path: OBJECT_PATH,
      onData: (body) => this.#onSignal(member, body),
    });
  }

  #onSignal(member: 'ActionInvoked' | 'NotificationClosed', body: readonly unknown[]): void {
    const nativeId = Number(body[0]);
    if (!Number.isFinite(nativeId)) return;
    const id = this.#reverse.get(nativeId);
    if (id === undefined) {
      // Not ours (another app, or a notification we already replaced).
      return;
    }
    if (member === 'ActionInvoked') {
      const actionId = typeof body[1] === 'string' ? body[1] : 'default';
      this.#logger.debug('notification activated', { id, actionId });
      this.emitClick({ backend: this.name, id, actionId });
      return;
    }
    const reasonCode = Number(body[1]);
    const reason = CLOSE_REASON[Number.isFinite(reasonCode) ? reasonCode : 0] ?? 'unknown';
    this.#open.delete(id);
    this.#reverse.delete(nativeId);
    this.emitDismiss({ backend: this.name, id, reason });
  }

  override async probe(): Promise<Omit<NotificationBackendCapabilities, 'name'>> {
    if (!this.#connected) {
      return {
        available: false,
        clickEvents: false,
        actions: false,
        inPlaceGrouping: false,
        silent: false,
        urgency: false,
        reason: this.#dbus.reason ?? 'not connected to the session bus',
      };
    }
    const has = (capability: string): boolean => this.#serverCapabilities.includes(capability);
    return {
      // Reaching this point means the bus is connected; `Notify` works even on
      // minimal servers that return no capabilities at all.
      available: true,
      clickEvents: true,
      actions: has('actions'),
      inPlaceGrouping: true,
      silent: true,
      urgency: true,
      reason: null,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    if (!this.#connected) this.#connected = await this.#dbus.connect();
    if (!this.#connected) return false;
    return await this.#dbus.hasService(BUS_NAME);
  }

  async show(notification: AppNotification): Promise<ShowNotificationResult> {
    if (!(await this.isAvailable())) return this.failure('session bus or notification daemon unavailable');

    const replacesId = this.#open.get(notification.id) ?? 0;
    const hints: Record<string, unknown> = {};
    const variant = (signature: string, value: unknown): unknown => this.#dbus.variant(signature, value);

    const urgency = variant('y', HINT_URGENCY[notification.urgency] ?? 1);
    if (urgency) hints['urgency'] = urgency;
    const silent = variant('b', notification.silent);
    if (silent) hints['suppress-sound'] = silent;
    const entry = variant('s', this.#desktopEntry);
    if (entry) hints['desktop-entry'] = entry;
    if (notification.category) {
      const category = variant('s', notification.category);
      if (category) hints['category'] = category;
    }
    // Optional hint understood by several daemons: notifications carrying the
    // same token replace each other instead of stacking up.
    const sync = variant('s', notification.id);
    if (sync) hints['x-canonical-private-synchronous'] = sync;

    const actions: string[] = [];
    if (this.#useActions && this.#serverCapabilities.includes('actions')) {
      actions.push('default', 'Open chat');
      for (const action of notification.actions) actions.push(action.id, action.label);
    }

    const reply = await this.#dbus.call({
      destination: BUS_NAME,
      path: OBJECT_PATH,
      interface: BUS_NAME,
      member: 'Notify',
      signature: NOTIFY_SIGNATURE,
      body: [
        this.#appName,
        replacesId,
        notification.iconPath ?? '',
        notification.title,
        notification.body,
        actions,
        hints,
        Math.max(-1, Math.min(2_147_483, Math.round(notification.expireTimeoutMs))),
      ],
      timeoutMs: 5_000,
    });

    if (reply === null || reply === undefined) {
      return this.failure('Notify() returned no reply (notification daemon not responding)');
    }
    const nativeId = Number(reply[0]);
    if (!Number.isFinite(nativeId) || nativeId <= 0) {
      return this.failure(`Notify() returned an invalid id: ${String(reply[0])}`);
    }
    if (replacesId > 0) {
      this.#reverse.delete(replacesId);
    }
    this.#open.set(notification.id, nativeId);
    this.#reverse.set(nativeId, notification.id);
    this.#logger.debug('notification shown', { id: notification.id, nativeId, replacesId, count: notification.count });
    return this.success(notification.id, String(nativeId));
  }

  async close(id: string): Promise<void> {
    const nativeId = this.#open.get(id);
    this.#open.delete(id);
    if (nativeId === undefined) return;
    this.#reverse.delete(nativeId);
    await this.#dbus.call({
      destination: BUS_NAME,
      path: OBJECT_PATH,
      interface: BUS_NAME,
      member: 'CloseNotification',
      signature: 'u',
      body: [nativeId],
    });
  }

  async closeAll(): Promise<void> {
    const ids = [...this.#open.keys()];
    for (const id of ids) await this.close(id);
  }

  /** Whether the daemon lets us suppress notifications at the server level. */
  get supportsInhibit(): boolean {
    return this.#serverCapabilities.includes('inhibitor');
  }

  override async onDispose(): Promise<void> {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers = [];
    this.#open.clear();
    this.#reverse.clear();
  }
}

/** Used by the status view, so the type is exported for convenience. */
export type DBusBackendCapabilities = NotificationBackendCapabilities;
