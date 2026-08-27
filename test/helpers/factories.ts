/** Builders for the objects the tests feed through the IPC boundary. */
import type { DetectedMessage } from '../../src/shared/types.js';

let counter = 0;

export function detectedMessage(overrides: Partial<DetectedMessage> = {}): DetectedMessage {
  counter += 1;
  const now = overrides.timestamp ?? 1_700_000_000_000 + counter;
  return Object.freeze({
    id: `msg-${counter}`,
    chatId: 'chat:alice',
    chatName: 'Alice',
    senderName: null,
    isGroup: false,
    body: `hello ${counter}`,
    hasMedia: false,
    timestamp: now,
    source: 'dom-notification',
    titleUnreadCount: null,
    ...overrides,
  });
}

/** The same helper, but as the *unvalidated* object a renderer would send. */
export function rawPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const message = detectedMessage(overrides);
  return { ...message, ...overrides };
}
