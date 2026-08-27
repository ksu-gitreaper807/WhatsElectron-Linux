/**
 * Application lifecycle: startup order, shutdown order, and the process level
 * safety net.
 *
 * Startup order is not arbitrary:
 *   1. single instance lock *before* anything touches userData (a second
 *      instance must not create lock files or write settings),
 *   2. logger, 3. settings (everything else reads them),
 *   4. DND + unread (pure state, no I/O),
 *   5. notification service (probes D-Bus; async, non blocking for the window),
 *   6. window (shown as soon as it exists; notifications can attach later),
 *   7. tray (probes the session bus, then the menu),
 *   8. shortcuts and autostart (must not be able to prevent a window),
 *   9. IPC handlers (after everything they reference exists).
 *
 * Shutdown is the reverse for anything with an external resource: global
 * shortcuts first (they are a system wide side effect), then notifications, then
 * windows. A quit that leaves a grabbed Ctrl+Shift+W behind is a bug, even if the
 * application exited cleanly.
 */

import { app, BrowserWindow, dialog, powerMonitor } from 'electron';

import { APP_NAME, EXIT_REASON, TIMEOUTS } from '../../shared/constants.js';
import type { Logger } from '../lib/logger.js';
import { attachProcessErrorBoundaries } from '../lib/errors.js';
import type { NotificationManager } from '../notifications/NotificationManager.js';
import type { NotificationService } from '../notifications/NotificationService.js';
import type { ShortcutManager } from '../shortcuts/ShortcutManager.js';
import type { TrayManager } from '../tray/TrayManager.js';
import type { WindowManager } from '../window/WindowManager.js';
import type { DNDService } from '../dnd/DNDService.js';
import type { DBusConnection } from '../dbus/DBusConnection.js';
import type { SettingsService } from '../settings/SettingsService.js';
import type { UnreadManager } from '../unread/UnreadManager.js';
import type { AutostartService } from '../autostart/AutostartService.js';

export interface LifecycleDeps {
  readonly logger: Logger;
  readonly settings: SettingsService;
  readonly windowManager: WindowManager;
  readonly trayManager: TrayManager;
  readonly shortcutManager: ShortcutManager;
  readonly notificationService: NotificationService;
  readonly notificationManager: NotificationManager;
  readonly unread: UnreadManager;
  readonly dnd: DNDService;
  readonly dbus: DBusConnection | null;
  readonly autostart: AutostartService;
  readonly detachIpc: () => void;
  readonly disposeMenu: () => void;
  readonly debugMode: boolean;
  /**
   * Last chance to flush the log file. Transports queue asynchronous writes, and
   * `app.exit()` does not wait for them - without this the final lines of a
   * shutdown (exactly the ones a bug report needs) are lost.
   */
  readonly flushLogs?: () => Promise<void>;
}

export interface StartupFlags {
  /** `--hidden`: start straight into the tray (used by the autostart entry). */
  readonly startHidden: boolean;
  readonly disableTray: boolean;
  readonly demoNotifications: boolean;
  readonly debugCrash: boolean;
}

export type LifecyclePhase = 'boot' | 'starting' | 'running' | 'quitting' | 'disposed';

export class AppLifecycle {
  readonly #deps: LifecycleDeps;
  #phase: LifecyclePhase = 'boot';
  #detachBoundaries: (() => void) | null = null;
  #detachPower: (() => void) | null = null;
  #quitTimer: ReturnType<typeof setTimeout> | null = null;
  #appReadyHandled = false;

  constructor(deps: LifecycleDeps) {
    this.#deps = deps;
  }

  get phase(): LifecyclePhase {
    return this.#phase;
  }

  get isQuitting(): boolean {
    return this.#phase === 'quitting' || this.#phase === 'disposed';
  }

  /** Install `app` level handlers. Safe to call once, before `whenReady`. */
  install(): void {
    const { windowManager, trayManager, notificationManager, logger } = this.#deps;

    app.on('second-instance', (_event, argv) => {
      logger.info('a second launch was detected; focusing the running instance', {
        flags: argv.filter((arg) => arg.startsWith('--')).slice(0, 4),
      });
      if (argv.includes('--hidden')) {
        // Autostart fired while the user also started it manually: do nothing.
        return;
      }
      windowManager.focus('second-instance');
    });

    app.on('web-contents-created', (_event, contents) => {
      // Global guard for *every* web contents in the process, including any
      // window created outside WindowManager. `will-navigate` + the open deny in
      // the window policy cover our windows; this covers the rest.
      contents.on('will-navigate', (event) => {
        if (windowManager.ownsContents(contents.id)) return;
        event.preventDefault();
        logger.warn('blocked navigation on an unmanaged web contents', { url: event.url });
      });
      contents.setWindowOpenHandler(() => {
        logger.warn('denied window.open on an unmanaged web contents');
        return { action: 'deny' };
      });
    });

    app.on('window-all-closed', () => {
      if (this.isQuitting) return;
      if (trayManager.available && this.#deps.settings.get('closeToTray')) {
        logger.debug('all windows closed but the tray is active: staying alive');
        return;
      }
      logger.info('no windows and no tray: quitting');
      void this.quit(EXIT_REASON.windowAllClosed);
    });

    app.on('before-quit', (event) => {
      if (this.#phase === 'quitting' || this.#phase === 'disposed') return;
      if (this.#phase !== 'running') {
        // Quitting during startup: skip the async teardown, nothing is up yet.
        this.#phase = 'quitting';
        return;
      }
      // We always tear down ourselves, then quit again - otherwise a tray/D-Bus
      // handle is left behind when the user quits via Cmd-Q/session logout.
      if (!event.defaultPrevented) {
        event.preventDefault();
        void this.quit(EXIT_REASON.quitMenu);
      }
    });

    app.on('child-process-gone', (_event, details) => {
      logger.error('child process gone', undefined, {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
      });
      if (details.reason === 'crashed' && this.#phase === 'running') {
        notificationManager.clearAll('manual');
      }
    });

    // Note: `gpu-process-crashed` and `session-end` do not exist in Electron 44.
    // GPU failures arrive through `child-process-gone` (handled above) and a
    // desktop logout arrives as SIGTERM/SIGHUP (handled in main.ts). Both are
    // wired to the same `quit()` path, so nothing is lost by not guessing.
    app.on('accessibility-support-changed', (_event, enabled) => {
      logger.info('accessibility support changed', { enabled });
    });

    app.on('will-quit', (event) => {
      if (this.#phase !== 'disposed') {
        // Reaching will-quit without our teardown means something else called
        // app.quit() (a session manager, for instance). Give the shortcut
        // registrations one synchronous chance to go away.
        event.preventDefault();
        void this.quit(EXIT_REASON.quitSignal);
        return;
      }
      this.#deps.shortcutManager.dispose();
    });

    const onLock = (): void => {
      // Deliberately does *not* drop the queue: the point of a badge is that it
      // is still there when the screen unlocks.
      logger.debug('screen locked; tracking continues, popups stay until unlocked');
    };
    const onUnlock = (): void => {
      logger.debug('screen unlocked; refreshing system DND state');
      void this.#deps.dnd.refresh();
    };
    const onSuspend = (): void => logger.debug('system suspending');
    const onResume = (): void => {
      logger.debug('system resumed; nudging the notification backend');
      void this.#deps.notificationService.refresh();
      void this.#deps.dbus?.connect();
    };
    powerMonitor.on('lock-screen', onLock);
    powerMonitor.on('unlock-screen', onUnlock);
    powerMonitor.on('suspend', onSuspend);
    powerMonitor.on('resume', onResume);
    this.#detachPower = () => {
      powerMonitor.off('lock-screen', onLock);
      powerMonitor.off('unlock-screen', onUnlock);
      powerMonitor.off('suspend', onSuspend);
      powerMonitor.off('resume', onResume);
    };

    this.#detachBoundaries = attachProcessErrorBoundaries(logger, {
      onFatal: (error, kind) => {
        logger.error(`fatal ${kind}`, error);
        if (this.#phase === 'running') {
          // One dialog, no restart loop: the user should know the wrapper died,
          // and their WhatsApp session in the browser is unaffected.
          try {
            dialog.showErrorBox(
              `${APP_NAME} stopped unexpectedly`,
              `${kind}: ${error instanceof Error ? error.message : String(error)}\n\nThe application will now exit. Your WhatsApp Web login is stored on disk and will be reused on the next start.`,
            );
          } catch {
            /* headless: the log line is all we have */
          }
        }
        void this.quit(EXIT_REASON.fatal);
      },
    });
  }

  /** Everything that must happen after `app.whenReady()`. */
  async onReady(flags: StartupFlags): Promise<void> {
    if (this.#appReadyHandled) return;
    this.#appReadyHandled = true;
    this.#phase = 'starting';
    const { logger, settings, windowManager, trayManager, shortcutManager, notificationManager } = this.#deps;

    logger.info('application starting', {
      version: app.getVersion(),
      electron: process.versions['electron'] ?? 'unknown',
      chrome: process.versions['chrome'] ?? 'unknown',
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      packaged: app.isPackaged,
      userData: app.getPath('userData'),
      flags,
    });

    await settings.load();

    // Notification plumbing first (it probes the session bus asynchronously),
    // then the side effects that depend on settings: autostart, shortcut, tray.
    await this.#deps.notificationService.initialize();
    notificationManager.start();
    this.#deps.dnd.start();

    const startupNotes = await settings.applyAll();
    for (const note of startupNotes) {
      logger.warn('startup note', { note });
      this.#deps.windowManager.setTitleState({ sessionWarning: null });
    }

    if (flags.demoNotifications) {
      logger.warn('demo notification mode: the detector is not injected');
    }

    await windowManager.createWhatsAppWindow();
    this.#deps.windowManager.setMinimizeToTray(settings.get('minimizeToTray'));

    if (flags.disableTray) {
      logger.info('tray disabled by command line flag');
      trayManager.setAvailableForTesting(false);
    } else {
      const trayAvailable = await trayManager.initialize();
      logger.info('tray initialization finished', { trayAvailable });
    }

    shortcutManager.start();
    await shortcutManager.apply();

    this.#phase = 'running';
    if (flags.startHidden) windowManager.hide('start-hidden');
    logger.info('application ready', {
      tray: this.#deps.trayManager.status,
      notifications: this.#deps.notificationService.activeName,
      unread: this.#deps.unread.getCount(),
    });

    if (flags.debugCrash) {
      logger.warn('--debug-crash: throwing from the main process on purpose');
      queueMicrotask(() => {
        throw new Error('deliberate crash for testing the error boundary');
      });
    }
  }

  /** Ordered teardown. Idempotent, bounded by `TIMEOUTS.quitGraceMs`. */
  async quit(reason: string): Promise<void> {
    if (this.#phase === 'quitting' || this.#phase === 'disposed') return;
    this.#phase = 'quitting';
    const { logger } = this.#deps;
    logger.info('quitting', { reason });

    // A teardown that hangs (a wedged D-Bus daemon, most likely) must not turn a
    // quit into an unkillable process: after the grace period we exit anyway.
    const deadline = new Promise<'timeout'>((resolve) => {
      this.#quitTimer = setTimeout(() => resolve('timeout'), TIMEOUTS.quitGraceMs * 10);
      this.#quitTimer.unref?.();
    });

    await Promise.race([this.#teardown(reason), deadline]).catch((error: unknown) => {
      logger.error('teardown threw', error);
    });

    if (this.#quitTimer !== null) clearTimeout(this.#quitTimer);
    this.#phase = 'disposed';
    logger.info('teardown complete, exiting');
    try {
      await this.#deps.flushLogs?.();
    } catch (error: unknown) {
      logger.debug('log flush failed', { error: String(error) });
    }
    app.exit(0);
  }

  async #teardown(reason: string): Promise<void> {
    const { shortcutManager, notificationManager, notificationService, trayManager, windowManager, dbus } = this.#deps;

    // 1. Stop new work before tearing down the things it uses.
    shortcutManager.dispose();
    this.#detachBoundaries?.();
    this.#detachPower?.();
    this.#deps.detachIpc();
    this.#deps.disposeMenu();

    // 2. Notifications: drop queued state, close what is on screen.
    await notificationManager.dispose();
    await notificationService.dispose();
    if (dbus !== null) await dbus.dispose();

    // 3. Tray before windows: destroying the tray can otherwise re-trigger a
    //    "no windows" path while we are still closing them.
    trayManager.dispose();
    windowManager.dispose();
    void reason;

    // 4. Storage: deliberately *nothing*. WhatsApp Web keeps its session (and
    //    its crypto keys) in the persistent partition; clearing anything here -
    //    even "just the cache" - risks logging the user out or corrupting the
    //    device link. Settings are written synchronously on every change, so
    //    there is no pending state to flush either.

    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.destroy();
    }
  }
}
