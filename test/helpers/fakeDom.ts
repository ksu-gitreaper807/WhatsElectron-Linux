/**
 * A deliberately tiny fake DOM, just enough to run the detector *source string*.
 *
 * The detector is injected into the page world as text, so the only honest way
 * to test it is to evaluate that text. This helper therefore models:
 *   - `getElementById`, `querySelector(All)` with the handful of selectors the
 *     detector actually uses (attribute selectors and tag names),
 *   - `MutationObserver`, whose callback we can trigger by hand,
 *   - `window.postMessage`, which the tests read as an array.
 *
 * It is not a browser. It is a fixture that fails loudly when the detector stops
 * matching the markup shape it says it matches.
 */

export interface FakeNode {
  readonly tagName: string;
  attributes: Record<string, string>;
  children: FakeNode[];
  textContent: string;
  matches(selector: string): boolean;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): FakeNode[];
  querySelector(selector: string): FakeNode | null;
  readonly childElementCount: number;
}

function matchesSingle(node: FakeNode, selector: string): boolean {
  const trimmed = selector.trim();
  const attribute = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(trimmed);
  if (attribute?.[1]) {
    if (attribute[2] === undefined) return node.attributes[attribute[1]] !== undefined;
    return node.attributes[attribute[1]] === attribute[2];
  }
  const scoped = /^([\w-]+)\[([\w-]+)=["']?([^"'\]]*)["']?\]$/.exec(trimmed);
  if (scoped?.[1] && scoped[2]) {
    return node.tagName.toLowerCase() === scoped[1].toLowerCase() && node.attributes[scoped[2]] === scoped[3];
  }
  if (/^[\w-]+$/.test(trimmed)) return node.tagName.toLowerCase() === trimmed.toLowerCase();
  // Space separated descendant selectors: `#app .landing-window` etc. The fake
  // DOM is shallow, so "the last part matches something" is enough.
  const parts = trimmed.split(/\s+/);
  const last = parts[parts.length - 1] ?? trimmed;
  return matchesSingle(node, last);
}

export function node(
  tagName: string,
  options: { attributes?: Record<string, string>; text?: string; children?: FakeNode[] } = {},
): FakeNode {
  const self: FakeNode = {
    tagName,
    attributes: options.attributes ?? {},
    children: options.children ?? [],
    textContent: options.text ?? '',
    matches: (selector: string) => matchesSingle(self, selector),
    getAttribute: (name: string) => self.attributes[name] ?? null,
    get childElementCount() {
      return self.children.length;
    },
    querySelectorAll(selector: string): FakeNode[] {
      const out: FakeNode[] = [];
      const visit = (current: FakeNode): void => {
        for (const child of current.children) {
          if (matchesSingle(child, selector)) out.push(child);
          visit(child);
        }
      };
      visit(self);
      return out;
    },
    querySelector(selector: string): FakeNode | null {
      return self.querySelectorAll(selector)[0] ?? null;
    },
  };
  return self;
}

export interface FakeDomOptions {
  readonly rows?: readonly { readonly title: string; readonly preview: string; readonly ariaLabel?: string }[];
  readonly title?: string;
  readonly href?: string;
  readonly notifyRegion?: boolean;
  readonly loggedIn?: boolean;
}

export interface FakeDom {
  readonly window: Record<string, unknown>;
  readonly document: Record<string, unknown>;
  readonly posted: { kind: string; payload: Record<string, unknown> }[];
  readonly observers: { trigger(): void }[];
  setRows(rows: NonNullable<FakeDomOptions['rows']>): void;
  setTitle(title: string): void;
  runTimers(): void;
}

export function createFakeDom(options: FakeDomOptions = {}): FakeDom {
  const posted: { kind: string; payload: Record<string, unknown> }[] = [];
  const observers: { trigger(): void }[] = [];

  // Shape mirrors what WhatsApp Web renders for a chat list row: an outer row
  // with an accessibility label, a name element carrying a `title`, and the
  // preview as a later `dir="auto"` span.
  const buildRows = (rows: readonly { title: string; preview: string; ariaLabel?: string }[]): FakeNode[] =>
    rows.map((row) =>
      node('div', {
        attributes: {
          role: 'listitem',
          'aria-label': row.ariaLabel ?? `${row.title}, 1 message, now`,
        },
        children: [
          node('div', {
            children: [
              node('span', { attributes: { title: row.title, dir: 'auto' }, text: row.title }),
              node('span', { attributes: { dir: 'auto' }, text: row.preview }),
            ],
          }),
        ],
      }),
    );

  let rows = buildRows(options.rows ?? []);

  const notifyRegion = node('div', {
    attributes: { 'data-testid': 'notify-container' },
    children: [],
  });
  const appRoot = node('div', { attributes: { id: 'app' }, children: [notifyRegion, ...rows] });
  const titleNode = node('title', { text: options.title ?? 'WhatsApp' });
  const chatList = node('div', { attributes: { 'aria-label': 'Chats' } });
  if (options.loggedIn !== false) appRoot.children.push(chatList);

  const reseed = (next: readonly { title: string; preview: string; ariaLabel?: string }[]): void => {
    rows = buildRows(next);
    appRoot.children = [notifyRegion, ...rows, chatList];
    notifyRegion.children = rows;
  };

  const document: Record<string, unknown> = {
    title: options.title ?? 'WhatsApp',
    getElementById: (id: string) => (id === 'app' ? appRoot : null),
    querySelector: (selector: string) => (selector === 'title' ? titleNode : appRoot.querySelector(selector)),
    querySelectorAll: (selector: string) =>
      selector.includes('listitem') || selector.includes('cell-frame') || selector.includes('role=')
        ? rows
        : appRoot.querySelectorAll(selector),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    head: node('head', { children: [titleNode] }),
    body: appRoot,
  };

  class FakeMutationObserver {
    #callback: () => void;
    constructor(callback: () => void) {
      this.#callback = callback;
    }
    observe(): void {
      observers.push({ trigger: () => this.#callback() });
    }
    disconnect(): void {
      /* nothing to release in a fixture */
    }
  }

  const timers: (() => void)[] = [];
  const window: Record<string, unknown> = {
    location: { href: options.href ?? 'https://web.whatsapp.com/#forceJid=1', origin: 'https://web.whatsapp.com' },
    postMessage: (message: { kind: string; payload: Record<string, unknown> }) => {
      posted.push({ kind: message.kind, payload: message.payload });
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    setInterval: () => 0,
    clearInterval: () => undefined,
    clearTimeout: () => undefined,
    MutationObserver: FakeMutationObserver,
    Notification: undefined,
  };

  return {
    window,
    document,
    posted,
    observers,
    setRows: (next) => reseed(next),
    setTitle: (title: string) => {
      document['title'] = title;
      titleNode.textContent = title;
    },
    runTimers: () => {
      const pending = timers.splice(0, timers.length);
      for (const timer of pending) timer();
    },
  };
}
