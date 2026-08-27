/**
 * The settings schema: a single declarative description of every persisted
 * preference. Both the main process (validation, persistence) and the settings
 * window (UI generation, live validation) derive their behaviour from it, so a
 * new setting is added in exactly one place.
 */

import { NOTIFICATION_BACKENDS, RANGES, USER_AGENT_MODES } from './constants.js';
import type { AppSettings, SettingField, SettingsPatch } from './types.js';

/** Every default value, in one place. */
export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  startOnLogin: false,
  dndEnabled: false,
  syncSystemDnd: false,
  globalShortcutEnabled: true,
  globalShortcut: 'Ctrl+Shift+W',
  groupingEnabled: true,
  groupingIntervalMs: 5_000,
  expireAfterMs: 120_000,
  closeToTray: true,
  minimizeToTray: false,
  showPreviews: true,
  playSound: true,
  notificationsEnabled: true,
  clearUnreadOnFocus: true,
  focusQuietMs: 1_500,
  notificationBackend: NOTIFICATION_BACKENDS.auto,
  userAgentMode: USER_AGENT_MODES.chrome,
  customUserAgent: '',
  showMenu: false,
  titleBadge: true,
});

export const SETTING_FIELDS: readonly SettingField[] = Object.freeze([
  {
    key: 'startOnLogin',
    label: 'Start on login',
    type: 'boolean',
    description:
      'Launch WhatsApp Desktop automatically when you sign in to your desktop session (XDG autostart on Linux).',
    group: 'startup',
    default: DEFAULT_SETTINGS.startOnLogin,
  },
  {
    key: 'globalShortcutEnabled',
    label: 'Global shortcut enabled',
    type: 'boolean',
    description: 'Register a system wide key combination while the application runs.',
    group: 'shortcuts',
    default: DEFAULT_SETTINGS.globalShortcutEnabled,
  },
  {
    key: 'globalShortcut',
    label: 'Global shortcut',
    type: 'accelerator',
    description: 'Toggles window visibility. Uses the Electron accelerator syntax, e.g. Ctrl+Shift+W, Super+Alt+W.',
    group: 'shortcuts',
    default: DEFAULT_SETTINGS.globalShortcut,
  },
  {
    key: 'notificationsEnabled',
    label: 'Desktop notifications',
    type: 'boolean',
    description: 'Forward WhatsApp Web notifications to the Linux notification daemon.',
    group: 'notifications',
    default: DEFAULT_SETTINGS.notificationsEnabled,
  },
  {
    key: 'dndEnabled',
    label: 'Do not disturb',
    type: 'boolean',
    description: 'Suppresses notification delivery. Messages are still counted and stay in the queue.',
    group: 'notifications',
    default: DEFAULT_SETTINGS.dndEnabled,
  },
  {
    key: 'syncSystemDnd',
    label: 'Follow system Do Not Disturb',
    type: 'boolean',
    description:
      'Also stay quiet while the desktop environment reports DND / "Do not disturb" (XDG portal settings, when available).',
    group: 'notifications',
    default: DEFAULT_SETTINGS.syncSystemDnd,
  },
  {
    key: 'groupingEnabled',
    label: 'Group notifications per chat',
    type: 'boolean',
    description: 'Collect messages from the same chat and render one notification ("Alice: 3 new messages").',
    group: 'notifications',
    default: DEFAULT_SETTINGS.groupingEnabled,
  },
  {
    key: 'groupingIntervalMs',
    label: 'Grouping window (ms)',
    type: 'integer',
    description: 'How long messages are collected before a notification is rendered.',
    group: 'notifications',
    min: RANGES.groupingIntervalMs.min,
    max: RANGES.groupingIntervalMs.max,
    step: 250,
    default: DEFAULT_SETTINGS.groupingIntervalMs,
  },
  {
    key: 'expireAfterMs',
    label: 'Group retention (ms)',
    type: 'integer',
    description:
      'Idle time after which a group leaves the queue. Affects only the "N new messages" counter, never the unread badge.',
    group: 'notifications',
    min: RANGES.expireAfterMs.min,
    max: RANGES.expireAfterMs.max,
    step: 1_000,
    default: DEFAULT_SETTINGS.expireAfterMs,
  },
  {
    key: 'showPreviews',
    label: 'Show message previews',
    type: 'boolean',
    description: 'When disabled, notifications show only the chat name and the number of messages.',
    group: 'notifications',
    default: DEFAULT_SETTINGS.showPreviews,
  },
  {
    key: 'playSound',
    label: 'Play notification sound',
    type: 'boolean',
    description: 'Best effort on Linux: the notification daemon decides whether a sound is played.',
    group: 'notifications',
    default: DEFAULT_SETTINGS.playSound,
  },
  {
    key: 'closeToTray',
    label: 'Close button hides to tray',
    type: 'boolean',
    description:
      'Closing the window hides it to the system tray instead of quitting. Requires an available tray or dock.',
    group: 'window',
    default: DEFAULT_SETTINGS.closeToTray,
  },
  {
    key: 'minimizeToTray',
    label: 'Minimise hides to tray',
    type: 'boolean',
    description: 'Minimising the window also hides it to the tray.',
    group: 'window',
    default: DEFAULT_SETTINGS.minimizeToTray,
  },
  {
    key: 'clearUnreadOnFocus',
    label: 'Clear unread counter on focus',
    type: 'boolean',
    description: 'Reset the badge counter when the window is focused.',
    group: 'window',
    default: DEFAULT_SETTINGS.clearUnreadOnFocus,
  },
  {
    key: 'focusQuietMs',
    label: 'Quiet period after focus (ms)',
    type: 'integer',
    description: 'Skip native notifications for messages that arrive while you are looking at the window.',
    group: 'notifications',
    min: RANGES.focusClearDelayMs.min,
    max: RANGES.focusClearDelayMs.max,
    step: 250,
    default: DEFAULT_SETTINGS.focusQuietMs,
  },
  {
    key: 'titleBadge',
    label: 'Show unread counter in the title',
    type: 'boolean',
    description: 'Renders "WhatsApp (5)" in the window title and the tray tooltip.',
    group: 'window',
    default: DEFAULT_SETTINGS.titleBadge,
  },
  {
    key: 'showMenu',
    label: 'Show application menu',
    type: 'boolean',
    description: 'Show a menu bar inside the WhatsApp window (useful on tiling window managers).',
    group: 'window',
    requiresRestart: false,
    default: DEFAULT_SETTINGS.showMenu,
  },
  {
    key: 'userAgentMode',
    label: 'Browser identity sent to WhatsApp Web',
    type: 'enum',
    description:
      'WhatsApp Web refuses to start when it sees "Electron" in the User-Agent ("WhatsApp works with Google Chrome 100+"). "Chrome-styled" removes the Electron and application tokens from the UA that Chromium already sends - it changes no other property of the session. Use "Electron default" to turn it off, or "Custom" to provide the exact string.',
    group: 'advanced',
    options: Object.values(USER_AGENT_MODES),
    default: DEFAULT_SETTINGS.userAgentMode,
  },
  {
    key: 'customUserAgent',
    label: 'Custom User-Agent',
    type: 'string',
    description: 'Used only when the browser identity is set to "Custom". 16-512 characters, no control characters.',
    group: 'advanced',
    default: DEFAULT_SETTINGS.customUserAgent,
  },
  {
    key: 'notificationBackend',
    label: 'Notification backend',
    type: 'enum',
    description:
      'auto = prefer the Linux notification daemon over D-Bus, then fall back to Electron. Use "file" or "mock" for debugging.',
    group: 'advanced',
    options: Object.values(NOTIFICATION_BACKENDS),
    default: DEFAULT_SETTINGS.notificationBackend,
  },
]);

/** Field lookup by key. */
export const SETTING_FIELD_BY_KEY: ReadonlyMap<keyof AppSettings, SettingField> = new Map(
  SETTING_FIELDS.map((field) => [field.key, field] as const),
);

export interface ValidationIssue {
  readonly key: string;
  readonly message: string;
}

export interface SettingsValidationResult {
  readonly value: Partial<AppSettings>;
  readonly issues: readonly ValidationIssue[];
}

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

const isInteger = (input: unknown): input is number =>
  typeof input === 'number' && Number.isInteger(input) && Number.isFinite(input);

/**
 * Accelerator grammar, mirroring Electron's parser (see
 * docs/api/accelerator.md): one or more modifiers, then exactly one key.
 *
 * Deliberately a *restriction*, not a clone: the value is persisted and later
 * handed to `globalShortcut.register()`, so an obviously broken string is better
 * rejected here with a readable message than silently ignored by the OS.
 */
const MODIFIER = 'Command|Cmd|Control|Ctrl|Alt|Option|Shift|Super|Meta|CommandOrControl|CmdOrCtrl|AltGr|OptionOrAlt';
const SPECIAL_KEY =
  'Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Escape|Up|Down|Left|Right|Home|End|PageUp|PageDown|PrintScreen|MediaPlayPause|MediaNextTrack|MediaPreviousTrack|MediaStop|VolumeUp|VolumeDown|VolumeMute|F[1-9]|F1[0-9]|F2[0-4]';
const LITERAL_KEY = "[A-Za-z0-9=;,./+'`\\[\\]\\-\\*]";
const KEY = `(?:${SPECIAL_KEY}|${LITERAL_KEY})`;

// Case insensitive: Electron's own parser accepts "ctrl+shift+w", and the value
// round trips through a text input, so rejecting a lowercase spelling that the OS
// would happily accept would be a user-facing bug.
const ACCELERATOR_RE = new RegExp(`^(?:(?:${MODIFIER})\\+)*(?:${KEY})$`, 'i');
const HAS_MODIFIER_RE = new RegExp(`^(?:${MODIFIER})\\+`, 'i');

/** A valid accelerator: at least one modifier, so it cannot shadow plain typing. */
export function isValidAccelerator(input: unknown): boolean {
  if (typeof input !== 'string' || input.length === 0 || input.length > 64) return false;
  // Trim so "Ctrl + Shift + W" (as typed by a human) is accepted and normalised.
  const normalized = input.split(/\s+/).join('');
  return ACCELERATOR_RE.test(normalized) && HAS_MODIFIER_RE.test(normalized);
}

/**
 * Validate an arbitrary (partially unknown) object against the schema.
 * Unknown keys are reported, invalid values are dropped, never coerced
 * silently. This runs on every write, on load, and on every IPC patch.
 */
export function validateSettings(
  input: unknown,
  current: Readonly<AppSettings> = DEFAULT_SETTINGS,
): SettingsValidationResult {
  const out: Record<string, unknown> = {};
  const issues: ValidationIssue[] = [];

  if (input === undefined || input === null) {
    return { value: {}, issues: [{ key: '*', message: 'settings payload must be an object' }] };
  }
  if (!isRecord(input)) {
    return { value: {}, issues: [{ key: '*', message: 'settings payload must be an object' }] };
  }

  const seen = new Set<string>();
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const field = SETTING_FIELD_BY_KEY.get(rawKey as keyof AppSettings);
    if (!field) {
      issues.push({ key: rawKey, message: 'unknown setting' });
      continue;
    }
    seen.add(field.key);

    switch (field.type) {
      case 'boolean': {
        if (typeof rawValue !== 'boolean') {
          issues.push({ key: field.key, message: 'expected a boolean' });
          break;
        }
        out[field.key] = rawValue;
        break;
      }
      case 'integer': {
        if (!isInteger(rawValue)) {
          issues.push({ key: field.key, message: 'expected an integer' });
          break;
        }
        const min = field.min ?? Number.MIN_SAFE_INTEGER;
        const max = field.max ?? Number.MAX_SAFE_INTEGER;
        if (rawValue < min || rawValue > max) {
          issues.push({ key: field.key, message: `must be between ${min} and ${max}` });
          break;
        }
        out[field.key] = rawValue;
        break;
      }
      case 'enum': {
        if (typeof rawValue !== 'string' || !(field.options ?? []).includes(rawValue)) {
          issues.push({
            key: field.key,
            message: `must be one of: ${(field.options ?? []).join(', ')}`,
          });
          break;
        }
        out[field.key] = rawValue;
        break;
      }
      case 'accelerator': {
        if (rawValue === null || rawValue === '') {
          out[field.key] = '';
          break;
        }
        if (!isValidAccelerator(rawValue)) {
          issues.push({
            key: field.key,
            message: 'not a valid accelerator (a modifier such as Ctrl/Alt/Super is required)',
          });
          break;
        }
        out[field.key] = rawValue;
        break;
      }
      case 'string': {
        if (typeof rawValue !== 'string') {
          issues.push({ key: field.key, message: 'expected a string' });
          break;
        }
        out[field.key] = rawValue;
        break;
      }
      default: {
        const exhaustive: never = field.type;
        issues.push({ key: field.key, message: `unhandled field type ${String(exhaustive)}` });
      }
    }
  }

  // A "global shortcut" that is enabled must be a real accelerator.
  const shortcut = out['globalShortcut'] as string | undefined;
  const shortcutEnabled = out['globalShortcutEnabled'] as boolean | undefined;
  const effectiveShortcut = shortcut ?? current.globalShortcut;
  const effectiveEnabled = shortcutEnabled ?? current.globalShortcutEnabled;
  if (effectiveEnabled && effectiveShortcut !== '' && !isValidAccelerator(effectiveShortcut)) {
    issues.push({ key: 'globalShortcut', message: 'invalid accelerator while the shortcut is enabled' });
    delete out['globalShortcut'];
  }

  return { value: out, issues };
}

/** Merge a validated patch over the defaults (used on load and on reset). */
export function mergeSettings(current: Readonly<AppSettings>, patch: SettingsPatch): Readonly<AppSettings> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value;
  }
  return Object.freeze(next as unknown as AppSettings);
}

/** Fill in defaults for anything missing, then freeze. Used after load. */
export function normalizeSettings(input: unknown): Readonly<AppSettings> {
  const validated = validateSettings(isRecord(input) ? input : {});
  return mergeSettings(DEFAULT_SETTINGS, validated.value);
}
