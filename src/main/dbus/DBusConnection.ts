/**
 * One shared D-Bus session bus connection for the whole application.
 *
 * Everything Linux specific that is not provided by Electron goes through here:
 *   - `org.freedesktop.Notifications`    (native notifications + click signals)
 *   - `org.freedesktop.portal.Settings`  (system Do Not Disturb)
 *   - `org.kde.StatusNotifierWatcher`    (is a tray actually available?)
 *
 * Design constraints, because this is where a Linux app usually becomes
 * fragile:
 *   - `dbus-next` is an *optional* dependency, loaded with a dynamic import and
 *     never required;
 *   - there is no session bus in Flatpak sandboxes, in headless CI, over some
 *     ssh sessions: every entry point returns a clean "unavailable" instead of
 *     throwing;
 *   - a single connection is shared, so we never leak sockets;
 *   - every method call is bounded by a timeout, because a hung `dbus-daemon`
 *     must not hang the notification pipeline (or the app).
 */

import { EventEmitter } from 'node:events';

import { TIMEOUTS } from '../../shared/constants.js';
import type { Logger } from '../lib/logger.js';

export interface DBusCallOptions {
  readonly destination: string;
  readonly path: string;
  readonly interface: string;
  readonly member: string;
  readonly signature?: string;
  readonly body?: readonly unknown[];
  readonly timeoutMs?: number;
}

export interface DBusSignalSubscription {
  readonly interface: string;
  readonly member: string;
  readonly sender?: string;
  readonly path?: string;
  readonly onData: (body: readonly unknown[]) => void;
}

export interface DBusVariant {
  readonly signature: string;
  readonly value: unknown;
}

export type DBusState = 'uninitialized' | 'connecting' | 'connected' | 'unavailable' | 'closed';

interface DbusNextModule {
  sessionBus?: (options?: { busAddress?: string }) => DBusBusHandle;
  Message?: new (options: Record<string, unknown>) => DBusMessageHandle;
  Variant?: new (signature: string, value: unknown) => DBusVariant;
  MessageType?: { METHOD_CALL: number; METHOD_RETURN: number; ERROR: number; SIGNAL: number };
  default?: DbusNextModule;
}

interface DBusBusHandle {
  name: string | null;
  call(message: DBusMessageHandle): Promise<DBusMessageHandle | null>;
  send(message: DBusMessageHandle): void;
  disconnect(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
}

interface DBusMessageHandle {
  type: number;
  interface?: string;
  member?: string;
  path?: string;
  sender?: string;
  body: unknown[];
}

export interface DBusConnectionOptions {
  readonly logger: Logger;
  readonly busAddress?: string;
  readonly connectTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  /** Injectable module loader, used by tests to simulate a missing package. */
  readonly loadModule?: () => Promise<DbusNextModule>;
}

export class DBusConnection extends EventEmitter {
  readonly #logger: Logger;
  readonly #loadModule: () => Promise<DbusNextModule>;
  readonly #connectTimeoutMs: number;
  readonly #callTimeoutMs: number;
  readonly #busAddress: string | undefined;
  #state: DBusState = 'uninitialized';
  #reason: string | null = null;
  #bus: DBusBusHandle | null = null;
  #module: DbusNextModule | null = null;
  #connectPromise: Promise<boolean> | null = null;
  readonly #subscriptions: DBusSignalSubscription[] = [];
  readonly #matchRules = new Set<string>();
  #rawMessageListener: ((message: DBusMessageHandle) => void) | null = null;

  constructor(options: DBusConnectionOptions) {
    super();
    this.setMaxListeners(32);
    this.#logger = options.logger;
    this.#busAddress = options.busAddress ?? process.env['DBUS_SESSION_BUS_ADDRESS'] ?? undefined;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? TIMEOUTS.dbusConnectMs;
    this.#callTimeoutMs = options.callTimeoutMs ?? 3_000;
    this.#loadModule =
      options.loadModule ??
      (async (): Promise<DbusNextModule> => {
        // Optional dependency: absent on Windows/macOS installs, present in CI
        // but useless without a bus. Never let this throw out of the app.
        const imported = (await import('dbus-next')) as unknown as DbusNextModule;
        return imported.default ?? imported;
      });
  }

  get state(): DBusState {
    return this.#state;
  }

  get connected(): boolean {
    return this.#state === 'connected';
  }

  /** Why the bus is unavailable, for the diagnostics view. */
  get reason(): string | null {
    return this.#reason;
  }

  get busAddress(): string | undefined {
    return this.#busAddress;
  }

  /**
   * Connect once. Concurrent callers share the same promise. A failure is
   * remembered: we do not retry on every notification, but `retry()` exists for
   * the "the network came back" case.
   */
  async connect(): Promise<boolean> {
    if (this.#state === 'connected') return true;
    if (this.#state === 'unavailable' || this.#state === 'closed') return false;
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#connect();
    try {
      return await this.#connectPromise;
    } finally {
      this.#connectPromise = null;
    }
  }

  async #connect(): Promise<boolean> {
    if (this.#busAddress === undefined || this.#busAddress === '') {
      return this.#unavailable('DBUS_SESSION_BUS_ADDRESS is not set (no desktop session bus)');
    }

    let module: DbusNextModule;
    try {
      module = await this.#loadModule();
    } catch (error: unknown) {
      return this.#unavailable(
        `dbus-next is not installed (${error instanceof Error ? error.message : String(error)}); falling back to Electron notifications`,
      );
    }
    const sessionBus = module.sessionBus;
    const Message = module.Message;
    if (typeof sessionBus !== 'function' || typeof Message !== 'function') {
      return this.#unavailable('dbus-next does not expose sessionBus/Message');
    }
    this.#module = module;

    let bus: DBusBusHandle;
    try {
      bus = sessionBus(this.#busAddress ? { busAddress: this.#busAddress } : undefined);
    } catch (error: unknown) {
      return this.#unavailable(`could not create the session bus: ${describe(error)}`);
    }

    this.#state = 'connecting';
    const connected = await this.#waitForConnect(bus);
    if (!connected) {
      try {
        bus.disconnect();
      } catch {
        /* already gone */
      }
      return this.#unavailable(`no reply from dbus-daemon within ${this.#connectTimeoutMs} ms`);
    }

    this.#bus = bus;
    this.#state = 'connected';
    this.#reason = null;
    this.#installSignalRouter(bus);
    // Re-play match rules for subscriptions that were requested before we were
    // connected (backends subscribe during startup, connect happens lazily).
    for (const subscription of this.#subscriptions) {
      await this.#addMatch(subscription).catch(() => undefined);
    }
    this.#logger.info('connected to the session bus', { address: this.#busAddress });
    this.emit('connected');
    return true;
  }

  async #waitForConnect(bus: DBusBusHandle): Promise<boolean> {
    if (bus.name !== null && bus.name !== undefined) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        bus.off('connect', onConnect);
        bus.off('error', onError);
        resolve(value);
      };
      const onConnect = (): void => finish(true);
      const onError = (): void => finish(false);
      const timer = setTimeout(() => finish(false), this.#connectTimeoutMs);
      bus.on('connect', onConnect);
      bus.on('error', onError);
    });
  }

  #unavailable(reason: string): false {
    this.#state = 'unavailable';
    this.#reason = reason;
    // One warn, then debug: an app that starts without a session bus must not
    // spam the log on every notification.
    this.#logger.warn('D-Bus session bus unavailable', { reason });
    this.emit('unavailable', reason);
    return false;
  }

  #installSignalRouter(bus: DBusBusHandle): void {
    if (this.#rawMessageListener) return;
    const signalType = this.#module?.MessageType?.SIGNAL ?? 4;
    const listener = (message: unknown): void => {
      const msg = message as DBusMessageHandle;
      if (!msg || msg.type !== signalType) return;
      for (const subscription of this.#subscriptions) {
        if (subscription.interface !== msg.interface) continue;
        if (subscription.member && subscription.member !== msg.member) continue;
        if (subscription.path && subscription.path !== msg.path) continue;
        if (subscription.sender && subscription.sender !== msg.sender) continue;
        try {
          subscription.onData(msg.body ?? []);
        } catch (error: unknown) {
          this.#logger.error('D-Bus signal handler threw', error);
        }
      }
    };
    this.#rawMessageListener = listener;
    bus.on('message', listener);
  }

  /** Subscribe to a signal, installing the match rule on demand. */
  async subscribe(subscription: DBusSignalSubscription): Promise<() => void> {
    this.#subscriptions.push(subscription);
    if (this.connected) await this.#addMatch(subscription).catch(() => undefined);
    return () => {
      const index = this.#subscriptions.indexOf(subscription);
      if (index !== -1) this.#subscriptions.splice(index, 1);
    };
  }

  async #addMatch(subscription: DBusSignalSubscription): Promise<void> {
    const parts = [`type='signal'`];
    if (subscription.sender) parts.push(`sender='${subscription.sender}'`);
    if (subscription.path) parts.push(`path='${subscription.path}'`);
    parts.push(`interface='${subscription.interface}'`, `member='${subscription.member}'`);
    const rule = parts.join(',');
    if (this.#matchRules.has(rule)) return;
    this.#matchRules.add(rule);
    await this.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member: 'AddMatch',
      signature: 's',
      body: [rule],
    });
  }

  /** Low level method call. Returns the reply body, or null when unavailable. */
  async call(options: DBusCallOptions): Promise<readonly unknown[] | null> {
    const bus = await this.#ready();
    if (bus === null) return null;
    const Message = this.#module?.Message;
    if (!Message) return null;

    let message: DBusMessageHandle;
    try {
      message = new Message({
        destination: options.destination,
        path: options.path,
        interface: options.interface,
        member: options.member,
        signature: options.signature ?? '',
        body: [...(options.body ?? [])],
      });
    } catch (error: unknown) {
      this.#logger.error('could not marshal D-Bus call', error, { member: options.member });
      return null;
    }

    try {
      const reply = await this.#withTimeout(
        bus.call(message),
        options.timeoutMs ?? this.#callTimeoutMs,
        `call ${options.member}`,
      );
      if (reply === null || reply === undefined) return [];
      return reply.body ?? [];
    } catch (error: unknown) {
      this.#logger.debug('D-Bus call failed', { member: options.member, error: describe(error) });
      this.emit('call-failed', { member: options.member, error: describe(error) });
      return null;
    }
  }

  /** Convenience for `org.freedesktop.DBus.ListNames`. */
  async hasService(busName: string): Promise<boolean> {
    const reply = await this.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member: 'ListNames',
      signature: '',
      body: [],
    });
    if (reply === null) return false;
    const names = reply[0];
    return Array.isArray(names) && names.includes(busName);
  }

  /** Build a variant for `a{sv}` style arguments. */
  variant(signature: string, value: unknown): DBusVariant | null {
    const Variant = this.#module?.Variant;
    if (!Variant) return null;
    return new Variant(signature, value);
  }

  async #ready(): Promise<DBusBusHandle | null> {
    if (this.#state === 'connected' && this.#bus) return this.#bus;
    const ok = await this.connect();
    return ok ? this.#bus : null;
  }

  async #withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Forget a failure so the next attempt retries (e.g. after suspend). */
  reset(): void {
    if (this.#state === 'unavailable') {
      this.#state = 'uninitialized';
      this.#reason = null;
    }
  }

  async dispose(): Promise<void> {
    if (this.#bus && this.#rawMessageListener) {
      try {
        this.#bus.off('message', this.#rawMessageListener);
      } catch {
        /* ignore */
      }
    }
    this.#subscriptions.length = 0;
    this.#matchRules.clear();
    if (this.#bus) {
      try {
        this.#bus.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.#bus = null;
    this.#state = 'closed';
    this.removeAllListeners();
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
