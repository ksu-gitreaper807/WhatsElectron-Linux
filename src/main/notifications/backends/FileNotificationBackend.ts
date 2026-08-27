/**
 * Append-only JSON lines backend.
 *
 * Two uses:
 *  1. `--demo-notifications` / CI smoke test: proves the detector -> manager ->
 *     backend pipeline produced the right payload without a notification daemon
 *     or a human looking at a screen. The smoke test greps this file.
 *  2. Support: "what did the app actually try to show?" is answerable from the
 *     data directory instead of from a screenshot.
 *
 * Never throws: a read-only filesystem simply means no dump.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type {
  AppNotification,
  NotificationBackendCapabilities,
  ShowNotificationResult,
} from '../../../shared/types.js';
import type { Logger } from '../../lib/logger.js';
import { NotificationBackendBase } from './INotificationBackend.js';

export interface FileNotificationBackendOptions {
  readonly filePath: string;
  readonly logger: Logger;
  readonly maxBytes?: number;
}

export class FileNotificationBackend extends NotificationBackendBase {
  readonly #filePath: string;
  readonly #logger: Logger;
  readonly #maxBytes: number;
  #dirReady = false;
  #broken = false;
  #written = 0;

  constructor(options: FileNotificationBackendOptions) {
    super('file');
    this.#filePath = options.filePath;
    this.#logger = options.logger.child('notifications.file');
    this.#maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  }

  get filePath(): string {
    return this.#filePath;
  }

  async isAvailable(): Promise<boolean> {
    return !this.#broken;
  }

  override async probe(): Promise<Omit<NotificationBackendCapabilities, 'name'>> {
    return {
      available: !this.#broken,
      clickEvents: false,
      actions: false,
      inPlaceGrouping: true,
      silent: true,
      urgency: true,
      reason: this.#broken ? 'dump file not writable' : null,
    };
  }

  async show(notification: AppNotification): Promise<ShowNotificationResult> {
    if (this.#broken) return this.failure('notification dump is disabled');
    if (this.#written > this.#maxBytes) {
      // Stop rather than fill the profile: this file is a debugging aid.
      this.#broken = true;
      this.#logger.warn('notification dump reached its size limit; disabling it', {
        limitBytes: this.#maxBytes,
        file: this.#filePath,
      });
      return this.failure('notification dump reached its size limit');
    }
    const record = {
      at: new Date().toISOString(),
      ...notification,
    };
    try {
      if (!this.#dirReady) {
        await mkdir(path.dirname(this.#filePath), { recursive: true });
        this.#dirReady = true;
      }
      const line = `${JSON.stringify(record)}\n`;
      await appendFile(this.#filePath, line, { encoding: 'utf8', mode: 0o600 });
      this.#written += Buffer.byteLength(line, 'utf8');
      return this.success(notification.id, `file-${Date.now()}`);
    } catch (error: unknown) {
      this.#broken = true;
      this.#logger.warn('could not write the notification dump', { error: String(error) });
      return this.failure(error instanceof Error ? error.message : String(error));
    }
  }

  async close(_id: string): Promise<void> {
    /* nothing to release */
  }

  async closeAll(): Promise<void> {
    /* nothing to release */
  }
}
