/**
 * Error boundaries.
 *
 * Policy for this application:
 *  - A failing *integration* (tray, D-Bus, shortcut, autostart) is never fatal:
 *    it is logged and reported in the status view, the app keeps working.
 *  - A failing *core* (window creation, session storage) is fatal, because a
 *    wrapper that silently stopped showing WhatsApp is worse than a crash.
 */

import type { Logger } from './logger.js';

export interface SafeRunOptions {
  readonly logger: Logger;
  /** Text used in the log line and, for promises, in the rejection reason. */
  readonly label: string;
  /** Called with the original error after logging. */
  readonly onError?: (error: unknown) => void;
  /** Rethrow instead of swallowing (use for core paths). */
  readonly rethrow?: boolean;
}

export class NonFatalError extends Error {
  override readonly cause: unknown;

  constructor(label: string, cause: unknown) {
    super(`${label} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'NonFatalError';
    this.cause = cause;
  }
}

/** Run a synchronous block, logging (and optionally rethrowing) failures. */
export function safeRun<T>(fn: () => T, options: SafeRunOptions): T | undefined {
  try {
    return fn();
  } catch (error: unknown) {
    options.logger.error(options.label, error);
    options.onError?.(error);
    if (options.rethrow === true) throw new NonFatalError(options.label, error);
    return undefined;
  }
}

/** Await a promise, logging (and optionally rethrowing) failures. */
export async function safeRunAsync<T>(fn: () => Promise<T>, options: SafeRunOptions): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error: unknown) {
    options.logger.error(options.label, error);
    options.onError?.(error);
    if (options.rethrow === true) throw new NonFatalError(options.label, error);
    return undefined;
  }
}

/** Fire and forget with guaranteed error reporting (never an unhandled rejection). */
export function runDetached(fn: () => Promise<unknown>, options: { label: string; logger: Logger }): void {
  void fn().catch((error: unknown) => {
    options.logger.error(options.label, error);
  });
}

export function assertNever(value: never): Error {
  return new Error(`unexpected value: ${String(value)}`);
}

export interface BoundaryHandlers {
  onFatal?: (error: unknown, kind: 'uncaughtException' | 'unhandledRejection') => void;
}

/**
 * Install process wide boundaries. Returns a detach function so tests (and a
 * later reload path) can clean up.
 */
export function attachProcessErrorBoundaries(logger: Logger, handlers: BoundaryHandlers = {}): () => void {
  let fatalSeen: unknown = null;

  const handleUncaught = (error: Error): void => {
    if (fatalSeen === null) {
      fatalSeen = error;
      logger.error('uncaughtException', error);
      handlers.onFatal?.(error, 'uncaughtException');
    } else {
      logger.warn('uncaughtException suppressed (already in shutdown)', {
        message: error.message,
      });
    }
  };

  const handleRejection = (reason: unknown, promise: Promise<unknown>): void => {
    void promise;
    logger.error('unhandledRejection', reason);
    handlers.onFatal?.(reason, 'unhandledRejection');
  };

  process.on('uncaughtException', handleUncaught);
  process.on('unhandledRejection', handleRejection);

  return () => {
    process.off('uncaughtException', handleUncaught);
    process.off('unhandledRejection', handleRejection);
  };
}

/** Best effort stack for a non Error throw. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}
