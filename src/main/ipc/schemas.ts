/**
 * IPC input validation.
 *
 * Everything that crosses a renderer boundary is untrusted, including the
 * notification text that our *own* preload reads out of WhatsApp's DOM. These
 * functions are the only accepted way to turn `unknown` into application
 * types: they clamp lengths, reject shape mismatches and never throw.
 */

import { LIMITS, SESSION_STATE } from '../../shared/constants.js';
import { dedupeKeyOf, hashString, nonEmptyString, sanitizeName, truncate } from '../../shared/util.js';
import type { DetectedMessage, SessionStateReport } from '../../shared/types.js';

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const MAX_INBOUND_STRING = 4_096;
const RECENT_WINDOW_MS = 12 * 60 * 60 * 1000;

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

function boundedString(input: unknown, max: number): string | null {
  if (typeof input !== 'string') return null;
  if (input.length > MAX_INBOUND_STRING) return null;
  const clean = truncate(input, max);
  return clean.length > 0 ? clean : null;
}

/**
 * Turn the raw detection payload into a `DetectedMessage`.
 *
 * The id is *recomputed* from the content rather than trusted: two detections of
 * the same message (for example one from the DOM mutation observer and one from
 * a `Notification` interception) must collapse into one entry, and a hostile or
 * buggy renderer must not be able to force us to allocate unbounded ids.
 */
export function parseDetectedMessage(input: unknown): ParseResult<DetectedMessage> {
  if (!isRecord(input)) return { ok: false, reason: 'payload is not an object' };

  const rawChatName = typeof input['chatName'] === 'string' ? input['chatName'] : null;
  const rawBody = typeof input['body'] === 'string' ? input['body'] : null;
  if (rawChatName === null && rawBody === null) {
    return { ok: false, reason: 'payload carries neither chat name nor body' };
  }

  const chatName = sanitizeName(rawChatName ?? '', 'WhatsApp', LIMITS.nameMaxChars);
  const body = rawBody === null ? '' : truncate(rawBody, LIMITS.previewMaxChars);
  if (chatName.length === 0 && body.length === 0) {
    return { ok: false, reason: 'payload is empty after sanitising' };
  }

  const senderName = sanitizeNameOrNull(input['senderName'], LIMITS.nameMaxChars);
  const isGroup = input['isGroup'] === true;
  const hasMedia = input['hasMedia'] === true;

  const rawChatId = boundedString(input['chatId'], 96);
  // Fall back to a hash of the *name* so grouping still works when the DOM
  // does not expose a stable identifier.
  const chatId = rawChatId ?? `name:${hashString(chatName.toLowerCase())}`;

  const rawTimestamp = typeof input['timestamp'] === 'number' ? input['timestamp'] : Date.now();
  const now = Date.now();
  const timestamp =
    Number.isFinite(rawTimestamp) && Math.abs(now - rawTimestamp) < RECENT_WINDOW_MS ? Math.round(rawTimestamp) : now;

  const source = pickSource(input['source']);
  const titleUnreadCount = parseCount(input['titleUnreadCount']);

  const id = boundedString(input['id'], 64) ?? `m:${dedupeKeyOf(chatId, senderName ?? '', body, String(timestamp))}`;

  return {
    ok: true,
    value: Object.freeze({
      id,
      chatId,
      chatName,
      senderName,
      isGroup,
      body,
      hasMedia,
      timestamp,
      source,
      titleUnreadCount,
    }),
  };
}

function sanitizeNameOrNull(input: unknown, max: number): string | null {
  if (typeof input !== 'string') return null;
  const clean = sanitizeName(input, '', max);
  return clean.length > 0 ? clean : null;
}

function pickSource(input: unknown): DetectedMessage['source'] {
  switch (input) {
    case 'title':
      return 'title';
    case 'store':
      return 'store';
    case 'dom-notification':
    default:
      return 'dom-notification';
  }
}

/** Unread counters are clamped so a broken title cannot produce a silly badge. */
function parseCount(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') {
    const match = /^\((\d{1,5})\)$/.exec(input.trim());
    if (!match?.[1]) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? Math.min(parsed, LIMITS.maxUnread) : null;
  }
  if (typeof input === 'number' && Number.isFinite(input)) {
    if (input < 0) return null;
    return Math.min(Math.floor(input), LIMITS.maxUnread);
  }
  return null;
}

export function parseSessionReport(input: unknown): ParseResult<SessionStateReport> {
  if (!isRecord(input)) return { ok: false, reason: 'payload is not an object' };
  const state = input['state'];
  if (
    state !== SESSION_STATE.unknown &&
    state !== SESSION_STATE.loading &&
    state !== SESSION_STATE.loggedOut &&
    state !== SESSION_STATE.loggedIn &&
    state !== SESSION_STATE.error
  ) {
    return { ok: false, reason: 'unknown session state' };
  }
  const at = typeof input['at'] === 'number' && Number.isFinite(input['at']) ? Math.round(input['at']) : Date.now();
  return {
    ok: true,
    value: Object.freeze({
      state,
      url: typeof input['url'] === 'string' ? truncate(input['url'], 300) : '',
      at,
      titleUnreadCount: parseCount(input['titleUnreadCount']),
      detectorInstalled: typeof input['detectorInstalled'] === 'boolean' ? input['detectorInstalled'] : null,
    }),
  };
}

export function parseRendererError(input: unknown): ParseResult<{ message: string; stack: string | null }> {
  if (!isRecord(input)) return { ok: false, reason: 'payload is not an object' };
  const message = nonEmptyString(input['message']);
  if (message === null) return { ok: false, reason: 'missing message' };
  const stack = nonEmptyString(input['stack']);
  return {
    ok: true,
    value: Object.freeze({ message: truncate(message, 500), stack: stack === null ? null : truncate(stack, 2_000) }),
  };
}
