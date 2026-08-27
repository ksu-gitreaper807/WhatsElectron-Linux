/**
 * A 40 line DOM helper.
 *
 * The settings screen is a form: it does not need a framework, and shipping one
 * would add an audit surface and a bundle for nothing. Everything here builds
 * detached nodes and assigns `textContent` (never `innerHTML` with data), which
 * keeps persisted strings from becoming markup.
 */

export type Attrs = Record<string, string | number | boolean | null | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') {
      const data = value as unknown as Record<string, string>;
      for (const [name, item] of Object.entries(data)) node.dataset[name] = String(item);
    } else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? 'B'}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 s';
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} min ${rest} s`;
}

/** Milliseconds <-> seconds, because humans think in seconds. */
export function toSeconds(ms: number): number {
  return Math.round(ms / 1_000);
}

export function fromSeconds(seconds: number): number {
  return Math.round(seconds * 1_000);
}

export function debounce<T extends (...args: readonly unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: readonly unknown[]): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  return debounced as unknown as T;
}
