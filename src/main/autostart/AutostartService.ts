/**
 * Start on login.
 *
 * Electron exposes `app.setLoginItemSettings()` / `getLoginItemSettings()` for
 * exactly this - but they are documented `@platform darwin,win32`, i.e. there is
 * no Linux implementation and there cannot be a portable one. On Linux the
 * platform-specific path is a freedesktop autostart entry, implemented in
 * `AutostartBackends.ts` (filesystem only, no Electron, unit tested).
 *
 * Portal alternative: `org.freedesktop.portal.Background.RequestBackground` is
 * the sandbox-aware way, and the one a Flatpak build must use, because a direct
 * `~/.config` write is redirected or denied in that sandbox. Since the service
 * takes a backend, that switch is a few lines here and nothing else changes.
 */

import { app } from 'electron';

import type { Logger } from '../lib/logger.js';
import { XdgAutostartBackend, type AutostartBackend, type AutostartStatus } from './AutostartBackends.js';

export type { AutostartBackend, AutostartStatus } from './AutostartBackends.js';
export { NullAutostartBackend, XdgAutostartBackend } from './AutostartBackends.js';

/** macOS / Windows: Electron's own API, nothing written by hand. */
export class ElectronLoginItemBackend implements AutostartBackend {
  readonly name = 'electron-login-item';

  isSupported(): boolean {
    return process.platform === 'darwin' || process.platform === 'win32';
  }

  location(): string {
    return process.platform === 'darwin'
      ? 'System Settings > General > Login Items'
      : 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  }

  async read(): Promise<{ enabled: boolean; reason: string | null }> {
    if (!this.isSupported()) return { enabled: false, reason: 'unsupported platform' };
    try {
      const settings = app.getLoginItemSettings();
      return { enabled: settings.openAtLogin === true, reason: null };
    } catch (error: unknown) {
      return { enabled: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async write(enabled: boolean): Promise<void> {
    // Electron's API is a setter only: there is no distinct "remove", and
    // `openAsHidden` does not exist in Electron 44, so nothing else is passed.
    app.setLoginItemSettings({ openAtLogin: enabled });
  }
}

export interface AutostartServiceDeps {
  readonly logger: Logger;
  readonly backend: AutostartBackend;
}

export class AutostartService {
  readonly #logger: Logger;
  readonly #backend: AutostartBackend;
  /** The desired state, so a failed write is retried on the next change. */
  #desired: boolean | null = null;

  constructor(deps: AutostartServiceDeps) {
    this.#logger = deps.logger.child('autostart');
    this.#backend = deps.backend;
  }

  get backendName(): string {
    return this.#backend.name;
  }

  get location(): string {
    return this.#backend.location();
  }

  /**
   * Reconcile the persisted preference with reality - once at startup and after
   * every change. Returns notes for the caller and never throws: a failed
   * autostart write must not stop the application from starting, and must not
   * make the checkbox lie about the current session.
   */
  async sync(desired: boolean): Promise<readonly string[]> {
    this.#desired = desired;
    if (!this.#backend.isSupported()) {
      return desired ? ['start-on-login is not available on this platform; the preference was kept'] : [];
    }
    try {
      const current = await this.#backend.read();
      if (current.enabled === desired && current.reason === null) return [];
      await this.#backend.write(desired);
      this.#logger.info('autostart reconciled', {
        desired,
        was: current.enabled,
        reason: current.reason,
        backend: this.#backend.name,
      });
      return current.reason === null ? [] : [`start-on-login was repaired (${current.reason})`];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.error('could not update the autostart entry', error);
      return [`start-on-login could not be changed (${message})`];
    }
  }

  async status(): Promise<AutostartStatus> {
    const supported = this.#backend.isSupported();
    if (!supported) {
      return {
        supported: false,
        enabled: false,
        backend: this.#backend.name,
        location: this.#backend.location(),
        reason: 'no autostart integration on this platform',
      };
    }
    try {
      const read = await this.#backend.read();
      return {
        supported: true,
        enabled: read.enabled,
        backend: this.#backend.name,
        location: this.#backend.location(),
        reason: read.reason,
      };
    } catch (error: unknown) {
      return {
        supported: true,
        enabled: this.#desired === true,
        backend: this.#backend.name,
        location: this.#backend.location(),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export interface CreateAutostartOptions {
  /**
   * `true` inside a Flatpak/Snap sandbox: the profile directory is not the
   * user's real one, so the portal (or nothing) must be used instead.
   */
  readonly sandboxed?: boolean;
  readonly overrideExec?: { readonly execPath: string; readonly execArgs?: readonly string[] };
}

/**
 * Choose the backend for the current platform.
 *
 * The Exec path matters more than it looks:
 *  - AppImage: `process.env.APPIMAGE` is the *original file*, the only path that
 *    survives an update or a re-mount of the image;
 *  - .deb/.rpm/unpacked dir: `app.getPath('exe')` is the installed launcher;
 *  - development: the electron binary plus the app path, so the entry can be
 *    tested from a checkout at all.
 */
export function createAutostartBackend(logger: Logger, options: CreateAutostartOptions = {}): AutostartBackend {
  const isLinuxLike = process.platform === 'linux' || process.platform === 'freebsd' || process.platform === 'openbsd';
  if (!isLinuxLike || options.sandboxed === true) return new ElectronLoginItemBackend();
  const spec = options.overrideExec ?? autostartExecSpec();
  return new XdgAutostartBackend({ logger, execPath: spec.execPath, execArgs: spec.execArgs ?? [] });
}

/** What a non-sandboxed Linux install should put into the autostart entry. */
export function autostartExecSpec(): { execPath: string; execArgs: readonly string[] } {
  if (app.isPackaged) {
    const appImage = process.env['APPIMAGE'];
    return {
      execPath: typeof appImage === 'string' && appImage.length > 0 ? appImage : app.getPath('exe'),
      execArgs: ['--hidden'],
    };
  }
  return { execPath: process.execPath, execArgs: [app.getAppPath(), '--hidden'] };
}
