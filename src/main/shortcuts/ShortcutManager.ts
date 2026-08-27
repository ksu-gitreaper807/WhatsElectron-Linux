/**
 * Global shortcut: registration, re-registration and honest failure reporting.
 *
 * `globalShortcut.register()` fails by returning `false` when another client
 * already owns the combination. There is no error object, so the only useful
 * behaviour is: report it to the user, keep the application fully functional,
 * and let them pick another combination in Settings. A failure to register a
 * convenience shortcut must never block startup.
 */

import { globalShortcut } from 'electron';

import { isValidAccelerator } from '../../shared/settings.js';
import type { Logger } from '../lib/logger.js';
import type { SettingsService } from '../settings/SettingsService.js';

export interface ShortcutManagerDeps {
  readonly logger: Logger;
  readonly settings: SettingsService;
  readonly toggle: () => void;
  /** Fired after any successful activation (diagnostics, tests). */
  readonly onTrigger?: (accelerator: string) => void;
  readonly notifyUnavailable?: (accelerator: string, reason: string) => void;
}

export interface ShortcutState {
  readonly registered: boolean;
  readonly accelerator: string;
  readonly error: string | null;
  readonly enabled: boolean;
}

export class ShortcutManager {
  readonly #deps: ShortcutManagerDeps;
  readonly #logger: Logger;
  #registered: string | null = null;
  #error: string | null = null;
  #unsubscribe: (() => void) | null = null;
  #busy = false;

  constructor(deps: ShortcutManagerDeps) {
    this.#deps = deps;
    this.#logger = deps.logger.child('shortcuts');
  }

  /**
   * Register the configured shortcut. Returns human readable notes that the
   * caller can surface (used verbatim by the settings window and the log).
   */
  async apply(): Promise<readonly string[]> {
    const notes: string[] = [];
    const settings = this.#deps.settings.settings;
    const accelerator = settings.globalShortcut;
    const enabled = settings.globalShortcutEnabled && accelerator.length > 0;

    // Always unregister first: registering a second accelerator while the old
    // one is live would leave a stale binding behind.
    this.#unregisterCurrent();

    if (!enabled) {
      this.#error = accelerator.length === 0 ? 'no accelerator configured' : null;
      this.#logger.debug('global shortcut disabled by settings', { enabled: settings.globalShortcutEnabled });
      return notes;
    }

    if (!isValidAccelerator(accelerator)) {
      this.#error = `"${accelerator}" is not a valid accelerator`;
      notes.push(this.#error);
      this.#logger.warn('refusing to register an invalid accelerator', { accelerator });
      return notes;
    }

    if (process.platform === 'linux' && !hasDisplay()) {
      this.#error = 'no X11/Wayland display: global shortcuts are unavailable';
      this.#logger.warn(this.#error);
      notes.push(this.#error);
      return notes;
    }

    try {
      const ok = globalShortcut.register(accelerator, () => {
        this.#logger.debug('global shortcut triggered', { accelerator });
        try {
          this.#deps.onTrigger?.(accelerator);
          this.#deps.toggle();
        } catch (error: unknown) {
          this.#logger.error('shortcut handler threw', error);
        }
      });
      if (!ok) {
        this.#error = `${accelerator} is already used by another application`;
        notes.push(
          `${this.#error}. Pick another combination in Settings, or free it with e.g. "xdotool key --clearmodifiers" / your DE's keyboard settings.`,
        );
        this.#deps.notifyUnavailable?.(accelerator, this.#error);
        this.#logger.warn('global shortcut registration failed', { accelerator });
        return notes;
      }
      this.#registered = accelerator;
      this.#error = null;
      this.#logger.info('global shortcut registered', { accelerator });
    } catch (error: unknown) {
      this.#error = error instanceof Error ? error.message : String(error);
      notes.push(`global shortcut failed: ${this.#error}`);
      this.#logger.error('global shortcut registration threw', error);
    }
    return notes;
  }

  /** Follow settings changes, and run once at startup after the store loads. */
  start(): void {
    if (this.#unsubscribe !== null) return;
    const handler = async (): Promise<readonly string[]> => {
      if (this.#busy) return [];
      this.#busy = true;
      try {
        return await this.apply();
      } finally {
        this.#busy = false;
      }
    };
    const offShortcut = this.#deps.settings.onKey('globalShortcut', handler);
    const offEnabled = this.#deps.settings.onKey('globalShortcutEnabled', handler);
    this.#unsubscribe = () => {
      offShortcut();
      offEnabled();
      this.#unsubscribe = null;
    };
  }

  #unregisterCurrent(): void {
    if (this.#registered === null) return;
    try {
      globalShortcut.unregister(this.#registered);
      this.#logger.debug('global shortcut unregistered', { accelerator: this.#registered });
    } catch (error: unknown) {
      this.#logger.warn('could not unregister the global shortcut', { error: String(error) });
    }
    this.#registered = null;
  }

  /**
   * Explicitly try a candidate accelerator (Settings "test" button). It is
   * registered and immediately released: the only reliable way to answer "is
   * this free?" before the user commits to it.
   */
  async probe(accelerator: string): Promise<{ readonly ok: boolean; readonly error: string | null }> {
    if (!isValidAccelerator(accelerator)) return { ok: false, error: 'not a valid accelerator' };
    if (accelerator === this.#registered) return { ok: true, error: null };
    try {
      const ok = globalShortcut.register(accelerator, () => undefined);
      if (ok) globalShortcut.unregister(accelerator);
      return { ok, error: ok ? null : `${accelerator} is taken by another application` };
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  get state(): ShortcutState {
    return {
      registered: this.#registered !== null,
      accelerator: this.#registered ?? this.#deps.settings.get('globalShortcut'),
      error: this.#error,
      enabled: this.#deps.settings.get('globalShortcutEnabled'),
    };
  }

  /** Mandatory on shutdown: a leaked binding would block the key for the user. */
  dispose(): void {
    this.#unsubscribe?.();
    this.#unregisterCurrent();
    try {
      globalShortcut.unregisterAll();
    } catch (error: unknown) {
      this.#logger.warn('globalShortcut.unregisterAll() failed', { error: String(error) });
    }
  }
}

function hasDisplay(): boolean {
  return typeof process.env['DISPLAY'] === 'string' || typeof process.env['WAYLAND_DISPLAY'] === 'string';
}
