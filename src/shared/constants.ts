/**
 * Constants shared by the main process, the preloads and the settings renderer.
 *
 * Nothing in `src/shared` may import from `electron` or from any other runtime
 * environment: it is the only layer that is compiled into *every* build target,
 * so it has to stay dependency free and side-effect free.
 */

/** Human readable product name (also used as the notification app name). */
export const APP_NAME = 'WhatsApp Desktop';

/** Short name used in window titles and notification titles. */
export const APP_SHORT_NAME = 'WhatsApp';

/**
 * Application identifier. Used for the freedesktop `.desktop` file name, the
 * `WM_CLASS` hint, `desktop-entry` notification hint and the autostart file
 * name. Changing this *after* the first launch makes the desktop environment
 * treat the app as a new program, so it is intentionally not user configurable.
 */
export const APP_ID = 'com.whatsappdesktop.app';

/** npm-style package name, used for `app.setName()` and the userData folder. */
export const APP_PACKAGE_NAME = 'whatsapp-desktop';

/**
 * Base name of the installed desktop entry (`whatsapp-desktop.desktop`) and
 * therefore of the icon name in the theme. electron-builder derives it from
 * `linux.executableName`, and three separate things must agree with it:
 *  - `app.setDesktopName()` (Electron 44 associates the LauncherEntry badge and
 *    the notification/portal identity with the `.desktop` file),
 *  - the `desktop-entry` hint we send to the notification daemon,
 *  - `Icon=` in the autostart entry and `StartupWMClass`.
 * Keeping it as one constant is what stops "my notifications have a generic
 * icon" from being a mystery.
 */
export const DESKTOP_FILE_NAME = APP_PACKAGE_NAME;

/** What the notification daemon should call us (`app_name` in the Notify call). */
export const NOTIFICATION_APP_NAME = APP_SHORT_NAME;

/**
 * The one and only remote content this application loads. Any navigation
 * outside of `WHATSAPP_ORIGIN` is either rewritten to `deny` or delegated to
 * the user's default browser.
 */
export const WHATSAPP_URL = 'https://web.whatsapp.com/';
export const WHATSAPP_ORIGIN = 'https://web.whatsapp.com';
export const WHATSAPP_HOST = 'web.whatsapp.com';

/** Allowed hosts that WhatsApp Web legitimately navigates/opens. */
export const ALLOWED_HOSTS: readonly string[] = Object.freeze([
  WHATSAPP_HOST,
  'web.whatsapp.com',
  'sslclient.whatsapp.net',
  'mmg.whatsapp.net',
  'static.whatsapp.net',
  'register.whatsapp.com',
  'api.whatsapp.com',
  'wa.me',
  'whatsapp.com',
  'about:blank',
]);

/**
 * External hosts that are safe to open in the *default browser* instead of
 * being blocked outright.
 */
export const SAFE_EXTERNAL_HOSTS: readonly string[] = Object.freeze(['whatsapp.com', 'wa.me', 'paypal.me']);

/**
 * Persistent partition for the WhatsApp Web session. `persist:` keeps cookies,
 * localStorage, IndexedDB and the service worker registration under
 * `<userData>/Partitions/whatsapp`, which survives application updates because
 * userData is not part of the app bundle.
 */
export const WHATSAPP_PARTITION = 'persist:whatsapp';

/** Base window title before the unread counter is appended. */
export const WINDOW_TITLE_BASE = APP_SHORT_NAME;

/** Hard limits, all enforced again at IPC boundaries. */
export const LIMITS = Object.freeze({
  /** Maximum characters kept from a message body. */
  previewMaxChars: 240,
  /** Maximum characters for a notification title. */
  titleMaxChars: 90,
  /** Maximum characters for a chat/sender name. */
  nameMaxChars: 120,
  /** Maximum number of groups kept in the notification manager. */
  maxGroups: 40,
  /** Maximum number of individual messages remembered per group. */
  maxMessagesPerGroup: 200,
  /** Maximum number of remembered dedupe keys (sliding window). */
  dedupeCacheSize: 512,
  /** Upper bound for the unread counter shown in badges/titles. */
  maxUnread: 9_999,
  /** Badge counters above this are rendered as `99+`. */
  badgeSoftCap: 99,
  /** Maximum length of an accelerator string. */
  acceleratorMaxLen: 64,
  /** Maximum length of a free-form string arriving from a renderer. */
  stringMaxLen: 512,
});

/** Allowed range for user configurable timings (ms). */
export const RANGES = Object.freeze({
  groupingIntervalMs: { min: 500, max: 60_000 },
  expireAfterMs: { min: 5_000, max: 900_000 },
  focusClearDelayMs: { min: 0, max: 30_000 },
});

/** Presets offered by the settings UI for "snooze do-not-disturb". */
export const DND_SNOOZE_PRESET_MINUTES: readonly number[] = Object.freeze([5, 15, 30, 60, 240, 1_440]);

/** IPC channels. Single source of truth, referenced from every layer. */
export const IPC = Object.freeze({
  /** Renderer (WhatsApp Web preload) -> main, fire and forget. */
  whatsapp: Object.freeze({
    /** Detected message/notification candidate. */
    detected: 'wa:detected',
    /** Login/session state transitions. */
    session: 'wa:session',
    /** Non fatal renderer side error report. */
    rendererError: 'wa:renderer-error',
  }),
  /** Settings window <-> main. */
  settings: Object.freeze({
    getAll: 'settings:get-all',
    update: 'settings:update',
    reset: 'settings:reset',
    status: 'app:status',
    previewNotification: 'notifications:preview',
    clearUnread: 'unread:clear',
    showWhatsApp: 'window:show-whatsapp',
    quit: 'app:quit',
  }),
  /** main -> renderers. */
  events: Object.freeze({
    settingsChanged: 'settings:changed',
    stateChanged: 'app:state-changed',
    navigate: 'wa:navigate',
  }),
} as const);

/** Names of the internal (main process only) EventEmitter channels. */
export const EVENTS = Object.freeze({
  unreadChanged: 'unread:changed',
  dndChanged: 'dnd:changed',
  settingsChanged: 'settings:changed',
  visibilityChanged: 'window:visibility',
  notificationDelivered: 'notification:delivered',
  notificationSuppressed: 'notification:suppressed',
  trayStatusChanged: 'tray:status',
} as const);

/** Session state as observed from the outside (no WhatsApp internals used). */
export const SESSION_STATE = Object.freeze({
  unknown: 'unknown',
  loading: 'loading',
  loggedOut: 'logged-out',
  loggedIn: 'logged-in',
  error: 'error',
} as const);

export type SessionStateName = (typeof SESSION_STATE)[keyof typeof SESSION_STATE];

/** Browser identity presented to WhatsApp Web. */
export const USER_AGENT_MODES = Object.freeze({
  chrome: 'chrome',
  default: 'default',
  custom: 'custom',
} as const);

export type UserAgentModeName = (typeof USER_AGENT_MODES)[keyof typeof USER_AGENT_MODES];

/** Notification backends that can be selected through settings. */
export const NOTIFICATION_BACKENDS = Object.freeze({
  auto: 'auto',
  dbus: 'dbus',
  electron: 'electron',
  mock: 'mock',
  file: 'file',
} as const);

export type NotificationBackendName = (typeof NOTIFICATION_BACKENDS)[keyof typeof NOTIFICATION_BACKENDS];

/** Application exit reasons, used to keep `before-quit` logic honest. */
export const EXIT_REASON = Object.freeze({
  quitMenu: 'quit-menu',
  quitSignal: 'quit-signal',
  windowAllClosed: 'all-windows-closed',
  secondInstance: 'second-instance',
  fatal: 'fatal',
} as const);

/** File names below `userData`. */
export const PATHS = Object.freeze({
  settingsFile: 'settings.json',
  logDir: 'logs',
  logFile: 'main.jsonl',
  iconDir: 'icons',
  notificationDump: 'notifications.jsonl',
} as const);

/** Timeout used when waiting on a navigation that may never finish. */
export const TIMEOUTS = Object.freeze({
  navigationMs: 45_000,
  quitGraceMs: 400,
  dbusConnectMs: 2_500,
} as const);
