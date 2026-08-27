/**
 * Types shared by every layer of the application.
 *
 * IMPORTANT: nothing here may reference Electron types. `src/shared` is
 * compiled into the main process, both preloads and the settings renderer, so
 * a stray `import { BrowserWindow } from 'electron'` would break the browser
 * build. Domain types are therefore declared structurally.
 */

import type { NotificationBackendName, SessionStateName, UserAgentModeName } from './constants.js';

/* -------------------------------------------------------------------------- */
/* Signals coming from the WhatsApp Web page                                    */
/* -------------------------------------------------------------------------- */

/**
 * A notification candidate as produced by the (read only) detection script
 * running in the WhatsApp Web renderer.
 *
 * `body` is *untrusted content* coming out of a web page: every consumer must
 * treat it as data, never as markup, and must clamp its length.
 */
export interface DetectedMessage {
  /** Unique id generated inside the detection script; used for dedupe. */
  readonly id: string;
  /** Stable chat identifier (best effort, derived from the DOM). */
  readonly chatId: string;
  /** Chat or group name, if it could be read. */
  readonly chatName: string;
  /** Message author, if it could be read (usually only set in groups). */
  readonly senderName: string | null;
  /** True when the chat looks like a group. */
  readonly isGroup: boolean;
  /** Message preview text (already clamped by the sender, re-clamped here). */
  readonly body: string;
  /** True if the notification looked like a media/message attachment. */
  readonly hasMedia: boolean;
  /** Wall clock time at detection (client clock, ms since epoch). */
  readonly timestamp: number;
  /** Which signal produced this event. */
  readonly source: MessageSource;
  /** Unread counter as reported by the document title, when available. */
  readonly titleUnreadCount: number | null;
}

export type MessageSource = 'dom-notification' | 'title' | 'store';

/** Coarse login state, derived from the URL only. */
export interface SessionStateReport {
  readonly state: SessionStateName;
  readonly url: string;
  readonly at: number;
  /** Unread counter read from the document title, when the page exposes one. */
  readonly titleUnreadCount: number | null;
  /** True when the injected detector answered its handshake. */
  readonly detectorInstalled: boolean | null;
}

/* -------------------------------------------------------------------------- */
/* Notification manager                                                         */
/* -------------------------------------------------------------------------- */

export type NotificationStatus =
  /** queued, waiting for the grouping window to elapse */
  | 'pending'
  /** handed over to a backend (or about to be) */
  | 'delivered'
  /** not delivered because DND / focus / settings suppressed it */
  | 'suppressed'
  /** the backend refused or failed to deliver */
  | 'failed'
  /** removed by the expiry timer without ever being re-rendered */
  | 'expired';

/** Everything the notification manager tracks about one *group*. */
export interface NotificationGroup {
  /** Group key, normally `chat:<chatId>` or `sender:<chatName>`. */
  readonly key: string;
  readonly chatId: string;
  readonly chatName: string;
  readonly isGroup: boolean;
  /** Author of the most recent message in the group. */
  readonly senderName: string | null;
  /** Preview of the most recent message. */
  readonly preview: string;
  readonly firstAt: number;
  readonly lastAt: number;
  /** Number of messages accumulated in this group. */
  readonly count: number;
  readonly hasMedia: boolean;
  readonly status: NotificationStatus;
  /** Opaque id returned by the backend, used to replace/close in place. */
  readonly backendId: string | null;
  /** Id of the *rendered* notification (differs from `key` when re-rendered). */
  readonly renderedId: string | null;
}

/** Public, UI safe view of the notification queue. */
export interface NotificationQueueSnapshot {
  readonly groups: readonly NotificationGroup[];
  readonly totalMessages: number;
  readonly suppressed: number;
  readonly delivered: number;
  readonly failed: number;
  readonly groupingIntervalMs: number;
  readonly expireAfterMs: number;
}

/** Payload attached to a notification so a click can be routed back. */
export interface NotificationClickPayload {
  readonly chatId: string;
  readonly chatName: string;
  readonly groupKey: string;
  /** True when the payload comes from a click (vs. an action). */
  readonly activation: 'click' | 'action' | 'unknown';
}

/* -------------------------------------------------------------------------- */
/* Notification backend contract                                               */
/* -------------------------------------------------------------------------- */

export type NotificationUrgency = 'low' | 'normal' | 'critical';

/**
 * The normalised notification every backend receives. Backends must not know
 * anything about WhatsApp, grouping or the unread counters.
 */
export interface AppNotification {
  /** Stable id per group; backends may use it to replace an existing one. */
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** Absolute path to a PNG icon, when one is available on disk. */
  readonly iconPath: string | null;
  readonly silent: boolean;
  readonly urgency: NotificationUrgency;
  /** 0 = let the server decide, -1 = never expire. */
  readonly expireTimeoutMs: number;
  /** freedesktop category hint, e.g. `im.received`. */
  readonly category: string | null;
  /** Buttons/actions, only honoured by backends that advertise support. */
  readonly actions: readonly NotificationAction[];
  /** Opaque data returned to us when the notification is activated. */
  readonly payload: NotificationClickPayload;
  /** Number of messages this notification represents (>= 1). */
  readonly count: number;
}

export interface NotificationAction {
  readonly id: string;
  readonly label: string;
}

export interface NotificationBackendCapabilities {
  readonly name: string;
  /** Backend can be used in this session at all. */
  readonly available: boolean;
  /** Backend delivers click/activation events back to us. */
  readonly clickEvents: boolean;
  readonly actions: boolean;
  readonly inPlaceGrouping: boolean;
  readonly silent: boolean;
  readonly urgency: boolean;
  /** Human readable reason for `available: false`. */
  readonly reason: string | null;
}

export interface ShowNotificationResult {
  readonly ok: boolean;
  readonly backend: string;
  /**
   * Id assigned by the backend itself (e.g. the freedesktop notification id).
   * The application always addresses notifications by `AppNotification.id`.
   */
  readonly nativeId: string | null;
  readonly error: string | null;
}

/* -------------------------------------------------------------------------- */
/* Unread badge                                                                */
/* -------------------------------------------------------------------------- */

export interface UnreadSnapshot {
  readonly count: number;
  readonly byChat: Readonly<Record<string, number>>;
  readonly source: UnreadSource;
  readonly updatedAt: number;
}

export type UnreadSource = 'notification' | 'title' | 'manual' | 'focus';

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export interface AppSettings {
  /** Launch the application when the desktop session starts. */
  readonly startOnLogin: boolean;
  /** Suppress native notification delivery (tracking keeps running). */
  readonly dndEnabled: boolean;
  /** Mirror the desktop environment's own DND state, when detectable. */
  readonly syncSystemDnd: boolean;
  /** Toggle the global shortcut on/off (the accelerator lives below). */
  readonly globalShortcutEnabled: boolean;
  /** Electron accelerator string, e.g. `Super+Shift+W`. */
  readonly globalShortcut: string;
  /** Aggregate notifications per chat instead of showing each one. */
  readonly groupingEnabled: boolean;
  /** How long a group is collected before it is rendered. */
  readonly groupingIntervalMs: number;
  /** Drop a group from the queue after this idle time (ms). */
  readonly expireAfterMs: number;
  /** Hide to tray instead of quitting when the last window closes. */
  readonly closeToTray: boolean;
  /** Also hide when the window is minimised. */
  readonly minimizeToTray: boolean;
  /** Show the message text in notifications (off = "New message"). */
  readonly showPreviews: boolean;
  /** Play the notification sound (best effort on Linux). */
  readonly playSound: boolean;
  /** Master switch for native notifications. */
  readonly notificationsEnabled: boolean;
  /** Reset the unread counter when the window gains focus. */
  readonly clearUnreadOnFocus: boolean;
  /** Grace period after focus during which notifications stay suppressed. */
  readonly focusQuietMs: number;
  /** Which notification backend to prefer. */
  readonly notificationBackend: NotificationBackendName;
  /**
   * Which browser identity to advertise to WhatsApp Web. `chrome` strips the
   * `Electron/` and `<app>/` tokens from the runtime UA (WhatsApp refuses to boot
   * when it sees them); `default` sends Electron's own UA; `custom` sends
   * `customUserAgent`.
   */
  readonly userAgentMode: UserAgentModeName;
  /** Raw UA string, only used when `userAgentMode` is `custom`. */
  readonly customUserAgent: string;
  /** Show a menu bar inside the WhatsApp window. */
  readonly showMenu: boolean;
  /** Show the unread counter in the window title. */
  readonly titleBadge: boolean;
}

/**
 * A write to the settings service. Explicit `undefined` is allowed and means
 * "ignore this key", which is what `exactOptionalPropertyTypes` would otherwise
 * forbid - and it is exactly how a settings UI naturally submits a form.
 */
export type SettingsPatch = {
  [K in keyof AppSettings]?: AppSettings[K] | undefined;
};

/** Settings plus everything a client may need to render a settings screen. */
export interface SettingsView {
  readonly settings: Readonly<AppSettings>;
  readonly status: RuntimeStatus;
  readonly schema: readonly SettingField[];
}

/** Field metadata used to generate the settings UI and to validate writes. */
export interface SettingField {
  readonly key: keyof AppSettings;
  readonly label: string;
  readonly type: 'boolean' | 'integer' | 'string' | 'enum' | 'accelerator';
  readonly description: string;
  readonly group: 'startup' | 'notifications' | 'shortcuts' | 'window' | 'advanced';
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly string[];
  readonly requiresRestart?: boolean;
  readonly platformOnly?: readonly NodeJS.Platform[];
  readonly default: AppSettings[keyof AppSettings];
}

/** Result of a `settings:update` round trip. */
export interface SettingsUpdateResult {
  readonly applied: Partial<AppSettings>;
  readonly rejected: Readonly<Record<string, string>>;
  readonly settings: Readonly<AppSettings>;
  /** Warnings that are not fatal, e.g. "shortcut registration failed". */
  readonly notes: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Runtime status                                                              */
/* -------------------------------------------------------------------------- */

export interface RuntimeStatus {
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly chromeVersion: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly desktopEnvironment: string;
  readonly sessionType: 'x11' | 'wayland' | 'unknown';
  readonly trayAvailable: boolean;
  readonly notificationBackend: string;
  readonly notificationBackends: readonly NotificationBackendCapabilities[];
  readonly dbusConnected: boolean;
  readonly unreadCount: number;
  readonly dndActive: boolean;
  readonly dndReason: string | null;
  readonly globalShortcutActive: boolean;
  readonly globalShortcutError: string | null;
  readonly sessionPartition: string;
  readonly userDataDir: string;
  readonly settingsPath: string;
  readonly startOnLoginActive: boolean;
  readonly autostartLocation: string;
  readonly globalShortcut: string;
  readonly sessionSizeBytes: number | null;
  readonly detectorInstalled: boolean;
  /** What the browser-identity override did (or why it refused to). */
  readonly browserIdentity: string | null;
  readonly unreadSource: string;
  readonly windowVisible: boolean;
  readonly sessionState: SessionStateName;
  readonly queue: NotificationQueueSnapshot;
}

/* -------------------------------------------------------------------------- */
/* IPC payloads                                                               */
/* -------------------------------------------------------------------------- */

export type IpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface AppStatePayload {
  readonly unread: UnreadSnapshot;
  readonly dnd: { readonly active: boolean; readonly reason: string | null };
  readonly visible: boolean;
  readonly sessionState: SessionStateName;
}

/** Command pushed to the WhatsApp Web contents (never raw DOM access). */
export interface NavigateCommand {
  readonly kind: 'open-chat';
  readonly chatId: string;
  readonly chatName: string;
  /** Monotonic id so repeated commands to the same chat still fire. */
  readonly nonce: number;
}
