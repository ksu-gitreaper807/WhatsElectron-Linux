/**
 * Native Linux tray integration.
 *
 * What actually happens on Linux
 * -----------------------------
 * Electron implements `Tray` through the StatusNotifierItem spec
 * (`org.kde.StatusNotifierWatcher`), via libayatana-appindicator when it is
 * present, and through a legacy XEmbed fallback otherwise. In practice:
 *
 *   KDE Plasma, XFCE, Cinnamon, MATE, LXQt  ... work out of the box.
 *   GNOME                       ... needs an AppIndicator extension (built into
 *                                    Ubuntu; not present on stock Fedora/Debian).
 *   Sway / wlroots              ... needs a system tray plugin (e.g. `wf-recorder`-style
 *                                    "layer-shell" tray) - without it there is no
 *                                    StatusNotifierWatcher and `new Tray()` shows
 *                                    nothing at all.
 *   headless / CI               ... no session bus: construction may succeed, but
 *                                    nothing is ever displayed.
 *
 * There is *no* "does the tray work" API in Electron 44 (`Tray.isSupported()`
 * was removed, and even when it existed it only answered "is the platform
 * capable"). So availability is answered here with a real probe:
 *   1. can we construct a Tray at all, and
 *   2. does a StatusNotifierWatcher own its bus name?
 * and the result is exported to the window layer, because "close hides to tray"
 * must degrade to "close quits" when there is nothing to hide *into* - otherwise
 * the user loses their window with no way back.
 *
 * Left click toggles visibility (spec requirement). Double click additionally
 * focuses the window. Note that some Linux tray hosts only deliver one of the
 * two; both are wired to safe behaviour so either works.
 */

import { Tray, app, nativeImage, type Menu } from 'electron';

import { APP_ID, APP_NAME } from '../../shared/constants.js';
import type { DBusConnection } from '../dbus/DBusConnection.js';
import type { DNDService } from '../dnd/DNDService.js';
import { buildTrayMenu, type MenuActions } from '../menu/MenuBuilder.js';
import type { Logger } from '../lib/logger.js';
import type { SettingsService } from '../settings/SettingsService.js';
import type { UnreadManager } from '../unread/UnreadManager.js';
import type { TypedEmitter } from '../lib/typedEmitter.js';
import type { WindowManagerEvents } from '../window/WindowManager.js';

const STATUS_NOTIFIER_WATCHER = 'org.kde.StatusNotifierWatcher';

export type TrayStatus = 'unavailable' | 'probing' | 'active' | 'degraded';

export interface TrayManagerDeps {
  readonly logger: Logger;
  readonly dbus: DBusConnection | null;
  readonly dnd: DNDService;
  readonly unread: UnreadManager;
  readonly settings: SettingsService;
  readonly actions: MenuActions;
  readonly snooze: (minutes: number) => void;
  readonly clearUnread: () => void;
  readonly copyDiagnostics: () => void;
  readonly windowEvents: TypedEmitter<WindowManagerEvents>;
  readonly isVisible: () => boolean;
  readonly iconDataUrl: (size: number, badge: number | null, monochrome: boolean) => string;
  readonly notificationBackend: () => string;
  /** Lets the composition root re-publish state when tray availability changes. */
  readonly onStatusChanged?: (status: TrayStatus, reason: string | null) => void;
}

export interface TrayManagerOptions {
  /**
   * `auto` probes for a StatusNotifierWatcher and only degrades when there is
   * none, `force` always creates the tray (useful on desktops whose watcher
   * registration is late), `off` disables the tray entirely (CI).
   */
  readonly mode?: 'auto' | 'force' | 'off';
  /** Whether the DE is likely to want a monochrome symbolic icon. */
  readonly monochrome?: boolean;
  readonly rebuildDebounceMs?: number;
}

export class TrayManager {
  readonly #deps: TrayManagerDeps;
  readonly #opts: TrayManagerOptions;
  readonly #logger: Logger;
  #tray: Tray | null = null;
  #status: TrayStatus = 'unavailable';
  #reason: string | null = null;
  #menuUnsubscribers: readonly (() => void)[] = [];
  #rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  #lastBadge = -1;
  #disposed = false;

  constructor(deps: TrayManagerDeps, opts: TrayManagerOptions = {}) {
    this.#deps = deps;
    this.#opts = opts;
    this.#logger = deps.logger.child('tray');
  }

  get status(): TrayStatus {
    return this.#status;
  }

  get available(): boolean {
    return this.#status === 'active' || this.#status === 'degraded';
  }

  get failureReason(): string | null {
    return this.#reason;
  }

  /**
   * Create the tray. Never throws: on any failure the status becomes
   * `unavailable` and the caller (AppLifecycle) switches the close behaviour to
   * "quit normally".
   */
  async initialize(): Promise<boolean> {
    if (this.#opts.mode === 'off') {
      this.#setStatus('unavailable', 'disabled by configuration');
      return false;
    }
    if (!app.isReady()) {
      this.#setStatus('unavailable', 'app is not ready');
      return false;
    }

    const watcher = await this.#probeWatcher();
    if (this.#opts.mode !== 'force' && watcher === false) {
      this.#setStatus('unavailable', `no ${STATUS_NOTIFIER_WATCHER} on the session bus`);
      this.#logger.warn('system tray is not available on this desktop session', {
        hint: 'GNOME needs an AppIndicator extension; wlroots compositors need a tray plugin',
      });
      return false;
    }

    try {
      const tray = new Tray(nativeImage.createFromDataURL(this.#deps.iconDataUrl(22, null, this.#isMonochrome())));
      tray.setToolTip(this.#tooltip());
      tray.setContextMenu(this.#buildMenu());
      // GNOME shows the title as text next to the icon; KDE ignores it.
      this.#applyTitle(tray, this.#deps.unread.getCount());

      tray.on('click', (_event, bounds) => {
        this.#logger.debug('tray activated', { x: bounds?.x ?? null, y: bounds?.y ?? null });
        this.#toggleFromTray();
      });
      tray.on('double-click', () => {
        // Some hosts (KDE) send both events; the toggle is idempotent per pair
        // because `focus()` re-asserts visibility rather than flipping.
        this.#logger.debug('tray double-click');
        this.#deps.actions.show();
      });
      tray.on('right-click', () => {
        // Menu is shown automatically when a context menu is set; we still
        // rebuild it lazily so the state is never stale.
        this.#scheduleRebuild();
      });

      this.#tray = tray;
      this.#setStatus(
        watcher === null ? 'degraded' : 'active',
        watcher === null ? 'could not probe the session bus' : null,
      );
      this.#subscribe();
      this.#logger.info('system tray ready', {
        status: this.#status,
        desktopEntry: APP_ID,
        watcherProbe: watcher === null ? 'skipped (no session bus)' : 'found',
      });
      return true;
    } catch (error: unknown) {
      this.#setStatus('unavailable', error instanceof Error ? error.message : String(error));
      this.#logger.error('could not create the system tray; close-to-tray is disabled', error);
      return false;
    }
  }

  #isMonochrome(): boolean {
    if (typeof this.#opts.monochrome === 'boolean') return this.#opts.monochrome;
    const desktop = process.env['XDG_CURRENT_DESKTOP'] ?? '';
    return /gnome|unity/i.test(desktop);
  }

  /**
   * `null` when the bus itself is unavailable (then we stay optimistic: many
   * tray hosts register late), `true`/`false` when the answer is known.
   */
  async #probeWatcher(): Promise<boolean | null> {
    const dbus = this.#deps.dbus;
    if (dbus === null) return null;
    const connected = await dbus.connect();
    if (!connected) return null;
    try {
      return await dbus.hasService(STATUS_NOTIFIER_WATCHER);
    } catch (error: unknown) {
      this.#logger.debug('StatusNotifierWatcher probe failed', { error: String(error) });
      return null;
    }
  }

  #subscribe(): void {
    const offUnread = this.#deps.unread.on('changed', ({ count }) => {
      this.updateBadge(count);
      this.#scheduleRebuild();
    });
    const offDnd = this.#deps.dnd.on('changed', () => this.#scheduleRebuild());
    const offSettings = this.#deps.settings.on('changed', () => this.#scheduleRebuild());
    const offVisibility = this.#deps.windowEvents.on('visibility', () => this.#scheduleRebuild());
    this.#menuUnsubscribers = [offUnread, offDnd, offSettings, offVisibility];
  }

  #scheduleRebuild(): void {
    if (this.#disposed || this.#tray === null) return;
    if (this.#rebuildTimer !== null) return;
    this.#rebuildTimer = setTimeout(() => {
      this.#rebuildTimer = null;
      this.rebuildMenu();
    }, this.#opts.rebuildDebounceMs ?? 250);
    this.#rebuildTimer.unref?.();
  }

  rebuildMenu(): void {
    if (this.#tray === null || this.#disposed) return;
    try {
      this.#tray.setContextMenu(this.#buildMenu());
      this.#tray.setToolTip(this.#tooltip());
    } catch (error: unknown) {
      this.#logger.warn('could not rebuild the tray menu', { error: String(error) });
    }
  }

  #buildMenu(): Menu {
    return buildTrayMenu({
      actions: this.#deps.actions,
      dnd: this.#deps.dnd,
      unread: this.#deps.unread,
      logger: this.#logger,
      snooze: this.#deps.snooze,
      clearUnread: this.#deps.clearUnread,
      copyDiagnostics: this.#deps.copyDiagnostics,
      state: () => ({
        unreadCount: this.#deps.unread.getCount(),
        dndActive: this.#deps.dnd.isEnabled(),
        dndDescription: this.#deps.dnd.describe(),
        visible: this.#deps.isVisible(),
        backendName: this.#deps.notificationBackend(),
        trayAvailable: this.available,
        appVersion: app.getVersion(),
      }),
    });
  }

  #tooltip(): string {
    const count = this.#deps.unread.getCount();
    const dnd = this.#deps.dnd.isEnabled() ? ' - Do Not Disturb' : '';
    return `${APP_NAME}${count > 0 ? ` - ${count} unread` : ''}${dnd}`;
  }

  /** Badge: title text (works on GNOME/KDE) + redrawn icon (works on all). */
  updateBadge(count: number): void {
    const tray = this.#tray;
    if (tray === null || this.#disposed) return;
    if (count === this.#lastBadge) return;
    this.#lastBadge = count;
    this.#applyTitle(tray, count);
    this.#applyIcon(tray, count);
    // Taskbar badge where available (Unity/Ubuntu remapped this to the dock).
    try {
      app.setBadgeCount(count);
    } catch {
      /* not supported here */
    }
  }

  #applyTitle(tray: Tray, count: number): void {
    try {
      // GNOME renders this as text next to the icon; KDE ignores it. Either way
      // it is free, so we always set it.
      tray.setTitle(count > 0 ? String(count > 99 ? '99+' : count) : '');
    } catch (error: unknown) {
      this.#logger.debug('tray.setTitle is not honoured by this host', { error: String(error) });
    }
  }

  #applyIcon(tray: Tray, count: number): void {
    try {
      tray.setImage(
        nativeImage.createFromDataURL(this.#deps.iconDataUrl(22, count > 0 ? count : null, this.#isMonochrome())),
      );
    } catch (error: unknown) {
      this.#logger.debug('could not redraw the tray icon', { error: String(error) });
    }
  }

  #setStatus(status: TrayStatus, reason: string | null): void {
    this.#status = status;
    this.#reason = reason;
    // Menu labels mention tray availability, so keep them in sync, and let the
    // composition root re-publish the state snapshot to the UI surfaces.
    this.rebuildMenu();
    this.#deps.onStatusChanged?.(status, reason);
  }

  #toggleFromTray(): void {
    const nowVisible = this.#deps.isVisible();
    if (nowVisible) {
      // Hide, but never *while* the tray menu owns the pointer grab on hosts
      // that deliver the click before the menu opens.
      this.#deps.actions.hide();
      return;
    }
    this.#deps.actions.focus();
  }

  /** Used by tests and by `--demo`: pretend the tray exists. */
  setAvailableForTesting(available: boolean): void {
    this.#setStatus(available ? 'active' : 'unavailable', available ? 'forced by test' : 'forced by test');
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#rebuildTimer !== null) {
      clearTimeout(this.#rebuildTimer);
      this.#rebuildTimer = null;
    }
    for (const unsubscribe of this.#menuUnsubscribers) {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
    }
    this.#menuUnsubscribers = [];
    try {
      this.#tray?.destroy();
    } catch {
      /* ignore */
    }
    this.#tray = null;
    try {
      app.setBadgeCount(0);
    } catch {
      /* ignore */
    }
  }
}
