/**
 * Persistence layer for settings.
 *
 * The service depends on the `SettingsStore` interface only, so moving to
 * `gsettings`, a database, or a sync backend later is a one line change in the
 * composition root (`main.ts`).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../lib/logger.js';

export interface SettingsStore {
  /** Human readable location, surfaced in diagnostics. */
  readonly location: string;
  /** Raw persisted object (already JSON parsed). `{}` when absent/corrupt. */
  read(): Promise<Record<string, unknown>>;
  write(values: Record<string, unknown>): Promise<void>;
  close?(): Promise<void>;
}

/** Thrown details about a store level failure, never fatal by itself. */
export interface StoreFailure {
  readonly operation: 'read' | 'write';
  readonly message: string;
  readonly recovered: boolean;
}

export interface FileSettingsStoreOptions {
  readonly filePath: string;
  /** Wrapper schema version, distinct from the *settings* schema. */
  readonly schemaVersion?: number;
  readonly logger?: Logger | null;
  readonly onStoreFailure?: (failure: StoreFailure) => void;
}

/**
 * JSON file store with:
 *  - atomic writes (temp file + rename) so a crash cannot truncate settings,
 *  - corrupt-file recovery (the bad file is kept next to the original for
 *    bug reports, and defaults are used instead of refusing to start),
 *  - a small envelope so future migrations have somewhere to live.
 */
export class FileSettingsStore implements SettingsStore {
  readonly #filePath: string;
  readonly #schemaVersion: number;
  readonly #logger: FileSettingsStoreOptions['logger'];
  readonly #onFailure: FileSettingsStoreOptions['onStoreFailure'];
  #dirEnsured = false;

  constructor(options: FileSettingsStoreOptions) {
    this.#filePath = options.filePath;
    this.#schemaVersion = options.schemaVersion ?? 1;
    this.#logger = options.logger ?? null;
    this.#onFailure = options.onStoreFailure ?? undefined;
  }

  get location(): string {
    return this.#filePath;
  }

  async read(): Promise<Record<string, unknown>> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, 'utf8');
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.#fail('read', error, true);
      }
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      await this.#quarantine();
      this.#fail('read', error, true);
      return {};
    }

    const envelope = unwrap(parsed, this.#schemaVersion, this.#logger);
    if (envelope === null) {
      this.#fail('read', new Error('unrecognised settings envelope'), true);
      return {};
    }
    return envelope;
  }

  async write(values: Record<string, unknown>): Promise<void> {
    const envelope = {
      version: this.#schemaVersion,
      updatedAt: new Date().toISOString(),
      settings: values,
    };
    const json = `${JSON.stringify(envelope, null, 2)}\n`;
    try {
      if (!this.#dirEnsured) {
        await mkdir(path.dirname(this.#filePath), { recursive: true });
        this.#dirEnsured = true;
      }
      // Unique per write: two concurrent writes must not share a temp file.
      const tmp = `${this.#filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, json, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.#filePath);
    } catch (error: unknown) {
      this.#fail('write', error, false);
      throw error;
    }
  }

  async #quarantine(): Promise<void> {
    const target = `${this.#filePath}.corrupt-${Date.now()}`;
    try {
      await rename(this.#filePath, target);
      this.#logger?.warn('settings file was not valid JSON, kept for inspection', { target });
    } catch (error: unknown) {
      this.#logger?.error('could not quarantine corrupt settings file', error);
    }
  }

  #fail(operation: 'read' | 'write', error: unknown, recovered: boolean): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#logger?.error(`settings ${operation} failed`, error, { recovered });
    this.#onFailure?.({ operation, message, recovered });
  }
}

/**
 * Accepts both the envelope shape and a bare settings object, so a hand
 * written file (very common while developing) still works.
 */
function unwrap(
  parsed: unknown,
  expectedVersion: number,
  logger: FileSettingsStoreOptions['logger'],
): Record<string, unknown> | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if ('settings' in record && typeof record['settings'] === 'object' && record['settings'] !== null) {
    const version = record['version'];
    if (typeof version === 'number' && version > expectedVersion) {
      logger?.warn('settings file was written by a newer version', { version, expectedVersion });
    }
    return record['settings'] as Record<string, unknown>;
  }
  return record;
}

/** In memory store used by tests and by `--demo` runs. */
export class MemorySettingsStore implements SettingsStore {
  #values: Record<string, unknown>;
  public writeCount = 0;

  constructor(values: Record<string, unknown> = {}) {
    this.#values = { ...values };
  }

  get location(): string {
    return 'memory://settings';
  }

  async read(): Promise<Record<string, unknown>> {
    return { ...this.#values };
  }

  async write(values: Record<string, unknown>): Promise<void> {
    this.writeCount += 1;
    this.#values = { ...values };
  }
}

/** Read only store: used to simulate a read-only filesystem in tests. */
export class ReadOnlySettingsStore implements SettingsStore {
  constructor(
    private readonly values: Record<string, unknown> = {},
    private readonly error: Error = new Error('read-only file system'),
  ) {}

  get location(): string {
    return 'readonly://settings';
  }

  async read(): Promise<Record<string, unknown>> {
    return { ...this.values };
  }

  async write(): Promise<void> {
    throw this.error;
  }
}
