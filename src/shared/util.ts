/**
 * Tiny, dependency free helpers that must work identically in the main
 * process, in preloads (where there is no Node) and in tests.
 */

/** Clamp `value` into [min, max]; returns `fallback` for non finite numbers. */
export function clampNumber(value: number, min: number, max: number, fallback = min): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Truncate to `max` characters, collapsing whitespace and adding an ellipsis.
 * Uses Array.from so surrogate pairs / emoji are not split in half.
 */
export function truncate(input: string, max: number): string {
  const collapsed = collapseWhitespace(input);
  const chars = Array.from(collapsed);
  if (chars.length <= max) return collapsed;
  const keep = Math.max(1, max - 1);
  return `${chars.slice(0, keep).join('')}\u2026`;
}

const INVISIBLE_RE = /[\u00A0\u2000-\u200B\u202F\u2060\uFEFF]/g;
// eslint-disable-next-line no-control-regex -- stripping control bytes from untrusted page text is the point
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const SPACE_RUN_RE = / {2,}/g;

/**
 * Normalise untrusted page text: strip control and zero width characters,
 * collapse whitespace runs, trim. This also neutralises a few tricks used to
 * smuggle markup or terminal escape sequences into a notification body.
 */
export function collapseWhitespace(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  return input.replace(CONTROL_RE, ' ').replace(INVISIBLE_RE, ' ').replace(SPACE_RUN_RE, ' ').trim();
}

/** Normalise a display name coming from the page. */
export function sanitizeName(input: unknown, fallback: string, max: number): string {
  if (typeof input !== 'string') return fallback;
  const clean = collapseWhitespace(input);
  if (clean.length === 0) return fallback;
  return truncate(clean, max);
}

/** True for non empty strings after sanitising. */
export function nonEmptyString(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const clean = collapseWhitespace(input);
  return clean.length > 0 ? clean : null;
}

/**
 * Sliding window `Set` used for message dedupe. Iteration order is insertion
 * order, which is exactly what the eviction needs.
 */
export class BoundedSet {
  readonly #limit: number;
  readonly #items = new Set<string>();

  constructor(limit: number) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  /** Returns true when the value was newly added. */
  add(value: string): boolean {
    if (this.#items.has(value)) return false;
    this.#items.add(value);
    while (this.#items.size > this.#limit) {
      const oldest = this.#items.values().next();
      if (oldest.done === true) break;
      this.#items.delete(oldest.value);
    }
    return true;
  }

  has(value: string): boolean {
    return this.#items.has(value);
  }

  get size(): number {
    return this.#items.size;
  }

  clear(): void {
    this.#items.clear();
  }
}

/** Deterministic 32 bit FNV-1a hash, used to derive stable ids from text. */
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Combine ids without leaking arbitrarily long untrusted strings into them. */
export function dedupeKeyOf(...parts: readonly string[]): string {
  return hashString(parts.join('|'));
}

/** `WhatsApp (3)` style title; returns the base title when count is 0. */
export function formatBadgeTitle(base: string, count: number, softCap: number): string {
  if (count <= 0) return base;
  const label = count > softCap ? `${softCap}+` : String(count);
  return `${base} (${label})`;
}

/** Wrap a promise in a timeout that never rejects on success. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Never-await style helper for fire-and-forget promises with an error hook. */
export function ignoreVoid(promise: Promise<unknown>, onError?: (error: unknown) => void): void {
  promise.catch((error: unknown) => {
    if (onError) onError(error);
  });
}
