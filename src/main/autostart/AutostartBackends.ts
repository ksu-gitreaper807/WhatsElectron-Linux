/**
 * Autostart backends that do not need Electron.
 *
 * Split out on purpose: the Linux implementation is "write a key file into
 * `$XDG_CONFIG_HOME/autostart`", which is ordinary filesystem work and is
 * therefore fully unit testable without a display, a session bus or an app
 * instance. `AutostartService.ts` keeps the platform selection and the
 * Electron-backed (macOS/Windows) variant.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { APP_ID, APP_NAME, DESKTOP_FILE_NAME } from '../../shared/constants.js';
import type { Logger } from '../lib/logger.js';

export interface AutostartStatus {
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly backend: string;
  readonly location: string;
  readonly reason: string | null;
}

export interface AutostartBackend {
  readonly name: string;
  isSupported(): boolean;
  read(): Promise<{ enabled: boolean; reason: string | null }>;
  write(enabled: boolean): Promise<void>;
  location(): string;
}

export interface XdgAutostartOptions {
  readonly logger: Logger;
  /** Absolute path the autostart entry should run. Supplied by the caller. */
  readonly execPath: string;
  readonly execArgs?: readonly string[];
  readonly appId?: string;
  readonly displayName?: string;
  /** Icon name resolved from the theme; defaults to the installed desktop id. */
  readonly iconName?: string;
}

/**
 * freedesktop `.desktop` entry in the autostart directory.
 *
 * This is the same file `gnome-session-properties` and KDE's autostand KCM
 * manage, so a user can inspect and remove it with tools they already have.
 */
export class XdgAutostartBackend implements AutostartBackend {
  readonly name = 'xdg-autostart';
  readonly #logger: Logger;
  readonly #appId: string;
  readonly #execPath: string;
  readonly #execArgs: readonly string[];
  readonly #displayName: string;
  readonly #iconName: string;

  constructor(options: XdgAutostartOptions) {
    this.#iconName = options.iconName ?? DESKTOP_FILE_NAME;
    this.#logger = options.logger.child('autostart.xdg');
    this.#appId = options.appId ?? APP_ID;
    this.#displayName = options.displayName ?? APP_NAME;
    this.#execPath = options.execPath;
    this.#execArgs = options.execArgs ?? [];
  }

  isSupported(): boolean {
    return process.platform === 'linux' || process.platform === 'freebsd' || process.platform === 'openbsd';
  }

  get directory(): string {
    const base = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
    return join(base, 'autostart');
  }

  get filePath(): string {
    return join(this.directory, `${this.#appId}.desktop`);
  }

  location(): string {
    return this.filePath;
  }

  async read(): Promise<{ enabled: boolean; reason: string | null }> {
    if (!this.isSupported()) return { enabled: false, reason: 'not a Linux desktop' };
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { enabled: false, reason: null };
      return { enabled: false, reason: code ?? String(error) };
    }
    if (isHiddenDesktopEntry(content)) return { enabled: false, reason: 'entry exists but is marked Hidden=true' };
    if (!/^\[Desktop Entry\]$/m.test(content)) return { enabled: false, reason: 'entry is not a valid desktop file' };
    if (!content.includes(`Exec=${quote(this.#execPath)}`)) {
      // The AppImage was moved or renamed: report "enabled but stale" so the
      // service rewrites it, rather than silently keeping a broken launcher.
      this.#logger.warn('the autostart entry points at a different Exec path', { file: this.filePath });
      return { enabled: true, reason: 'Exec path does not match the running application' };
    }
    return { enabled: true, reason: null };
  }

  async write(enabled: boolean): Promise<void> {
    if (!this.isSupported()) throw new Error('autostart is only implemented for Linux desktops');
    if (!enabled) {
      await rm(this.filePath, { force: true });
      this.#logger.info('removed the autostart entry', { file: this.filePath });
      return;
    }
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.filePath, this.render(), { mode: 0o644 });
    this.#logger.info('wrote the autostart entry', { file: this.filePath, exec: this.#execPath });
  }

  /** Exposed for tests and for the "copy diagnostics" action. */
  render(): string {
    const exec = [quote(this.#execPath), ...this.#execArgs.map(quote)].join(' ');
    return [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${this.#displayName}`,
      'GenericName=WhatsApp Desktop',
      'Comment=WhatsApp Desktop wrapper with tray, native notifications and Do Not Disturb',
      `Exec=${exec}`,
      `Icon=${this.#iconName}`,
      'Terminal=false',
      'Categories=Network;InstantMessaging;',
      'StartupWMClass=whatsapp-desktop',
      'X-GNOME-Autostart-enabled=true',
      'X-KDE-autostart-after=panel',
      'NoDisplay=false',
      '',
    ].join('\n');
  }
}

/** Used in CI / sandboxes where touching the profile is not allowed. */
export class NullAutostartBackend implements AutostartBackend {
  readonly name = 'none';
  isSupported(): boolean {
    return false;
  }
  location(): string {
    return '(disabled)';
  }
  async read(): Promise<{ enabled: boolean; reason: string | null }> {
    return { enabled: false, reason: 'autostart backend disabled' };
  }
  async write(): Promise<void> {
    throw new Error('autostart backend disabled');
  }
}

/**
 * Desktop entry key-file quoting: wrap in double quotes and escape the
 * characters that are special inside an `Exec` line.
 */
export function quote(value: string): string {
  const escaped = value.replace(/(["`$\\])/g, '\\$1');
  return `"${escaped}"`;
}

export function isHiddenDesktopEntry(content: string): boolean {
  return /^\s*Hidden\s*=\s*true\s*$/im.test(content);
}

/** Parse the fields of a generated entry. Used by tests and diagnostics. */
export function parseDesktopEntry(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = /^([A-Za-z-]+)=(.*)$/.exec(line.trim());
    const key = match?.[1];
    const value = match?.[2];
    if (key !== undefined && value !== undefined) out[key] = value;
  }
  return out;
}
