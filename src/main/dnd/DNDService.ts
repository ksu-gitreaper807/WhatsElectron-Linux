/**
 * Do Not Disturb.
 *
 * Two independent inputs are OR-ed together:
 *   - the user's own switch (persisted in settings, toggled from the tray),
 *   - an optional system-wide source (a `DndSource` implementation: the XDG
 *     portal settings today, MPRP/mediaplayer or GNOME's own DND tomorrow),
 *   - a temporary snooze, which survives neither a restart nor `disable()`.
 *
 * The rest of the application only ever asks `isEnabled()`. It never learns who
 * decided, which is what keeps the notification pipeline free of `if (tray)`
 * style conditionals.
 */

import { TypedEmitter, type EventMap } from '../lib/typedEmitter.js';
import type { Logger } from '../lib/logger.js';
import type { SettingsService } from '../settings/SettingsService.js';
import type { DndState } from './types.js';

export type DndReason = 'user' | 'system' | 'snooze' | null;

export interface DndEvents extends EventMap {
  changed: DndState;
}

/**
 * The only contract a system integration has to satisfy. Implementations must
 * be push-based (`onChanged`) *and* pull-based (`read`), because at startup we
 * need the current state immediately, and later we must react to changes.
 */
export interface DndSource {
  readonly name: string;
  /** Resolve with the current system state, or null when not detectable. */
  read(): Promise<boolean | null>;
  /** Subscribe to changes. Return the unsubscribe function. */
  subscribe(onChange: (enabled: boolean) => void): () => void;
  dispose(): void;
  readonly canWrite: boolean;
  /** Only called when `canWrite` is true and mirroring is enabled. */
  write?(enabled: boolean): Promise<void>;
}

/** No system integration (the default, and what macOS/Windows use). */
export class NullDndSource implements DndSource {
  readonly name = 'none';
  readonly canWrite = false;
  async read(): Promise<boolean | null> {
    return null;
  }
  subscribe(): () => void {
    return () => undefined;
  }
  dispose(): void {
    /* nothing to do */
  }
}

export interface DNDServiceOptions {
  readonly settings: SettingsService;
  readonly logger: Logger;
  readonly source?: DndSource;
  readonly clock?: () => number;
}

export class DNDService extends TypedEmitter<DndEvents> {
  readonly #settings: SettingsService;
  readonly #logger: Logger;
  readonly #clock: () => number;
  #source: DndSource;
  #systemEnabled = false;
  #systemKnown = false;
  #snoozeUntil = 0;
  #snoozeTimer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribeSource: (() => void) | null = null;
  #unsubscribeSettings: (() => void) | null = null;

  constructor(options: DNDServiceOptions) {
    super();
    this.#settings = options.settings;
    this.#logger = options.logger.child('dnd');
    this.#clock = options.clock ?? (() => Date.now());
    this.#source = options.source ?? new NullDndSource();
  }

  /** Wire the settings + system listeners. Called once during startup. */
  start(): void {
    this.#unsubscribeSettings = this.#settings.onKey('dndEnabled', () => {
      this.#recompute('settings');
      return [];
    });
    this.#unsubscribeSource = this.#source.subscribe((enabled) => {
      if (enabled === this.#systemEnabled) return;
      this.#systemEnabled = enabled;
      this.#systemKnown = true;
      this.#recompute('system');
    });
    void this.refresh();
  }

  /** Replace the system integration at runtime (tests, future re-detection). */
  setSource(source: DndSource): void {
    this.#unsubscribeSource?.();
    this.#source.dispose();
    this.#source = source;
    this.#systemEnabled = false;
    this.#systemKnown = false;
    this.#unsubscribeSource = source.subscribe((enabled) => {
      this.#systemEnabled = enabled;
      this.#systemKnown = true;
      this.#recompute('system');
    });
    void this.refresh();
  }

  isEnabled(): boolean {
    return this.state().active;
  }

  get active(): boolean {
    return this.state().active;
  }

  state(): DndState {
    const now = this.#clock();
    const snoozed = this.#snoozeUntil > now;
    const user = this.#settings.get('dndEnabled');
    const system = this.#settings.get('syncSystemDnd') && this.#systemKnown ? this.#systemEnabled : false;
    const active = user || system || snoozed;
    const reason: DndReason = user ? 'user' : system ? 'system' : snoozed ? 'snooze' : null;
    return {
      active,
      reason,
      user,
      system: this.#systemKnown ? this.#systemEnabled : null,
      snoozeUntil: snoozed ? this.#snoozeUntil : null,
    };
  }

  describe(): string {
    const state = this.state();
    if (!state.active) return 'off';
    switch (state.reason) {
      case 'user':
        return 'on (you turned it on)';
      case 'system':
        return `on (the desktop is in Do Not Disturb: ${this.#source.name})`;
      case 'snooze':
        return `snoozed until ${new Date(state.snoozeUntil ?? 0).toLocaleTimeString()}`;
      default:
        return 'on';
    }
  }

  /** Persist the user switch. Notifications stay suppressed, tracking continues. */
  async enable(): Promise<void> {
    if (this.#settings.get('dndEnabled')) return;
    await this.#settings.set('dndEnabled', true);
    // `onKey('dndEnabled')` already recomputed; belt and braces for callers
    // that write settings through a different store implementation.
    this.#recompute('enable');
    this.#logger.info('do not disturb enabled');
  }

  async disable(): Promise<void> {
    this.#clearSnoozeTimer();
    this.#snoozeUntil = 0;
    if (this.#settings.get('dndEnabled')) await this.#settings.set('dndEnabled', false);
    this.#recompute('disable');
    this.#logger.info('do not disturb disabled');
  }

  async toggle(): Promise<DndState> {
    if (this.#settings.get('dndEnabled')) await this.disable();
    else await this.enable();
    return this.state();
  }

  /** Temporary silence that never touches the persisted switch. */
  snooze(minutes: number): DndState {
    const amount = Number.isFinite(minutes) ? Math.max(1, Math.min(24 * 60, Math.round(minutes))) : 15;
    this.#snoozeUntil = this.#clock() + amount * 60_000;
    this.#clearSnoozeTimer();
    this.#snoozeTimer = setTimeout(() => {
      this.#snoozeTimer = null;
      this.#snoozeUntil = 0;
      this.#recompute('snooze-expired');
    }, amount * 60_000);
    // A timer must not hold the event loop open; quitting should not be delayed.
    this.#snoozeTimer.unref?.();
    this.#logger.info('notifications snoozed', { minutes: amount });
    return this.#recompute('snooze');
  }

  clearSnooze(): DndState {
    this.#clearSnoozeTimer();
    this.#snoozeUntil = 0;
    return this.#recompute('clear-snooze');
  }

  /** Pull the current state from the system source once. */
  async refresh(): Promise<void> {
    if (!this.#settings.get('syncSystemDnd')) return;
    try {
      const value = await this.#source.read();
      if (value === null) {
        this.#systemKnown = false;
        this.#recompute('refresh-unknown');
        return;
      }
      this.#systemEnabled = value;
      this.#systemKnown = true;
      this.#recompute('refresh');
    } catch (error: unknown) {
      this.#logger.debug('system DND probe failed', { error: String(error) });
      this.#systemKnown = false;
    }
  }

  #clearSnoozeTimer(): void {
    if (this.#snoozeTimer !== null) {
      clearTimeout(this.#snoozeTimer);
      this.#snoozeTimer = null;
    }
  }

  #recompute(cause: string): DndState {
    const state = this.state();
    this.emit('changed', state);
    this.#logger.debug('DND state recomputed', { cause, active: state.active, reason: state.reason });
    return state;
  }

  dispose(): void {
    this.#clearSnoozeTimer();
    this.#unsubscribeSettings?.();
    this.#unsubscribeSource?.();
    this.#source.dispose();
    this.removeAllListeners();
  }
}
