/**
 * SettingsService: validated, observable, persistent preferences.
 *
 * Rules:
 *  - every value that leaves or enters the service is validated against the
 *    shared schema (a corrupt or hand edited file can never crash the app),
 *  - side effects (re-registering a shortcut, rewriting the autostart file,
 *    rebuilding the tray menu) are *registered by* the components that own them;
 *    this module never imports them,
 *  - a failed write never loses the in-memory state, it only warns.
 */

import { DEFAULT_SETTINGS, SETTING_FIELD_BY_KEY, mergeSettings, validateSettings } from '../../shared/settings.js';
import type { AppSettings, SettingField, SettingsPatch, SettingsUpdateResult } from '../../shared/types.js';
import type { Logger } from '../lib/logger.js';
import { TypedEmitter, type EventMap } from '../lib/typedEmitter.js';
import type { SettingsStore } from './SettingsStore.js';

export interface SettingsChangedPayload {
  readonly changes: Partial<AppSettings>;
  readonly settings: Readonly<AppSettings>;
}

export interface SettingsEventMap extends EventMap {
  changed: SettingsChangedPayload;
  failed: { readonly operation: string; readonly message: string };
}

/** Keys of `AppSettings` whose value is a boolean. */
export type BooleanKeysOf<T> = {
  [K in keyof T]-?: T[K] extends boolean ? K : never;
}[keyof T];

/** Coerce a side effect's return value into printable notes. */
function toNotes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export type SideEffect = (
  next: Readonly<AppSettings>,
  previous: Readonly<AppSettings>,
  changedKeys: readonly (keyof AppSettings)[],
) => Promise<readonly string[]> | readonly string[] | void;

export interface SettingsServiceOptions {
  readonly store: SettingsStore;
  readonly logger: Logger;
  /** Override the defaults, e.g. from command line flags in a demo run. */
  readonly overrides?: Partial<AppSettings>;
}

export class SettingsService extends TypedEmitter<SettingsEventMap> {
  readonly #store: SettingsStore;
  readonly #logger: Logger;
  readonly #sideEffects = new Map<keyof AppSettings, Set<SideEffect>>();
  #settings: Readonly<AppSettings>;
  #loaded = false;
  #writeFailing = false;

  constructor(options: SettingsServiceOptions) {
    super();
    this.#store = options.store;
    this.#logger = options.logger;
    this.#settings = mergeSettings(DEFAULT_SETTINGS, options.overrides ?? {});
  }

  get settings(): Readonly<AppSettings> {
    return this.#settings;
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  get location(): string {
    return this.#store.location;
  }

  /** True once a persist attempt failed; surfaced in the status view. */
  get persistenceDegraded(): boolean {
    return this.#writeFailing;
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.#settings[key];
  }

  describe(key: keyof AppSettings): SettingField | undefined {
    return SETTING_FIELD_BY_KEY.get(key);
  }

  /** Read, validate, migrate and publish. Called exactly once during startup. */
  async load(): Promise<void> {
    let raw: Record<string, unknown>;
    try {
      raw = await this.#store.read();
    } catch (error: unknown) {
      this.#logger.error('settings load failed, falling back to defaults', error);
      this.#settings = mergeSettings(DEFAULT_SETTINGS, {});
      this.#loaded = true;
      return;
    }

    const { value, issues } = validateSettings(raw, DEFAULT_SETTINGS);
    for (const issue of issues) {
      this.#logger.warn('ignored invalid persisted setting', { key: issue.key, reason: issue.message });
    }
    this.#settings = Object.freeze(mergeSettings(this.#settings, value));
    this.#loaded = true;
    this.#logger.info('settings loaded', {
      source: this.#store.location,
      keys: Object.keys(value).length,
      issues: issues.length,
    });
    this.emit('changed', { changes: value, settings: this.#settings });
  }

  /** Validate a patch without applying it (used by the settings window). */
  validate(patch: unknown): SettingsUpdateResult {
    const { value, issues } = validateSettings(patch, this.#settings);
    const rejected: Record<string, string> = {};
    for (const issue of issues) rejected[issue.key] = issue.message;
    return {
      applied: value,
      rejected,
      settings: mergeSettings(this.#settings, value),
      notes: [],
    };
  }

  /** Validate, persist, run side effects and broadcast. */
  async update(patch: SettingsPatch | Record<string, unknown>): Promise<SettingsUpdateResult> {
    const { value: applied, issues } = validateSettings(patch, this.#settings);
    const rejected: Record<string, string> = {};
    for (const issue of issues) rejected[issue.key] = issue.message;

    const changedKeys = Object.keys(applied) as (keyof AppSettings)[];
    const notes: string[] = [];
    const previous = this.#settings;

    if (changedKeys.length === 0) {
      return { applied: {}, rejected, settings: previous, notes };
    }

    const next = Object.freeze(mergeSettings(previous, applied));
    this.#settings = next;

    // 1. persist first: if the write fails we keep the in-memory value (the UI
    //    must not lie about what it is currently doing) but we tell the user.
    try {
      await this.#store.write({ ...next });
      this.#writeFailing = false;
    } catch (error: unknown) {
      this.#writeFailing = true;
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`settings could not be saved (${message}); they apply to this session only`);
      this.emit('failed', { operation: 'write', message });
    }

    // 2. then side effects, each isolated from the others.
    for (const key of changedKeys) {
      const handlers = this.#sideEffects.get(key);
      if (!handlers || handlers.size === 0) continue;
      for (const handler of handlers) {
        try {
          notes.push(...toNotes(await handler(next, previous, changedKeys)));
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.#logger.error(`settings side effect failed for "${key}"`, error);
          notes.push(`${String(key)}: ${message}`);
          this.emit('failed', { operation: `side-effect:${String(key)}`, message });
        }
      }
    }

    this.#logger.info('settings changed', { keys: changedKeys, persisted: !this.#writeFailing });
    this.emit('changed', { changes: applied, settings: next });

    return { applied, rejected, settings: next, notes };
  }

  /** Convenience wrapper for single key writes (tray toggles, DND, ...). */
  async set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<SettingsUpdateResult> {
    return this.update({ [key]: value });
  }

  async toggle<K extends BooleanKeysOf<AppSettings>>(key: K): Promise<SettingsUpdateResult> {
    return this.set(key, !this.#settings[key]);
  }

  /** Restore defaults for one key, or for everything. */
  async reset(key?: keyof AppSettings): Promise<SettingsUpdateResult> {
    if (key === undefined) return this.update({ ...DEFAULT_SETTINGS });
    return this.update({ [key]: DEFAULT_SETTINGS[key] });
  }

  /** Register a component that must react to a key. Returns an unregister fn. */
  onKey(key: keyof AppSettings, handler: SideEffect): () => void {
    let set = this.#sideEffects.get(key);
    if (!set) {
      set = new Set();
      this.#sideEffects.set(key, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  /** Run all side effects for the current values (used once at startup). */
  async applyAll(): Promise<readonly string[]> {
    const notes: string[] = [];
    const keys = [...this.#sideEffects.keys()];
    for (const key of keys) {
      const handlers = this.#sideEffects.get(key);
      if (!handlers) continue;
      for (const handler of handlers) {
        try {
          notes.push(...toNotes(await handler(this.#settings, this.#settings, [key])));
        } catch (error: unknown) {
          this.#logger.error(`settings apply failed for "${String(key)}"`, error);
          notes.push(`${String(key)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return notes;
  }
}

export { DEFAULT_SETTINGS };
