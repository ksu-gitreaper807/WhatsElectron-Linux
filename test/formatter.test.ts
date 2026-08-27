import { describe, expect, it } from 'vitest';

import { present, presentMany } from '../src/main/notifications/NotificationFormatter.js';
import type { NotificationGroup } from '../src/shared/types.js';

const options = { showPreviews: true, fallbackTitle: 'WhatsApp', actions: true } as const;

function group(overrides: Partial<NotificationGroup> = {}): NotificationGroup {
  return {
    key: 'chat:1',
    chatId: 'chat:1',
    chatName: 'Alice',
    isGroup: false,
    senderName: null,
    preview: 'hey, are you coming?',
    firstAt: 1,
    lastAt: 2,
    count: 1,
    hasMedia: false,
    status: 'pending',
    backendId: null,
    renderedId: null,
    ...overrides,
  };
}

describe('present()', () => {
  it('uses the chat name as the title and the message as the body', () => {
    expect(present(group(), options)).toEqual({
      title: 'Alice',
      body: 'hey, are you coming?',
      category: 'im.received',
    });
  });

  it('renders the required "3 new messages" summary for a burst', () => {
    const rendered = present(group({ count: 3, preview: 'third one' }), options);
    expect(rendered.title).toBe('Alice');
    expect(rendered.body).toContain('3 new messages');
    expect(rendered.body).toContain('third one');
  });

  it('hides the text when previews are off', () => {
    expect(present(group({ count: 2 }), { ...options, showPreviews: false }).body).toBe('2 new messages');
    expect(present(group(), { ...options, showPreviews: false }).body).toBe('New message');
  });

  it('names the author inside a group chat', () => {
    const rendered = present(group({ isGroup: true, chatName: 'Flatmates', senderName: 'Bob', count: 1 }), options);
    expect(rendered.title).toBe('Flatmates');
    expect(rendered.body.startsWith('Bob:')).toBe(true);
  });

  it('does not repeat the sender when the chat is a direct one', () => {
    const rendered = present(group({ senderName: 'Alice' }), options);
    expect(rendered.body).toBe('hey, are you coming?');
  });

  it('falls back to "Media" and "New message" when there is nothing to show', () => {
    expect(present(group({ preview: '', hasMedia: true }), options).body).toBe('Media');
    expect(present(group({ preview: '' }), options).body).toBe('New message');
  });

  it('uses the fallback title when the chat has no name at all', () => {
    expect(present(group({ chatName: '   ', senderName: null }), options).title).toBe('WhatsApp');
  });

  it('never renders markup from the page as anything but text', () => {
    const rendered = present(
      group({ chatName: '<img src=x onerror=alert(1)>', preview: '<script>alert(1)</script>' }),
      options,
    );
    expect(rendered.title).toBe('<img src=x onerror=alert(1)>');
    expect(rendered.body.startsWith('<script>')).toBe(true);
  });

  it('clamps a pathological name to the title limit', () => {
    const rendered = present(group({ chatName: 'A'.repeat(5_000) }), options);
    expect(Array.from(rendered.title).length).toBeLessThanOrEqual(90);
  });

  it('counts at least one message', () => {
    expect(present(group({ count: 0, preview: 'x' }), options).body).toBe('x');
    expect(present(group({ count: -5 }), { ...options, showPreviews: false }).body).toBe('New message');
  });
});

describe('presentMany()', () => {
  it('aggregates several chats into one line', () => {
    const rendered = presentMany([group({ count: 2 }), group({ chatName: 'Bob', count: 1 })], options);
    expect(rendered.title).toBe('2 new chats');
    expect(rendered.body).toBe('3 new messages in 2 chats');
  });

  it('keeps a single chat title when every message belongs to it', () => {
    const rendered = presentMany([group({ count: 1 })], options);
    expect(rendered.title).toBe('Alice');
    expect(rendered.body).toBe('1 new message');
  });
});
