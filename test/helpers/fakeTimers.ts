/**
 * A deterministic clock + timer queue for the notification tests.
 *
 * `NotificationManager` takes its timers as a dependency precisely so that
 * grouping windows, retention and the rate limiter can be tested by *advancing
 * time* instead of sleeping.
 */
import type { TimerProvider } from '../../src/main/notifications/NotificationManager.js';

interface Pending {
  id: number;
  at: number;
  callback: () => void;
  cancelled: boolean;
}

export class FakeClock implements TimerProvider {
  #now: number;
  #nextId = 1;
  #pending: Pending[] = [];
  readonly fired: number[] = [];

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  get now(): number {
    return this.#now;
  }

  nowFn = (): number => this.#now;

  setTimeout = (callback: () => void, ms: number): unknown => {
    const entry: Pending = {
      id: this.#nextId,
      at: this.#now + Math.max(0, ms),
      callback,
      cancelled: false,
    };
    this.#nextId += 1;
    this.#pending.push(entry);
    return entry.id;
  };

  clearTimeout = (handle: unknown): void => {
    if (typeof handle !== 'number') return;
    const entry = this.#pending.find((candidate) => candidate.id === handle);
    if (entry) entry.cancelled = true;
  };

  /** Run every timer due at or before `ms` from now, in time order. */
  advance(ms: number): void {
    const target = this.#now + ms;
    let guard = 0;
    for (;;) {
      if (guard++ > 10_000) throw new Error('FakeClock: timer storm');
      const due = this.#pending
        .filter((entry) => !entry.cancelled && entry.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.#pending = this.#pending.filter((entry) => entry !== due);
      this.#now = Math.max(this.#now, due.at);
      this.fired.push(due.id);
      due.callback();
    }
    this.#now = target;
  }

  get pendingCount(): number {
    return this.#pending.filter((entry) => !entry.cancelled).length;
  }
}
