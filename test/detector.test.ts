import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { DETECTOR_CHANNEL, DETECTOR_SOURCE, detectorTestHarnessSource } from '../src/main/detection/DetectionScript.js';
import { createFakeDom } from './helpers/fakeDom.js';

/**
 * The detector is injected as a *string* into the page world, so the only real
 * test is to evaluate that string. Everything below runs exactly the bytes the
 * application ships (and asserts that the shipped string is the one under test).
 */

type DetectorFactory = (
  window: Record<string, unknown>,
  document: Record<string, unknown>,
  MutationObserver: unknown,
  setTimeout: unknown,
  setInterval: unknown,
  console: unknown,
) => string;

function loadDetector(): DetectorFactory {
  const source = detectorTestHarnessSource();
  // The harness source is `return function (globals) { <shipped string> }`, so
  // evaluating it yields the factory; calling the factory runs the detector.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- evaluating the shipped source IS the test
  const evaluate = new Function(source) as () => DetectorFactory;
  return evaluate();
}

function boot(
  options: Parameters<typeof createFakeDom>[0] = {},
  before?: (dom: ReturnType<typeof createFakeDom>) => void,
) {
  const dom = createFakeDom(options);
  before?.(dom);
  const factory = loadDetector();
  const result = factory(
    dom.window,
    dom.document,
    dom.window['MutationObserver'] ?? class {},
    dom.window['setTimeout'],
    dom.window['setInterval'],
    { warn: vi.fn(), error: vi.fn(), log: vi.fn() },
  );
  dom.runTimers();
  return { dom, result };
}

const installedState = (dom: ReturnType<typeof createFakeDom>): unknown => dom.window['__waDesktopDetector'];

/** Read a string field out of a detector payload without stringifying objects. */
function field(payload: Record<string, unknown> | undefined, key: string): string {
  const value = payload?.[key];
  return typeof value === 'string' ? value : '';
}

describe('detector source', () => {
  it('is the exact text that will be injected', () => {
    const onDisk = readFileSync(path.join(process.cwd(), 'src/main/detection/DetectionScript.ts'), 'utf8');
    expect(onDisk).toContain('use strict');
    expect(DETECTOR_SOURCE).toContain('whatsappDesktopDetector');
    // No template holes may be introduced: the string must be inert text.
    expect(DETECTOR_SOURCE).not.toContain('${');
    // ...and it must not reach for anything from our bundle.
    expect(DETECTOR_SOURCE).not.toMatch(/\brequire\s*\(/);
    expect(DETECTOR_SOURCE).not.toMatch(/\bimport\s*\(/);
    expect(DETECTOR_SOURCE).not.toContain('window.Store');
  });

  it('installs, announces itself, and leaves its state object behind', () => {
    const { dom } = boot();
    const ready = dom.posted.filter((entry) => entry.kind === 'ready');
    expect(ready.length).toBeGreaterThanOrEqual(1);
    expect(ready[0]?.payload['installed']).toBe(true);
    expect(installedState(dom)).toBeTypeOf('object');
  });

  it('is idempotent: a second injection does nothing', () => {
    const { dom } = boot();
    const before = dom.posted.length;
    const factory = loadDetector();
    factory(
      dom.window,
      dom.document,
      dom.window['MutationObserver'],
      dom.window['setTimeout'],
      dom.window['setInterval'],
      console,
    );
    dom.runTimers();
    expect(dom.posted.length).toBe(before);
  });

  it('reports the session state it can see', () => {
    const { dom } = boot({ loggedIn: true });
    const ready = dom.posted.find((entry) => entry.kind === 'ready');
    expect(ready?.payload['session']).toBe('logged-in');

    const loggedOut = boot({ loggedIn: false, href: 'https://web.whatsapp.com/' });
    expect(loggedOut.dom.posted.find((entry) => entry.kind === 'ready')?.payload['session']).not.toBe('logged-in');
  });

  it('does not replay the unread chats that were already on screen', () => {
    const { dom } = boot({ rows: [{ title: 'Alice', preview: 'old message' }] });
    dom.observers.forEach((observer) => observer.trigger());
    dom.runTimers();
    const messages = dom.posted.filter((entry) => entry.kind === 'message');
    expect(messages).toHaveLength(0);
  });

  it('reports a newly arrived row exactly once', () => {
    const { dom } = boot();
    dom.setRows([{ title: 'Bob', preview: 'lunch at 8?' }]);
    dom.observers.forEach((observer) => observer.trigger());
    dom.runTimers();

    const messages = dom.posted.filter((entry) => entry.kind === 'message');
    expect(messages).toHaveLength(1);
    const payload = messages[0]?.payload as Record<string, unknown>;
    expect(payload['chatName']).toBe('Bob');
    expect(payload['body']).toBe('lunch at 8?');
    expect(typeof payload['chatId']).toBe('string');
    expect(String(payload['chatId']).startsWith('chat:')).toBe(true);

    // Re-scanning without a change must not report it again.
    dom.observers.forEach((observer) => observer.trigger());
    dom.runTimers();
    expect(dom.posted.filter((entry) => entry.kind === 'message')).toHaveLength(1);
  });

  it('detects the unread count from the document title', () => {
    const { dom } = boot({ title: 'WhatsApp' });
    dom.setTitle('(7) WhatsApp');
    dom.observers.forEach((observer) => observer.trigger());
    dom.runTimers();
    const sessions = dom.posted.filter((entry) => entry.kind === 'session');
    expect(sessions.at(-1)?.payload['titleUnreadCount']).toBe(7);
  });

  it('marks group chats when the row says so', () => {
    const { dom } = boot();
    dom.setRows([{ title: 'Flatmates', preview: 'who bought milk', ariaLabel: 'Group, 4 participants' }]);
    dom.observers.forEach((observer) => observer.trigger());
    dom.runTimers();
    const message = dom.posted.filter((entry) => entry.kind === 'message').at(-1);
    expect(message?.payload['isGroup']).toBe(true);
  });

  it('classifies media previews', () => {
    const { dom } = boot();
    dom.setRows([{ title: 'Alice', preview: 'Photo' }]);
    dom.observers.forEach((observer) => observer.trigger());
    dom.runTimers();
    const message = dom.posted.filter((entry) => entry.kind === 'message').at(-1);
    expect(message?.payload['hasMedia']).toBe(true);
  });

  it('sanitises control characters and clamps the preview length', () => {
    const { dom } = boot();
    const noisy = 'x'.repeat(500);
    dom.setRows([{ title: 'Alice', preview: noisy }]);
    dom.observers.forEach((observer) => observer.trigger());
    dom.runTimers();
    const message = dom.posted.filter((entry) => entry.kind === 'message').at(-1);
    const body = field(message?.payload, 'body');
    expect(body.length).toBeLessThanOrEqual(241);
    // eslint-disable-next-line no-control-regex -- asserting control bytes are gone
    expect(body).not.toMatch(/[\u0000-\u001F]/);
  });

  it('wraps page Notification constructions without changing their behaviour', () => {
    class FakeNotification {
      static permission = 'granted';
      static requestPermission(): string {
        return 'granted';
      }
      constructor(
        public readonly title: string,
        public readonly options: { body?: string } = {},
      ) {}
    }
    // `window.Notification` has to exist *before* the detector runs, because
    // that is when the read-only wrapper is installed.
    const { dom } = boot({}, (fresh) => {
      fresh.window['Notification'] = FakeNotification;
    });
    dom.runTimers();
    const constructed = new (dom.window['Notification'] as new (title: string, options: unknown) => unknown)('Cara', {
      body: 'ping',
    });
    expect(constructed).toBeInstanceOf(FakeNotification);
    const message = dom.posted.filter((entry) => entry.kind === 'message').at(-1);
    expect(field(message?.payload, 'chatName')).toBe('Cara');
    expect(field(message?.payload, 'body')).toBe('ping');
  });

  it('uses the channel the preload listens for', () => {
    const { dom } = boot();
    expect(DETECTOR_CHANNEL).toBe('wa-desktop-detector');
    expect(dom.posted.length).toBeGreaterThan(0);
  });
});
