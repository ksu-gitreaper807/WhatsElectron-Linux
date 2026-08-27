/**
 * UnreadManager: the single owner of "how many things do I have to look at".
 *
 * The number is *ours*, not WhatsApp's: the application has no supported way to
 * read the real server-side unread state, so the counter counts what the user
 * would have been notified about. Where the page does publish something we are
 * allowed to look at - the `(N)` prefix in `document.title` - `set()` can be
 * called with that authoritative value and wins until the next increment.
 *
 * Consumers (tray title, window title, taskbar badge, settings window) subscribe
 * to the `changed` event. Nothing here imports Electron.
 */

import { LIMITS } from '../../shared/constants.js';
import { clampNumber } from '../../shared/util.js';
import type { UnreadSnapshot, UnreadSource } from '../../shared/types.js';
import { TypedEmitter, type EventMap } from '../lib/typedEmitter.js';

export interface UnreadChange {
  readonly count: number;
  readonly previous: number;
  readonly snapshot: UnreadSnapshot;
  readonly source: UnreadSource;
}

export interface UnreadEvents extends EventMap {
  changed: UnreadChange;
}

export interface UnreadManagerOptions {
  readonly max?: number;
  /** Emit only when the count actually changed (default true). */
  readonly emitOnDeltaOnly?: boolean;
  readonly clock?: () => number;
}

export class UnreadManager extends TypedEmitter<UnreadEvents> {
  readonly #max: number;
  readonly #emitOnDeltaOnly: boolean;
  readonly #clock: () => number;
  readonly #byChat = new Map<string, { name: string; count: number }>();
  #count = 0;
  #source: UnreadSource = 'manual';
  #updatedAt = 0;

  constructor(options: UnreadManagerOptions = {}) {
    super();
    this.#max = options.max ?? LIMITS.maxUnread;
    this.#emitOnDeltaOnly = options.emitOnDeltaOnly ?? true;
    this.#clock = options.clock ?? (() => Date.now());
  }

  getCount(): number {
    return this.#count;
  }

  get count(): number {
    return this.#count;
  }

  get snapshot(): UnreadSnapshot {
    const byChat: Record<string, number> = {};
    for (const [chatId, entry] of this.#byChat) {
      byChat[entry.name || chatId] = entry.count;
    }
    return Object.freeze({
      count: this.#count,
      byChat: Object.freeze(byChat),
      source: this.#source,
      updatedAt: this.#updatedAt,
    });
  }

  /**
   * One more thing to look at. `chatId` is optional so that a caller with no
   * chat context (e.g. a title derived count) can still bump the total.
   */
  increment(chatId?: string, chatName?: string, delta = 1): void {
    const amount = clampNumber(Math.trunc(delta), 1, this.#max, 1);
    const previous = this.#count;
    this.#count = clampNumber(previous + amount, 0, this.#max, previous);
    if (chatId) {
      const key = String(chatId);
      const existing = this.#byChat.get(key);
      this.#byChat.set(key, {
        name: chatName ?? existing?.name ?? '',
        count: clampNumber((existing?.count ?? 0) + amount, 0, this.#max, 0),
      });
    }
    this.#publish(previous, 'notification');
  }

  decrement(chatId?: string): void {
    const previous = this.#count;
    this.#count = clampNumber(previous - 1, 0, this.#max, previous);
    if (chatId) {
      const key = String(chatId);
      const existing = this.#byChat.get(key);
      if (existing) {
        const next = existing.count - 1;
        if (next <= 0) this.#byChat.delete(key);
        else this.#byChat.set(key, { ...existing, count: next });
      }
    }
    this.#publish(previous, 'manual');
  }

  clear(source: UnreadSource = 'focus'): void {
    const previous = this.#count;
    this.#count = 0;
    this.#byChat.clear();
    if (!this.#emitOnDeltaOnly || previous !== 0) this.#publish(previous, source);
    else this.#updatedAt = this.#clock();
  }

  /**
   * Authoritative value from the page (the `(N)` prefix of `document.title`).
   * It wins outright: the title only moves when WhatsApp itself changed state.
   */
  set(count: number, source: UnreadSource = 'title'): void {
    const next = clampNumber(Math.trunc(count), 0, this.#max, 0);
    const previous = this.#count;
    if (next === previous) return;
    this.#count = next;
    if (next === 0) this.#byChat.clear();
    this.#publish(previous, source);
  }

  /** Forget one chat (used when the manager sees that group was handled). */
  markChatRead(chatId: string): void {
    const key = String(chatId);
    const existing = this.#byChat.get(key);
    if (!existing) return;
    this.#byChat.delete(key);
    const previous = this.#count;
    this.#count = clampNumber(previous - existing.count, 0, this.#max, previous);
    this.#publish(previous, 'focus');
  }

  #publish(previous: number, source: UnreadSource): void {
    this.#source = source;
    this.#updatedAt = this.#clock();
    if (this.#emitOnDeltaOnly && previous === this.#count) return;
    this.emit('changed', {
      count: this.#count,
      previous,
      snapshot: this.snapshot,
      source,
    });
  }
}
