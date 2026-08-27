import { describe, expect, it } from 'vitest';

import { LIMITS } from '../src/shared/constants.js';
import { parseDetectedMessage, parseRendererError, parseSessionReport } from '../src/main/ipc/schemas.js';

/**
 * Everything the page world can send crosses this function. The tests below are
 * written as an attacker's checklist: size, shape, type, control characters.
 */

describe('parseSessionReport', () => {
  it('accepts only known states and normalises the rest', () => {
    expect(parseSessionReport({ state: 'loading' }).ok).toBe(true);
    expect(parseSessionReport({ state: 'logged-in', url: 'https://web.whatsapp.com/#x', at: 5 }).ok).toBe(true);
    for (const state of ['authenticated', 'scraping', '', undefined, 3]) {
      expect(parseSessionReport({ state }).ok).toBe(false);
    }
  });

  it('carries the detector flag through as a tri-state', () => {
    const parsed = parseSessionReport({ state: 'loading', detectorInstalled: true });
    expect(parsed.ok && parsed.value.detectorInstalled).toBe(true);
    const missing = parseSessionReport({ state: 'loading' });
    expect(missing.ok && missing.value.detectorInstalled).toBeNull();
  });

  it('trims an absurd url instead of rejecting the report', () => {
    const parsed = parseSessionReport({ state: 'error', url: 'https://x/'.repeat(2_000) });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.url.length).toBeLessThanOrEqual(301);
  });
});

describe('parseRendererError', () => {
  it('requires a message and clamps the stack', () => {
    expect(parseRendererError({}).ok).toBe(false);
    expect(parseRendererError('boom').ok).toBe(false);
    const parsed = parseRendererError({ message: 'boom', stack: 'x'.repeat(50_000) });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.stack ?? '').toHaveLength(2_000);
  });
});

describe('parseDetectedMessage', () => {
  it('accepts a well formed message', () => {
    const result = parseDetectedMessage({
      id: 'x1',
      chatId: 'chat:123',
      chatName: 'Alice',
      senderName: 'Alice',
      isGroup: false,
      body: 'hi',
      hasMedia: false,
      timestamp: Date.now(),
      source: 'dom-notification',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.chatName).toBe('Alice');
      expect(result.value.body).toBe('hi');
    }
  });

  it('rejects non objects and empty payloads', () => {
    for (const junk of [null, undefined, 1, 'text', [], {}, { foo: 'bar' }]) {
      expect(parseDetectedMessage(junk).ok).toBe(false);
    }
  });

  it('clamps the preview and the name to the declared limits', () => {
    const result = parseDetectedMessage({
      chatName: 'A'.repeat(2_000),
      body: 'B'.repeat(3_000),
      timestamp: Date.now(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.from(result.value.body).length).toBeLessThanOrEqual(LIMITS.previewMaxChars);
      expect(Array.from(result.value.chatName).length).toBeLessThanOrEqual(LIMITS.nameMaxChars);
    }
  });

  it('clamps a huge name instead of dropping the message, but rejects an oversized id', () => {
    const clamped = parseDetectedMessage({ chatName: 'a'.repeat(20_000), body: 'x' });
    expect(clamped.ok).toBe(true);
    if (clamped.ok) expect(Array.from(clamped.value.chatName).length).toBeLessThanOrEqual(LIMITS.nameMaxChars);

    // `chatId` is an identifier, not display text: a 10 KB "id" is a bug or an
    // attack, so it is refused and a hashed fallback is used instead.
    const idRejected = parseDetectedMessage({ chatId: 'i'.repeat(5_000), chatName: 'A', body: 'x' });
    expect(idRejected.ok).toBe(true);
    if (idRejected.ok) expect(idRejected.value.chatId.startsWith('name:')).toBe(true);
  });

  it('strips control characters, ANSI escapes and zero width spam', () => {
    const noisy = 'hi there';
    const result = parseDetectedMessage({ chatName: 'Alice', body: noisy, timestamp: Date.now() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.body).toBe('hi there');
      // eslint-disable-next-line no-control-regex -- asserting control bytes are gone
      expect(result.value.body).not.toMatch(/[\u0000-\u001F\u007B-\u007D\u200B]/);
    }
  });

  it('derives a stable chat id when the page gave none', () => {
    const a = parseDetectedMessage({ chatName: 'Alice', body: 'one', timestamp: 1 });
    const b = parseDetectedMessage({ chatName: 'alice', body: 'two', timestamp: 2 });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value.chatId).toBe(b.value.chatId);
  });

  it('keeps a well formed chat id from the page', () => {
    const result = parseDetectedMessage({ chatId: '1234@s.whatsapp.net', chatName: 'Alice', body: 'x' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.chatId).toBe('1234@s.whatsapp.net');
  });

  it('treats a far future or far past timestamp as "now"', () => {
    for (const stamp of [0, -1, 1e15, Number.NaN, 'yesterday']) {
      const result = parseDetectedMessage({ chatName: 'A', body: 'x', timestamp: stamp });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Math.abs(result.value.timestamp - Date.now())).toBeLessThan(5_000);
      }
    }
  });

  it('clamps the title unread counter', () => {
    const result = parseDetectedMessage({ chatName: 'A', body: 'x', titleUnreadCount: 999_999 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.titleUnreadCount).toBe(LIMITS.maxUnread);
  });

  it('falls back to a readable chat name when the page has none', () => {
    const result = parseDetectedMessage({ chatName: '   ', body: 'message text' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.chatName).toBe('WhatsApp');
  });

  it('does not let a huge id through, and generates one instead', () => {
    const result = parseDetectedMessage({ id: 'z'.repeat(5_000), chatName: 'A', body: 'x' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id.length).toBeLessThan(80);
  });
});
