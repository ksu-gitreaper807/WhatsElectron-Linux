/**
 * Ambient types for the optional `dbus-next` dependency.
 *
 * `dbus-next@0.10.2` ships `types.d.ts` but sets `"types": null` in its
 * package.json, so TypeScript cannot resolve it and - more importantly - the
 * module may legitimately be *absent at runtime* (it is listed under
 * `optionalDependencies` because it is only useful on Linux). Declaring the
 * small structural slice we actually use means:
 *   - the application compiles with or without the package installed,
 *   - the runtime failure mode is a clean "dbus unavailable" instead of a
 *     missing-module type error.
 */

declare module 'dbus-next' {
  export interface DBusMessageLike {
    type: number;
    serial: number | null;
    path: string;
    interface: string;
    member: string;
    errorName?: string;
    replySerial?: string;
    destination?: string;
    sender?: string;
    signature: string;
    body: unknown[];
    flags?: number;
  }

  export interface DBusMessageType {
    METHOD_CALL: number;
    METHOD_RETURN: number;
    ERROR: number;
    SIGNAL: number;
  }

  export class Message implements DBusMessageLike {
    constructor(options: {
      type?: number;
      destination?: string;
      path?: string;
      interface?: string;
      member?: string;
      signature?: string;
      body?: unknown[];
      flags?: number;
    });
    type: number;
    serial: number | null;
    path: string;
    interface: string;
    member: string;
    errorName?: string;
    replySerial?: string;
    destination?: string;
    sender?: string;
    signature: string;
    body: unknown[];
    flags?: number;
  }

  export class Variant {
    constructor(signature: string, value: unknown);
    signature: string;
    value: unknown;
  }

  export interface DBusBus {
    /** Unique connection name (`:1.42`), null until connected. */
    name: string | null;
    connected: boolean;
    call(message: Message): Promise<Message | null>;
    send(message: Message): void;
    disconnect(): void;
    on(event: 'connect' | 'message' | 'error' | 'disconnect', listener: (...args: never[]) => void): this;
    off(event: string, listener: (...args: never[]) => void): this;
    on(event: 'message', listener: (message: DBusMessageLike) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'connect', listener: () => void): this;
  }

  export function sessionBus(options?: { busAddress?: string }): DBusBus;
  export const MessageType: DBusMessageType;
  export const RequestNameReply: {
    PRIMARY_OWNER: number;
    IN_QUEUE: number;
    EXISTS: number;
    ALREADY_OWNER: number;
  };
  export const NameFlag: {
    ALLOW_REPLACEMENT: number;
    REPLACE_EXISTING: number;
    DO_NOT_QUEUE: number;
  };
}
