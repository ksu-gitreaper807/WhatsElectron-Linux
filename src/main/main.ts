/**
 * Composition root.
 *
 * This file contains no behaviour of its own. It decides *which* implementations
 * exist, in what order they start, and how they are connected - which is why the
 * rest of the code base can stay decoupled and unit testable.
 *
 * Reading this file top to bottom is the fastest way to understand the
 * application. See docs/ARCHITECTURE.md for the diagram.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, clipboard, dialog, session, type Session } from 'electron';

import {
  APP_ID,
  APP_NAME,
  APP_PACKAGE_NAME,
  DESKTOP_FILE_NAME,
  EXIT_REASON,
  PATHS,
  WHATSAPP_PARTITION,
} from '../shared/constants.js';
import type { AppStatePayload } from '../shared/types.js';
import { dedupeKeyOf } from '../shared/util.js';

import { createLogger, type LogLevel } from './lib/logger.js';
import { Late } from './lib/late.js';
import { runDetached } from './lib/errors.js';
import { FileSettingsStore } from './settings/SettingsStore.js';
import { SettingsService } from './settings/SettingsService.js';
import { AutostartService, createAutostartBackend } from './autostart/AutostartService.js';
import { DNDService } from './dnd/DNDService.js';
import { XdgPortalDndSource } from './dnd/sources/XdgPortalDndSource.js';
import { DBusConnection } from './dbus/DBusConnection.js';
import { ElectronNotificationBackend } from './notifications/backends/ElectronNotificationBackend.js';
import { FileNotificationBackend } from './notifications/backends/FileNotificationBackend.js';
import { LinuxDBusBackend } from './notifications/backends/LinuxDBusBackend.js';
import { MockNotificationBackend } from './notifications/backends/MockNotificationBackend.js';
import { NotificationService } from './notifications/NotificationService.js';
import { NotificationManager } from './notifications/NotificationManager.js';
import { ShortcutManager } from './shortcuts/ShortcutManager.js';
import { StatusProvider } from './status/StatusProvider.js';
import { TrayManager } from './tray/TrayManager.js';
import { UnreadManager } from './unread/UnreadManager.js';
import { RoleRegistry } from './security/RoleRegistry.js';
import { applySessionSecurity } from './security/WindowSecurity.js';
import { resolveUserAgent } from './security/UserAgent.js';
import { broadcastState, registerIpcHandlers } from './ipc/ipcHandlers.js';
import { attachApplicationMenu } from './menu/ApplicationMenu.js';
import type { MenuActions } from './menu/MenuBuilder.js';
import { WindowManager } from './window/WindowManager.js';
import { AppLifecycle, type StartupFlags } from './lifecycle/AppLifecycle.js';
import { SmokeHarness } from './lifecycle/SmokeHarness.js';
import { IconProvider } from './icons/IconProvider.js';
import { renderIcon } from './icons/IconRenderer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `<app>/out/main/main.js` -> application root, where `out/` lives. */
const APP_ROOT = app.isPackaged ? path.resolve(HERE, '..', '..') : process.cwd();

interface Flags extends StartupFlags {
  readonly dev: boolean;
  readonly logLevel: LogLevel | null;
  readonly smoke: boolean;
}

function readFlags(argv: readonly string[]): Flags {
  return {
    // Autostart entries are written with `--hidden`; that is what makes
    // "start on login" not shove a window in the user's face.
    startHidden: argv.includes('--hidden') || argv.includes('--start-hidden'),
    disableTray: argv.includes('--no-tray'),
    demoNotifications: argv.includes('--demo-notifications'),
    debugCrash: argv.includes('--debug-crash'),
    smoke: argv.includes('--smoke'),
    dev: argv.includes('--dev') || !app.isPackaged,
    logLevel: readLogLevel(argv),
  };
}

function readLogLevel(argv: readonly string[]): LogLevel | null {
  const index = argv.indexOf('--log-level');
  const value = index >= 0 ? argv[index + 1] : (process.env['WA_DESKTOP_LOG_LEVEL'] ?? null);
  if (value === null || value === undefined) return null;
  const allowed: readonly string[] = ['silly', 'debug', 'info', 'warn', 'error', 'silent'];
  return allowed.includes(value) ? (value as LogLevel) : null;
}

/**
 * `app.setName()` must run before the first `app.getPath()` call: userData is
 * resolved from the application name, and getting this wrong puts the persistent
 * session in the wrong folder - which looks exactly like "I have to log in
 * again" after an update.
 */
function configureIdentity(): void {
  app.setName(APP_PACKAGE_NAME);
  try {
    // Must be the *installed .desktop file name*: the LauncherEntry badge and the
    // notification/portal identity are both resolved through it.
    app.setDesktopName(DESKTOP_FILE_NAME);
  } catch {
    /* `setDesktopName` is not present on every build; the .desktop file still works */
  }
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
}

/**
 * One instance per profile. The lock lives in the same userData directory as the
 * persistent session, because two processes sharing that partition would fight
 * over LevelDB/IndexedDB and can log each other out - the worst possible failure
 * mode for this application.
 */
function acquireSingleInstanceLock(): boolean {
  if (app.requestSingleInstanceLock({ id: APP_ID, at: Date.now() })) return true;
  // Electron forwards the launch to the running instance (`second-instance`).
  app.quit();
  return false;
}

function main(): void {
  const flags = readFlags(process.argv);
  configureIdentity();
  if (!acquireSingleInstanceLock()) return;

  void compose(flags).catch((error: unknown) => {
    // Nothing below this point is recoverable: if the composition root itself
    // fails, say so clearly instead of vanishing from the terminal.
    process.stderr.write(
      `fatal: ${APP_NAME} could not start\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    try {
      dialog.showErrorBox(`${APP_NAME} could not start`, String(error instanceof Error ? error.message : error));
    } catch {
      /* headless: the stderr line is all there is */
    }
    app.exit(1);
  });
}

async function compose(flags: Flags): Promise<void> {
  // --- 1. logging -------------------------------------------------------------
  let logDir: string | null;
  try {
    logDir = app.getPath('logs');
  } catch {
    logDir = path.join(app.getPath('userData'), PATHS.logDir);
  }
  const {
    logger,
    writer: logWriter,
    filePath: logFile,
  } = createLogger({
    logDir,
    ...(flags.logLevel === null ? {} : { level: flags.logLevel }),
    console: flags.dev,
  });
  logger.info('logger ready', { file: logFile, level: flags.logLevel ?? 'auto', dev: flags.dev });

  if (process.argv.includes('--no-sandbox')) {
    logger.warn(
      'running with --no-sandbox: the renderer isolation this application depends on is DISABLED. Remove the flag unless you are debugging a Chromium sandbox problem.',
    );
  }

  // --- 2. paths ---------------------------------------------------------------
  const userData = app.getPath('userData');
  const settingsPath = path.join(userData, PATHS.settingsFile);
  const boundsPath = path.join(userData, 'window-state.json');
  const iconDir = path.join(userData, PATHS.iconDir);
  const notificationDumpPath = path.join(userData, PATHS.notificationDump);

  // --- 3. settings ---------------------------------------------------------
  const settings = new SettingsService({
    logger,
    store: new FileSettingsStore({ filePath: settingsPath, logger, schemaVersion: 1 }),
    ...(flags.demoNotifications ? { overrides: { notificationBackend: 'mock' } } : {}),
  });

  // --- 4. state services (no I/O, no Electron) -----------------------------
  const unread = new UnreadManager();
  const dbus = process.platform === 'linux' ? new DBusConnection({ logger }) : null;
  const dnd = new DNDService({
    settings,
    logger,
    ...(dbus === null ? {} : { source: new XdgPortalDndSource({ dbus, logger }) }),
  });

  // --- 5. Electron must be ready before any of the objects below can exist ---
  // Order matters and is asserted by the smoke test: `session`, `dialog`, the tray
  // and the global shortcut table are all unavailable before this resolves.
  await app.whenReady();

  // --- 6. persistent session --------------------------------------------------
  // Nothing is ever cleared here. `persist:` is what keeps cookies,
  // localStorage, IndexedDB (where WhatsApp Web keeps its crypto keys) and the
  // service worker registration under
  // `<userData>/Partitions/whatsapp`, outside the app bundle, so updates and
  // reinstalls do not log the user out.
  const whatsappSession: Session = session.fromPartition(WHATSAPP_PARTITION);
  const roles = new RoleRegistry();
  applySessionSecurity(whatsappSession, { logger, roles });

  // --- browser identity ---------------------------------------------------
  // WhatsApp Web refuses to boot when it sees "Electron" in the User-Agent
  // ("WhatsApp works with Google Chrome 100+"), so by default the Electron and
  // application tokens are stripped from the UA this Chromium would have sent.
  // It changes one advertised string - not the sandbox, origin, CSP or granted
  // permissions. See security/UserAgent.ts.
  const runtimeUserAgent = whatsappSession.getUserAgent();
  let browserIdentityNote: string | null = null;
  const applyIdentity = (announce: boolean): string => {
    const resolved = resolveUserAgent(settings.get('userAgentMode'), runtimeUserAgent, settings.get('customUserAgent'));
    // Electron has no "unset": restoring means re-sending the original string.
    whatsappSession.setUserAgent(resolved.value ?? runtimeUserAgent);
    const note = resolved.reason ?? `Chrome-styled identity (${resolved.mode})`;
    browserIdentityNote = note;
    if (announce) {
      logger[resolved.reason === null ? 'info' : 'warn']('browser identity configured', {
        mode: resolved.mode,
        userAgent: resolved.value ?? '(Electron default)',
        note,
      });
    }
    return note;
  };
  applyIdentity(true);

  const autostart = new AutostartService({ logger, backend: createAutostartBackend(logger) });

  // --- 7. notification backends + service --------------------------------
  const iconPaths = await new IconProvider({ directory: iconDir, logger, themeIconName: APP_ID }).prepare();
  const backends = [
    ...(dbus === null
      ? []
      : [
          new LinuxDBusBackend({
            dbus,
            logger,
            desktopEntry: DESKTOP_FILE_NAME,
            useActions: true,
          }),
        ]),
    new ElectronNotificationBackend({ logger }),
    new FileNotificationBackend({ filePath: notificationDumpPath, logger }),
    new MockNotificationBackend(),
  ];
  const notificationService = new NotificationService({
    logger,
    backends,
    preferred: settings.get('notificationBackend'),
  });

  // Late bindings: two genuine cycles exist (window <-> lifecycle, tray <->
  // status). `Late<T>` keeps them explicit instead of passing `null` around.
  const lifecycleRef = new Late<AppLifecycle>();
  const statusRef = new Late<StatusProvider>();

  // --- 8. windows ----------------------------------------------------------
  const windowManager: WindowManager = new WindowManager({
    logger,
    roles,
    preloadPath: path.join(APP_ROOT, 'out', 'preload', 'whatsapp.cjs'),
    settingsPreloadPath: path.join(APP_ROOT, 'out', 'preload', 'settings.cjs'),
    settingsHtmlPath: path.join(APP_ROOT, 'out', 'renderer', 'settings', 'index.html'),
    iconPath: iconPaths.notification,
    boundsStore: new FileSettingsStore({ filePath: boundsPath, logger }),
    devTools: flags.dev,
    startHidden: flags.startHidden,
    allowDiagnostics: flags.dev,
    // "Hide to tray" is only safe when something can bring the window back.
    canHideToTray: (): boolean =>
      settings.get('closeToTray') && (trayManager.available || BrowserWindow.getAllWindows().length > 1),
    isQuitting: () => (lifecycleRef.bound ? lifecycleRef.get()?.isQuitting === true : false),
    onQuitRequested: (reason) => {
      runDetached(async () => await lifecycleRef.require('lifecycle').quit(reason), {
        label: 'quit requested by the window layer',
        logger,
      });
    },
  });
  // The `(N)` prefix from the page title feeds the same counter the notification
  // pipeline drives, so both surfaces agree.
  windowManager.setUnreadBridge({
    onTitleUnread: (count: number) => unread.set(count, 'title'),
  });

  // --- 9. notification manager (needs the window layer, so it comes after) --
  const notificationManager = new NotificationManager({
    service: notificationService,
    dnd,
    unread,
    settings,
    logger,
    isWindowActive: () => windowManager.isQuietNow(settings.get('focusQuietMs')),
    onActivate: (payload) => {
      logger.info('notification activated; bringing WhatsApp forward', {
        chat: dedupeKeyOf(payload.chatName).slice(0, 8),
        action: payload.activation,
      });
      windowManager.focus('notification-click');
      // Best effort, and only ever *our own* code: the id handed to the preload
      // is an opaque token, the preload does nothing unless WhatsApp itself
      // offers a supported hook. There is no page automation here.
      if (payload.chatId.length > 0) {
        windowManager.navigateToChat(payload.chatId, payload.chatName);
      }
    },
  });
  notificationManager.setIconProvider(() => iconPaths.notification);

  // --- 10. shared state snapshot for the UI surfaces ------------------------
  const publish = (): void => {
    const snapshot = unread.snapshot;
    const payload: AppStatePayload = {
      unread: snapshot,
      dnd: { active: dnd.isEnabled(), reason: dnd.state().reason },
      visible: windowManager.isVisible,
      sessionState: windowManager.sessionState,
    };
    broadcastState(windowManager, payload);
    windowManager.setTitleState({
      unreadCount: snapshot.count,
      dndActive: dnd.isEnabled(),
      showBadge: settings.get('titleBadge'),
    });
    statusRef.get()?.invalidate();
  };

  // --- 11. tray -------------------------------------------------------------
  const menuActions: MenuActions = {
    show: () => windowManager.show('menu'),
    hide: () => windowManager.hide('menu'),
    toggle: () => windowManager.toggle('menu'),
    focus: () => windowManager.focus('menu'),
    openSettings: () => {
      runDetached(async () => await windowManager.openSettings(), { label: 'open settings', logger });
    },
    retryLoad: () => windowManager.retryLoad(),
    reload: () => windowManager.reload(),
    zoomIn: () => windowManager.zoom(0.1),
    zoomOut: () => windowManager.zoom(-0.1),
    resetZoom: () => windowManager.zoom(0),
    toggleDevTools: () => windowManager.toggleDevTools(),
    toggleMenu: () => {
      runDetached(async () => await settings.set('showMenu', !settings.get('showMenu')), {
        label: 'toggle menu bar',
        logger,
      });
    },
    quit: (reason) => {
      runDetached(async () => await lifecycleRef.require('lifecycle').quit(reason), {
        label: `quit (${reason})`,
        logger,
      });
    },
  };

  const copyDiagnostics = (): void => {
    runDetached(
      async () => {
        const status = statusRef.require('status');
        const snapshot = await status.get();
        await clipboard.writeText(await status.toText(snapshot));
        logger.info('diagnostic information copied to the clipboard');
      },
      { label: 'copy diagnostics', logger },
    );
  };

  const trayManager: TrayManager = new TrayManager(
    {
      logger,
      dbus,
      dnd,
      unread,
      settings,
      actions: menuActions,
      notificationBackend: () => notificationService.activeName,
      isVisible: () => windowManager.isVisible,
      iconDataUrl: (size, badge, monochrome) =>
        renderIcon({ size, badge, ...(monochrome ? { style: 'symbolic' as const } : {}) }).dataUrl,
      snooze: (minutes) => {
        dnd.snooze(minutes);
      },
      clearUnread: () => {
        unread.clear('manual');
        notificationManager.clearAll('manual');
      },
      copyDiagnostics,
      windowEvents: windowManager,
      onStatusChanged: () => statusRef.get()?.invalidate(),
    },
    { mode: flags.disableTray ? 'off' : 'auto' },
  );

  // --- 12. shortcuts --------------------------------------------------------
  const shortcutManager = new ShortcutManager({
    logger,
    settings,
    toggle: () => windowManager.toggle('global-shortcut'),
    onTrigger: () => logger.debug('global shortcut fired'),
    notifyUnavailable: (accelerator, reason) => {
      // The registration failure is persistent in Settings; nagging on every
      // start would be worse than one log line plus a dialog in development.
      logger.warn('global shortcut unavailable', { accelerator, reason });
      if (!flags.dev) return;
      runDetached(
        async () => {
          const choice = await dialog.showMessageBox({
            type: 'warning',
            title: APP_NAME,
            message: `The global shortcut ${accelerator} could not be registered`,
            detail: `${reason}\n\nPick another combination in Settings, or free it in your desktop environment's keyboard settings.`,
            buttons: ['Open Settings', 'Ignore'],
            defaultId: 1,
            cancelId: 1,
          });
          if (choice.response === 0) await windowManager.openSettings();
        },
        { label: 'shortcut failure dialog', logger },
      );
    },
  });

  // --- 13. diagnostics ------------------------------------------------------
  const status = new StatusProvider({
    logger,
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
    browserIdentity: () => browserIdentityNote,
  });
  statusRef.set(status);

  // --- 14. IPC (after everything it can reach exists) ---------------------
  const detachIpc = registerIpcHandlers({
    logger,
    roles,
    settings,
    windowManager,
    notifications: notificationManager,
    notificationService,
    unread,
    dnd,
    shortcuts: shortcutManager,
    statusProvider: async () => await status.get(),
    publishState: publish,
    requestQuit: (reason) => {
      runDetached(async () => await lifecycleRef.require('lifecycle').quit(reason), {
        label: `quit (${reason})`,
        logger,
      });
    },
  });

  const disposeMenu = attachApplicationMenu({
    logger,
    settings,
    windowManager,
    dnd,
    unread,
    status,
    actions: menuActions,
    trayAvailable: () => trayManager.available,
    backendName: () => notificationService.activeName,
    snooze: (minutes) => dnd.snooze(minutes),
    clearUnread: () => {
      unread.clear('manual');
      notificationManager.clearAll('manual');
    },
  });

  // --- 15. settings side effects ------------------------------------------
  // Every component that must react to a preference registers itself here. This
  // list is the whole wiring: no module imports another one to push a change.
  settings.onKey('startOnLogin', async (next) => await autostart.sync(next.startOnLogin));
  settings.onKey('globalShortcut', async () => await shortcutManager.apply());
  settings.onKey('globalShortcutEnabled', async () => await shortcutManager.apply());
  const identityChanged = (): readonly string[] => {
    const note = applyIdentity(true);
    // A new UA only reaches the page after a reload; say so instead of letting
    // the user stare at the same error page.
    return [`${note} - reload WhatsApp Web (Ctrl+R) to apply`];
  };
  settings.onKey('userAgentMode', identityChanged);
  settings.onKey('customUserAgent', identityChanged);
  settings.onKey('notificationBackend', async (next) => {
    const active = await notificationService.setPreference(next.notificationBackend);
    return [`notification backend: ${active}`];
  });
  settings.onKey('minimizeToTray', (next) => {
    windowManager.setMinimizeToTray(next.minimizeToTray);
    return [];
  });
  settings.onKey('syncSystemDnd', async (next) => {
    await dnd.refresh();
    return [
      next.syncSystemDnd ? 'following the desktop Do Not Disturb state' : 'ignoring the desktop Do Not Disturb state',
    ];
  });

  // --- 16. event fan out ---------------------------------------------------
  unread.on('changed', publish);
  dnd.on('changed', publish);
  windowManager.on('visibility', publish);
  windowManager.on('focus', ({ focused }: { focused: boolean }) => {
    if (!focused) return;
    if (settings.get('clearUnreadOnFocus')) {
      unread.clear('focus');
      notificationManager.onWindowFocused();
    }
  });
  windowManager.on('ready', ({ role }: { role: string }) => logger.debug('window ready', { role }));
  windowManager.on('load-slow', ({ ms }: { ms: number }) => logger.warn('WhatsApp took a long time to load', { ms }));
  notificationManager.on('delivered', ({ groupKey, status: state }: { groupKey: string; status: string }) => {
    logger.debug('notification group state', { groupKey, status: state });
  });

  // --- 17. lifecycle -------------------------------------------------------
  const lifecycle = new AppLifecycle({
    logger,
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
    detachIpc,
    disposeMenu,
    debugMode: flags.dev,
    flushLogs: async () => {
      await logWriter?.flush();
    },
  });
  lifecycleRef.set(lifecycle);
  lifecycle.install();

  // --- 18. start everything ------------------------------------------------
  await lifecycle.onReady({
    startHidden: flags.startHidden,
    disableTray: flags.disableTray,
    demoNotifications: flags.demoNotifications,
    debugCrash: flags.debugCrash,
  } satisfies StartupFlags);

  if (flags.smoke) {
    // Headless end-to-end self test. See docs/DEVELOPMENT.md.
    const harness = new SmokeHarness({
      logger,
      settings,
      windowManager,
      notificationManager,
      notificationService,
      unread,
      dnd,
      trayManager,
      notificationDumpPath,
      quit: async (reason) => await lifecycle.quit(reason),
    });
    runDetached(async () => await harness.run(), { label: 'smoke harness', logger });
  }

  if (flags.demoNotifications) {
    runDetached(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        notificationManager.previewNotification();
        notificationManager.previewNotification({ body: 'Second message in the same chat', timestamp: Date.now() + 1 });
        logger.info('demo notifications queued');
      },
      { label: 'demo notifications', logger },
    );
  }

  // A logout or `kill` must still unregister the global shortcut; SIGTERM is the
  // only signal a desktop session sends, and Electron has no hook for it.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      runDetached(async () => await lifecycle.quit(EXIT_REASON.quitSignal), { label: signal, logger });
    });
  }

  logger.info('composition complete', {
    settings: settingsPath,
    partition: WHATSAPP_PARTITION,
    iconDir,
    dumpFile: notificationDumpPath,
  });
}

main();
