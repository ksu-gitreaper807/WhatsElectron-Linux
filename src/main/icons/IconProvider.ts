/**
 * Materialises rendered icons on disk.
 *
 * The freedesktop notification daemon wants either an icon *name* resolved from
 * the current theme or a path to an image file; it cannot receive a buffer. So
 * the PNGs produced by `IconRenderer` are written once into
 * `<userData>/icons/` and reused. Failures degrade to "no icon", never to a
 * crash, because a missing icon is cosmetic.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../lib/logger.js';
import { renderIcon } from './IconRenderer.js';
import { COLOR } from './png.js';

export interface IconProviderOptions {
  readonly directory: string;
  readonly logger: Logger;
  /**
   * Icon name from the theme (`hicolor` etc.) if a `.desktop` file is
   * installed; used in preference to a file path so the notification inherits
   * the user's icon theme.
   */
  readonly themeIconName?: string | null;
  readonly enabled?: boolean;
}

export interface IconPaths {
  readonly notification: string | null;
  readonly themeName: string | null;
  readonly directory: string;
}

export class IconProvider {
  readonly #options: IconProviderOptions;
  readonly #logger: Logger;
  #written = new Map<string, string>();
  #dirReady = false;
  #failed = false;

  constructor(options: IconProviderOptions) {
    this.#options = options;
    this.#logger = options.logger.child('icons');
  }

  /** Write the notification icon (64 px, no badge) and return usable paths. */
  async prepare(): Promise<IconPaths> {
    const themeName = this.#options.themeIconName ?? null;
    if (this.#options.enabled === false || this.#failed) {
      return { notification: null, themeName, directory: this.#options.directory };
    }
    const filePath = await this.#write('notification-64.png', renderIcon({ size: 64 }).png);
    return { notification: filePath, themeName, directory: this.#options.directory };
  }

  async #write(name: string, data: Buffer): Promise<string | null> {
    const cached = this.#written.get(name);
    if (cached) return cached;
    const filePath = path.join(this.#options.directory, name);
    try {
      if (!this.#dirReady) {
        await mkdir(this.#options.directory, { recursive: true });
        this.#dirReady = true;
      }
      // mode 0600: these are derived assets in the user's own profile, no need
      // to make them group readable.
      await writeFile(filePath, data, { mode: 0o600 });
      this.#written.set(name, filePath);
      return filePath;
    } catch (error: unknown) {
      this.#failed = true;
      this.#logger.warn('could not write generated icons; notifications will use the theme icon', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** A data URL for the tray: GTK takes an image object, no file needed. */
  trayDataUrl(size: number, badge: number | null, monochrome: boolean): string {
    return renderIcon({
      size,
      badge,
      ...(monochrome ? { background: COLOR.black, foreground: COLOR.white } : {}),
    }).dataUrl;
  }

  dispose(): void {
    this.#written.clear();
  }
}
