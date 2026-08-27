/**
 * A typed event emitter used for the application's event driven seams.
 *
 * Node's `EventEmitter` is untyped, which is exactly the wrong default when the
 * whole architecture (notification manager -> unread manager -> tray) is wired
 * together with events. Composition + generics gives us checked payloads
 * without every module inheriting a public `emit()`.
 */

import { EventEmitter } from 'node:events';

export type EventMap = Record<string, unknown>;

export type Listener<Payload> = (payload: Payload) => void;

/** Internal channel used to report exceptions thrown by listeners. */
const LISTENER_ERROR_EVENT = '__listener-error';

export interface ListenerErrorDetails {
  readonly event: string;
  readonly error: unknown;
}

export class TypedEmitter<Events extends EventMap> {
  readonly #emitter = new EventEmitter();

  constructor() {
    // Managers legitimately fan out to tray + title + IPC broadcast.
    this.#emitter.setMaxListeners(50);
  }

  on<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): () => void {
    this.#emitter.on(event, listener as (...args: unknown[]) => void);
    return () => this.off(event, listener);
  }

  once<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): void {
    this.#emitter.once(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): void {
    this.#emitter.off(event, listener as (...args: unknown[]) => void);
  }

  /**
   * Emitting is synchronous; a throwing listener would otherwise unwind through
   * unrelated components. Listeners are isolated and reported instead.
   */
  emit<K extends keyof Events & string>(event: K, payload: Events[K]): void {
    const listeners = this.#emitter.listeners(event);
    for (const listener of listeners) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (error: unknown) {
        // A dedicated event name, on purpose: an unhandled `error` event on an
        // EventEmitter throws, which is the opposite of what an isolation
        // boundary should do.
        this.#emitter.emit(LISTENER_ERROR_EVENT, { event, error });
      }
    }
  }

  listenerCount<K extends keyof Events & string>(event: K): number {
    return this.#emitter.listenerCount(event);
  }

  /** Escape hatch used by the diagnostics layer to report listener failures. */
  onListenerError(listener: (details: ListenerErrorDetails) => void): () => void {
    const wrapped = (details: unknown): void => {
      listener(details as ListenerErrorDetails);
    };
    this.#emitter.on(LISTENER_ERROR_EVENT, wrapped);
    return () => this.#emitter.off(LISTENER_ERROR_EVENT, wrapped);
  }

  /** Node's `error` event semantics are a footgun; we never use them. */
  setMaxListeners(count: number): void {
    this.#emitter.setMaxListeners(count);
  }

  removeAllListeners<K extends keyof Events & string>(event?: K): void {
    this.#emitter.removeAllListeners(event);
  }
}
