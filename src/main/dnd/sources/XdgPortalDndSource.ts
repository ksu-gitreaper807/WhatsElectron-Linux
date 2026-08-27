/**
 * System-wide Do Not Disturb, read through the XDG Desktop Portal settings
 * portal (`org.freedesktop.portal.Settings`).
 *
 * Why the portal and not `gsettings`/`dconf` directly: the portal is
 * sandbox-friendly (it works from inside Flatpak), it is a stable API with an
 * explicit D-Bus contract, and it is what desktops other than GNOME also
 * implement.
 *
 * Keys tried, in order:
 *   - `org.freedesktop.appearance` / `notify-snooze`  (portal-native DND flag)
 *   - `org.gnome.desktop.notifications` / `show-banners` (GNOME; inverted)
 *   - `org.xfce.notifyd` / `notifications-disabled`     (XFCE)
 *
 * Change notification: the portal *has* a `SettingChanged` signal, but several
 * portal implementations do not emit it for settings they only proxy, so we
 * poll (default 15 s) on top of the signal. One D-Bus round trip every 15
 * seconds is cheaper than a missed DND toggle, and both paths are idempotent.
 */

import type { DBusConnection } from '../../dbus/DBusConnection.js';
import type { Logger } from '../../lib/logger.js';
import type { DndSource } from '../DNDService.js';

interface PortalKey {
  readonly namespace: string;
  readonly key: string;
  /** Whether the value has to be inverted to mean "do not disturb". */
  readonly invert: boolean;
}

const CANDIDATE_KEYS: readonly PortalKey[] = [
  { namespace: 'org.freedesktop.appearance', key: 'notify-snooze', invert: false },
  { namespace: 'org.gnome.desktop.notifications', key: 'show-banners', invert: true },
  { namespace: 'org.xfce.notifyd', key: 'notifications-disabled', invert: false },
];

export interface XdgPortalDndSourceOptions {
  readonly dbus: DBusConnection;
  readonly logger: Logger;
  readonly pollMs?: number;
  readonly clock?: () => number;
}

export class XdgPortalDndSource implements DndSource {
  readonly name = 'xdg-portal-settings';
  readonly canWrite = false;
  readonly #dbus: DBusConnection;
  readonly #logger: Logger;
  readonly #pollMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #listener: ((enabled: boolean) => void) | null = null;
  #lastKnown: boolean | null = null;
  #resolvedKey: PortalKey | null = null;
  #unsubscribeSignal: (() => void) | null = null;

  constructor(options: XdgPortalDndSourceOptions) {
    this.#dbus = options.dbus;
    this.#logger = options.logger.child('dnd.portal');
    this.#pollMs = options.pollMs ?? 15_000;
  }

  async read(): Promise<boolean | null> {
    if (!(await this.#dbus.connect())) return null;
    for (const candidate of this.#resolvedKey === null ? CANDIDATE_KEYS : [this.#resolvedKey]) {
      const value = await this.#readOne(candidate);
      if (value === null) continue;
      this.#resolvedKey = candidate;
      const enabled = candidate.invert ? !value : value;
      return enabled;
    }
    this.#logger.debug('portal exposes no Do Not Disturb key');
    return null;
  }

  async #readOne(candidate: PortalKey): Promise<boolean | null> {
    const reply = await this.#dbus.call({
      destination: 'org.freedesktop.portal.Desktop',
      path: '/org/freedesktop/portal/desktop',
      interface: 'org.freedesktop.portal.Settings',
      member: 'Read',
      signature: 'ss',
      body: [candidate.namespace, candidate.key],
    });
    if (reply === null || reply === undefined) return null;
    // The portal returns `v` (a variant) whose decoded form dbus-next surfaces
    // as the raw value, or as a [signature, value] pair for some servers.
    const raw = unwrapVariant(reply[0]);
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw !== 0;
    return null;
  }

  subscribe(onChange: (enabled: boolean) => void): () => void {
    this.#listener = onChange;
    this.#unsubscribeSignal = this.#dbus ? this.#attachSignal() : null;
    if (this.#timer === null && this.#pollMs > 0) {
      this.#timer = setInterval(() => {
        void this.#tick();
      }, this.#pollMs);
      this.#timer.unref?.();
    }
    void this.#tick();
    return () => {
      this.#listener = null;
      this.#unsubscribeSignal?.();
      this.#unsubscribeSignal = null;
      if (this.#timer !== null) {
        clearInterval(this.#timer);
        this.#timer = null;
      }
    };
  }

  #attachSignal(): () => void {
    let dispose: () => void = () => undefined;
    void this.#dbus
      .subscribe({
        interface: 'org.freedesktop.portal.Settings',
        member: 'SettingChanged',
        sender: 'org.freedesktop.portal.Desktop',
        onData: (body) => {
          const namespace = body[0];
          const key = body[1];
          if (this.#resolvedKey && namespace === this.#resolvedKey.namespace && key === this.#resolvedKey.key) {
            void this.#tick();
          }
        },
      })
      .then((unsubscribe) => {
        dispose = unsubscribe;
      })
      .catch(() => undefined);
    return () => dispose();
  }

  async #tick(): Promise<void> {
    const value = await this.read();
    if (value === null) return;
    if (this.#lastKnown === value) return;
    this.#lastKnown = value;
    this.#logger.debug('system DND state', { enabled: value, key: this.#resolvedKey?.key ?? null });
    this.#listener?.(value);
  }

  dispose(): void {
    this.#listener = null;
    this.#unsubscribeSignal?.();
    this.#unsubscribeSignal = null;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}

function unwrapVariant(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
    const [, inner] = value as [string, unknown];
    return inner;
  }
  if (value !== null && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    return (value as { value: unknown }).value;
  }
  return value;
}
