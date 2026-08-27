/**
 * Diagnostics snapshot.
 *
 * The settings window and the "copy diagnostics" menu item are two renderings of
 * exactly one object, so a bug report contains the same facts the UI shows. All
 * of it is read-only; nothing here can change application state.
 */

import { app } from 'electron';

import { APP_ID, WHATSAPP_PARTITION } from '../../shared/constants.js';
import type { RuntimeStatus } from '../../shared/types.js';
import type { AutostartService } from '../autostart/AutostartService.js';
import type { DBusConnection } from '../dbus/DBusConnection.js';
import type { DNDService } from '../dnd/DNDService.js';
import { directoryStats } from '../lib/fsx.js';
import type { Logger } from '../lib/logger.js';
import type { NotificationManager } from '../notifications/NotificationManager.js';
import type { NotificationService } from '../notifications/NotificationService.js';
import type { SettingsService } from '../settings/SettingsService.js';
import type { ShortcutManager } from '../shortcuts/ShortcutManager.js';
import type { TrayManager } from '../tray/TrayManager.js';
import type { UnreadManager } from '../unread/UnreadManager.js';
import type { WindowManager } from '../window/WindowManager.js';

export interface StatusProviderDeps {
  readonly logger: Logger;
  readonly settings: SettingsService;
  readonly windowManager: WindowManager;
  readonly trayManager: TrayManager;
  readonly shortcutManager: ShortcutManager;
  readonly notificationService: NotificationService;
  readonly notificationManager: NotificationManager;
  readonly unread: UnreadManager;
  readonly dnd: DNDService;
  readonly autostart: AutostartService;
  readonly dbus: DBusConnection | null;
  readonly browserIdentity: () => string | null;
}

export class StatusProvider {
  readonly #deps: StatusProviderDeps;
  #cached: RuntimeStatus | null = null;
  #cachedAt = 0;
  #inflight: Promise<RuntimeStatus> | null = null;

  constructor(deps: StatusProviderDeps) {
    this.#deps = deps;
  }

  /** ~1 s of caching: the settings window polls, and disk scans must not repeat. */
  async get(): Promise<RuntimeStatus> {
    const now = Date.now();
    if (this.#cached !== null && now - this.#cachedAt < 1_000) return this.#cached;
    if (this.#inflight !== null) return this.#inflight;
    this.#inflight = this.#compute().then((status) => {
      this.#cached = status;
      this.#cachedAt = Date.now();
      this.#inflight = null;
      return status;
    });
    return await this.#inflight;
  }

  invalidate(): void {
    this.#cachedAt = 0;
  }

  async #compute(): Promise<RuntimeStatus> {
    const {
      settings,
      windowManager,
      trayManager,
      shortcutManager,
      notificationService,
      notificationManager,
      unread,
      dnd,
      autostart,
      dbus,
    } = this.#deps;

    const sessionDir = app.getPath('sessionData');
    const partitionDir = `${sessionDir}/Partitions/${WHATSAPP_PARTITION.replace(/^persist:/, '')}`;
    const [backends, autostartStatus, size] = await Promise.all([
      notificationService.describe().catch(() => []),
      autostart.status().catch(() => ({
        supported: false,
        enabled: false,
        backend: 'unknown',
        location: 'unknown',
        reason: 'status unavailable',
      })),
      directoryStats(partitionDir, 4_000),
    ]);

    const snapshot = notificationManager.snapshot;
    const dndState = dnd.state();

    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions['electron'] ?? 'unknown',
      chromeVersion: process.versions['chrome'] ?? 'unknown',
      nodeVersion: process.versions.node,
      platform: `${process.platform}/${process.arch}`,
      desktopEnvironment: process.env['XDG_CURRENT_DESKTOP'] ?? process.env['DESKTOP_SESSION'] ?? 'unknown',
      sessionType: process.env['WAYLAND_DISPLAY'] ? 'wayland' : process.env['DISPLAY'] ? 'x11' : 'unknown',
      trayAvailable: trayManager.available,
      notificationBackend: notificationService.activeName,
      notificationBackends: backends,
      dbusConnected: dbus?.connected ?? false,
      unreadCount: unread.getCount(),
      unreadSource: unread.snapshot.source,
      dndActive: dndState.active,
      dndReason: dndState.reason,
      globalShortcutActive: shortcutManager.state.registered,
      globalShortcutError: shortcutManager.state.error,
      globalShortcut: settings.get('globalShortcut'),
      sessionPartition: WHATSAPP_PARTITION,
      userDataDir: app.getPath('userData'),
      settingsPath: settings.location,
      startOnLoginActive: autostartStatus.enabled,
      autostartLocation: autostartStatus.location,
      sessionSizeBytes: size.bytes,
      detectorInstalled: windowManager.detectorInstalled,
      browserIdentity: this.#deps.browserIdentity(),
      windowVisible: windowManager.isVisible,
      sessionState: windowManager.sessionState,
      queue: snapshot,
    };
  }

  /** Plain text blob for "copy diagnostics" - no secrets, no message bodies. */
  async toText(status: RuntimeStatus): Promise<string> {
    const lines = [
      `${APP_ID} ${status.appVersion}`,
      `electron ${status.electronVersion} / chromium ${status.chromeVersion} / node ${status.nodeVersion}`,
      `platform ${status.platform}; desktop ${status.desktopEnvironment}; session ${status.sessionType}`,
      `tray: ${status.trayAvailable ? 'available' : 'unavailable'}`,
      `notifications: backend=${status.notificationBackend}, dbus=${status.dbusConnected ? 'connected' : 'no'}`,
      ...status.notificationBackends.map(
        (backend) =>
          `  - ${backend.name}: available=${backend.available} clicks=${backend.clickEvents} actions=${backend.actions} grouping=${backend.inPlaceGrouping}${backend.reason ? ` reason=${backend.reason}` : ''}`,
      ),
      `shortcut: ${status.globalShortcut} active=${status.globalShortcutActive}${status.globalShortcutError ? ` error=${status.globalShortcutError}` : ''}`,
      `start on login: ${status.startOnLoginActive ? 'enabled' : 'disabled'} (${status.autostartLocation})`,
      `dnd: active=${status.dndActive} reason=${status.dndReason ?? 'none'}`,
      `unread: ${status.unreadCount} (source ${status.unreadSource})`,
      `queue: groups=${status.queue.groups.length} messages=${status.queue.totalMessages} delivered=${status.queue.delivered} suppressed=${status.queue.suppressed} failed=${status.queue.failed}`,
      `settings: ${status.settingsPath}`,
      `profile: ${status.userDataDir} (session ${status.sessionPartition})`,
      `window: visible=${status.windowVisible} whatsapp=${status.sessionState} detector=${status.detectorInstalled ? 'installed' : 'absent'}`,
      `browser identity: ${status.browserIdentity ?? 'Electron default'}`,
    ];
    return lines.join('\n');
  }
}
