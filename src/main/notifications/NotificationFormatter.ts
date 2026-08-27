/**
 * Pure rendering of a notification group into title/body text.
 *
 * Kept separate from `NotificationManager` (queueing) and from the backends
 * (delivery) so the one thing users actually read can be unit tested and
 * changed without touching either.
 */

import { LIMITS } from '../../shared/constants.js';
import type { NotificationGroup } from '../../shared/types.js';
import { collapseWhitespace, truncate } from '../../shared/util.js';

export interface PresentationOptions {
  /** Include the message text in the body. */
  readonly showPreviews: boolean;
  /** Fallback title when even the chat name is unknown. */
  readonly fallbackTitle: string;
  /** Add "Open chat" style actions where the backend supports them. */
  readonly actions: boolean;
}

export interface PresentedNotification {
  readonly title: string;
  readonly body: string;
  /** Only ever `im.received` today; kept explicit for the backends. */
  readonly category: string;
}

export function present(group: NotificationGroup, options: PresentationOptions): PresentedNotification {
  const chatName = nonEmpty(group.chatName) ?? nonEmpty(group.senderName) ?? options.fallbackTitle;
  const sender = nonEmpty(group.senderName);
  const count = Math.max(1, Math.trunc(group.count));
  const preview = nonEmpty(group.preview) ?? (group.hasMedia ? 'Media' : 'New message');

  const title = truncate(collapseWhitespace(chatName), LIMITS.titleMaxChars);

  const bodyParts: string[] = [];
  if (group.isGroup && sender !== null && sender !== chatName) {
    bodyParts.push(`${truncate(sender, LIMITS.nameMaxChars)}:`);
  }
  if (count === 1) {
    bodyParts.push(options.showPreviews ? truncate(preview, LIMITS.previewMaxChars) : 'New message');
  } else {
    bodyParts.push(`${count} new messages`);
    if (options.showPreviews) {
      bodyParts.push(truncate(preview, LIMITS.previewMaxChars));
    }
  }

  return {
    title,
    body: bodyParts.join('\n').trim(),
    category: 'im.received',
  };
}

export function presentMany(groups: readonly NotificationGroup[], options: PresentationOptions): PresentedNotification {
  const total = groups.reduce((sum, group) => sum + Math.max(1, group.count), 0);
  const names = groups.map((group) => nonEmpty(group.chatName) ?? 'WhatsApp');
  const unique = [...new Set(names)];
  const title =
    unique.length === 1
      ? truncate(unique[0] ?? options.fallbackTitle, LIMITS.titleMaxChars)
      : `${unique.length} new chats`;
  const body =
    total === 1
      ? '1 new message'
      : `${total} new messages in ${unique.length} ${unique.length === 1 ? 'chat' : 'chats'}`;
  return { title: truncate(title, LIMITS.titleMaxChars), body, category: 'im.received' };
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const clean = collapseWhitespace(value);
  return clean.length > 0 ? clean : null;
}
