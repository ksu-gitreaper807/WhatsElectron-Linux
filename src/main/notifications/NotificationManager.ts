/**
 * NotificationManager: the queue, the grouping window and the policy gate.
 *
 * Data flow (see docs/ARCHITECTURE.md):
 *
 *   WhatsApp Web (DOM, read only)
 *     -> preload (postMessage -> ipcRenderer.send)
 *     -> IPC validation              (ipc/schemas.ts)
 *     -> NotificationManager.push()  (this file: dedupe, group, queue, policy)
 *     -> NotificationService         (backend selection)
 *     -> LinuxDBusBackend | ElectronNotificationBackend | file | mock
 *
 *   NotificationManager  --event-->  UnreadManager  --event-->  tray / title / renderer
 *
 * Deliberately absent: any dependency on Electron. Everything it needs from the
 * window layer is injected as a callback, which is why this class is fully
 * unit tested without a display.
 */

import { LIMITS, RANGES } from '../../shared/constants.js';
import type {
  AppNotification,
  DetectedMessage,
  NotificationClickPayload,
  NotificationGroup,
  NotificationQueueSnapshot,
  NotificationStatus,
} from '../../shared/types.js';
import { clampNumber, BoundedSet, dedupeKeyOf, hashString, truncate } from '../../shared/util.js';
import type { Logger } from '../lib/logger.js';
import { TypedEmitter, type EventMap } from '../lib/typedEmitter.js';
import type { DNDService } from '../dnd/DNDService.js';
import type { SettingsService } from '../settings/SettingsService.js';
import type { UnreadManager } from '../unread/UnreadManager.js';
import { present } from './NotificationFormatter.js';
import type { NotificationService } from './NotificationService.js';

/** Anti-spam: at most N *new groups* per rolling window. */
const RATE_LIMIT = Object.freeze({ windowMs: 10_000, maxGroups: 8 });
/** A visible notification is re-rendered at most this often (anti-flicker). */
const MIN_RE_RENDER_MS = 1_000;
export interface TimerProvider {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const RealTimers: TimerProvider = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    if (handle !== undefined && handle !== null) clearTimeout(handle as NodeJS.Timeout);
  },
};

export interface NotificationManagerEvents extends EventMap {
  pushed: { readonly groupKey: string; readonly message: DetectedMessage };
  delivered: { readonly groupKey: string; readonly notification: AppNotification; readonly status: NotificationStatus };
  suppressed: { readonly groupKey: string; readonly reason: string; readonly count: number };
  failed: { readonly groupKey: string; readonly error: string };
  cleared: { readonly groupKey: string; readonly reason: 'expired' | 'read' | 'manual' | 'shutdown' };
  changed: { readonly groups: number; readonly queued: number };
}

export interface NotificationManagerDeps {
  readonly service: NotificationService;
  readonly dnd: DNDService;
  readonly unread: UnreadManager;
  readonly settings: SettingsService;
  readonly logger: Logger;
  /** The WhatsApp window currently has keyboard focus. */
  readonly isWindowActive?: () => boolean;
  /** The user activated a notification: restore + focus + (best effort) open chat. */
  readonly onActivate?: (payload: NotificationClickPayload) => void;
  readonly timers?: TimerProvider;
  readonly clock?: () => number;
  readonly rateLimitWindowMs?: number;
  readonly rateLimitMaxGroups?: number;
}

export interface NotificationStats {
  readonly delivered: number;
  readonly suppressed: number;
  readonly failed: number;
  readonly merged: number;
  readonly duplicates: number;
  readonly rateLimited: number;
}

interface GroupState {
  chatId: string;
  chatName: string;
  isGroup: boolean;
  senderName: string | null;
  preview: string;
  firstAt: number;
  lastAt: number;
  count: number;
  hasMedia: boolean;
  status: NotificationStatus;
  renderedId: string | null;
  deliveredCount: number;
  lastRenderAt: number;
  suppressReason: string | null;
  flushTimer: unknown;
  expiryTimer: unknown;
  retries: number;
}

export class NotificationManager extends TypedEmitter<NotificationManagerEvents> {
  readonly #service: NotificationService;
  readonly #dnd: DNDService;
  readonly #unread: UnreadManager;
  readonly #settings: SettingsService;
  readonly #logger: Logger;
  readonly #isWindowActive: () => boolean;
  readonly #onActivate: ((payload: NotificationClickPayload) => void) | undefined;
  readonly #timers: TimerProvider;
  readonly #clock: () => number;
  readonly #rateLimitWindowMs: number;
  readonly #rateLimitMaxGroups: number;

  readonly #groups = new Map<string, GroupState>();
  /** `AppNotification.id` -> group key, so clicks can be routed back. */
  readonly #byRenderedId = new Map<string, string>();
  readonly #recent = new BoundedSet(LIMITS.dedupeCacheSize);
  readonly #recentDeliveries: number[] = [];
  readonly #groupMessages = new Map<string, Set<string>>();

  #serviceClickOff: (() => void) | null = null;
  #serviceDismissOff: (() => void) | null = null;
  #dndOff: (() => void) | null = null;
  #settingsOff: (() => void) | null = null;
  #disposed = false;
  readonly #stats: {
    delivered: number;
    suppressed: number;
    failed: number;
    merged: number;
    duplicates: number;
    rateLimited: number;
  } = { delivered: 0, suppressed: 0, failed: 0, merged: 0, duplicates: 0, rateLimited: 0 };

  constructor(deps: NotificationManagerDeps) {
    super();
    this.#service = deps.service;
    this.#dnd = deps.dnd;
    this.#unread = deps.unread;
    this.#settings = deps.settings;
    this.#logger = deps.logger.child('notifications');
    this.#isWindowActive = deps.isWindowActive ?? (() => false);
    this.#onActivate = deps.onActivate;
    this.#timers = deps.timers ?? RealTimers;
    this.#clock = deps.clock ?? (() => Date.now());
    this.#rateLimitWindowMs = deps.rateLimitWindowMs ?? RATE_LIMIT.windowMs;
    this.#rateLimitMaxGroups = deps.rateLimitMaxGroups ?? RATE_LIMIT.maxGroups;
  }

  /** Subscribe to the outside world. Idempotent. */
  start(): void {
    if (this.#serviceClickOff) return;
    this.#serviceClickOff = this.#service.on('click', (payload) => {
      const groupKey = this.#byRenderedId.get(payload.id);
      this.#logger.debug('notification activation', {
        id: payload.id,
        groupKey: groupKey ?? null,
        action: payload.actionId,
      });
      if (groupKey === undefined) {
        // An action other than 'default' (e.g. "Mark as read") on a notification
        // we no longer track: ignore quietly, the group expired meanwhile.
        return;
      }
      void this.#handleActivation(groupKey, payload.actionId);
    });
    this.#serviceDismissOff = this.#service.on('dismiss', (payload) => {
      const groupKey = this.#byRenderedId.get(payload.id);
      if (groupKey === undefined) return;
      this.#byRenderedId.delete(payload.id);
      const state = this.#groups.get(groupKey);
      if (state) state.renderedId = null;
      // Expired or closed by the user: if more messages arrive afterwards the
      // group is re-rendered from scratch, which is what they expect.
      if (state) state.deliveredCount = Math.min(state.deliveredCount, state.count);
    });
    // Turning DND off should deliver what is still queued, not wait for a new
    // message to trigger a flush.
    this.#dndOff = this.#dnd.on('changed', (state) => {
      this.#logger.debug('DND changed, re-evaluating queue', { active: state.active });
      if (!state.active) this.flushAll('dnd-off');
    });
    this.#settingsOff = this.#settings.on('changed', ({ changes }) => {
      const keys = Object.keys(changes);
      if (keys.includes('groupingIntervalMs') || keys.includes('groupingEnabled') || keys.includes('expireAfterMs')) {
        for (const [key, state] of this.#groups) {
          if (state.count > state.deliveredCount) this.#scheduleFlush(key, state);
        }
      }
      if (keys.includes('notificationsEnabled') && this.#settings.get('notificationsEnabled')) {
        this.flushAll('notifications-enabled');
      }
      if (keys.includes('showPreviews') || keys.includes('playSound')) {
        for (const [, state] of this.#groups) state.deliveredCount = -1;
      }
    });
    this.#logger.info('notification manager started', this.#configSummary());
  }

  #configSummary(): Record<string, unknown> {
    const settings = this.#settings.settings;
    return {
      groupingEnabled: settings.groupingEnabled,
      groupingIntervalMs: settings.groupingIntervalMs,
      expireAfterMs: settings.expireAfterMs,
      notificationsEnabled: settings.notificationsEnabled,
      showPreviews: settings.showPreviews,
      backend: this.#service.activeName,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* ingestion                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Entry point for the IPC layer. Accepts `unknown` on purpose: the only
   * caller is a renderer, so validation happens here rather than trusting the
   * sender. Returns a short reason string when the message was dropped, which
   * the IPC layer logs but never shows to the user.
   */
  ingest(raw: unknown): { readonly accepted: boolean; readonly reason: string } {
    if (this.#disposed) return { accepted: false, reason: 'shutdown' };
    const message = this.#sanitize(raw);
    if (message === null) return { accepted: false, reason: 'invalid payload' };

    // The detection script already derives a stable id from (chat, text, time);
    // using it keeps the manager and the detector in agreement about what "the
    // same message" means, and lets a caller (or a test) mark two events as
    // distinct without inventing a second identity scheme. Content remains the
    // fallback so a payload without an id is still deduped.
    const dedupeKey =
      message.id.length > 0
        ? `id:${message.id}`
        : `k:${dedupeKeyOf(message.chatId, message.senderName ?? '', message.body, String(message.timestamp))}`;
    if (!this.#recent.add(dedupeKey)) {
      this.#stats.duplicates += 1;
      return { accepted: false, reason: 'duplicate' };
    }

    const groupKey = this.#groupKeyFor(message);
    const now = this.#clock();
    let state = this.#groups.get(groupKey);

    if (!state) {
      state = {
        chatId: message.chatId,
        chatName: message.chatName,
        isGroup: message.isGroup,
        senderName: message.senderName,
        preview: message.body,
        firstAt: message.timestamp,
        lastAt: now,
        count: 0,
        hasMedia: message.hasMedia,
        status: 'pending',
        renderedId: null,
        deliveredCount: 0,
        lastRenderAt: 0,
        suppressReason: null,
        flushTimer: null,
        expiryTimer: null,
        retries: 0,
      };
      this.#groups.set(groupKey, state);
      this.#enforceGroupCap();
    } else {
      this.#stats.merged += 1;
      // The newest message wins as the preview; older ones (reordered delivery)
      // only bump the counter, so nothing is silently lost.
      state.preview = message.body || state.preview;
      state.senderName = message.senderName ?? state.senderName;
      state.chatName = message.chatName || state.chatName;
      state.lastAt = now;
      state.hasMedia = state.hasMedia || message.hasMedia;
    }

    state.count += 1;
    this.#rememberMessage(groupKey, message);

    // Tracking always runs, even when the notification is suppressed: an unread
    // message that arrives during DND is still an unread message.
    this.#unread.increment(message.chatId, message.chatName);
    this.emit('pushed', { groupKey, message });

    if (this.#settings.get('groupingEnabled')) this.#scheduleFlush(groupKey, state);
    else void this.#flush(groupKey, state, 'ungrouped');

    this.emit('changed', { groups: this.#groups.size, queued: this.queuedCount });
    return { accepted: true, reason: state.count === 1 ? 'new group' : 'merged' };
  }

  #rememberMessage(groupKey: string, message: DetectedMessage): void {
    let set = this.#groupMessages.get(groupKey);
    if (!set) {
      set = new Set();
      this.#groupMessages.set(groupKey, set);
    }
    set.add(message.id);
    if (set.size > LIMITS.maxMessagesPerGroup) {
      const oldest = set.values().next();
      if (!oldest.done) set.delete(oldest.value);
    }
  }

  /**
   * Grouping key. Chat first (that is what a human reads as "one conversation");
   * when the chat id is unknown, fall back to the *sender* so messages from one
   * person still aggregate into one line, as required.
   */
  #groupKeyFor(message: DetectedMessage): string {
    if (message.chatId) return `chat:${hashString(message.chatId)}`;
    const name = (message.senderName ?? message.chatName ?? 'unknown').toLowerCase();
    return `sender:${hashString(name)}`;
  }

  #sanitize(raw: unknown): DetectedMessage | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const input = raw as Record<string, unknown>;
    const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
    const chatName = truncate(asString(input['chatName']), LIMITS.nameMaxChars);
    const body = truncate(asString(input['body']), LIMITS.previewMaxChars);
    if (chatName.length === 0 && body.length === 0) return null;
    const timestampRaw = typeof input['timestamp'] === 'number' ? input['timestamp'] : this.#clock();
    return {
      id: asString(input['id']) || `gen:${hashString(`${chatName}|${body}|${Math.round(timestampRaw / 1000)}`)}`,
      chatId: asString(input['chatId']),
      chatName: chatName || 'WhatsApp',
      senderName:
        typeof input['senderName'] === 'string' && input['senderName'].length > 0
          ? truncate(input['senderName'], LIMITS.nameMaxChars)
          : null,
      isGroup: input['isGroup'] === true,
      body,
      hasMedia: input['hasMedia'] === true,
      timestamp: Number.isFinite(timestampRaw) ? Math.round(timestampRaw) : this.#clock(),
      source: input['source'] === 'title' ? 'title' : input['source'] === 'store' ? 'store' : 'dom-notification',
      titleUnreadCount:
        typeof input['titleUnreadCount'] === 'number' && Number.isFinite(input['titleUnreadCount'])
          ? clampNumber(Math.trunc(input['titleUnreadCount']), 0, LIMITS.maxUnread, 0)
          : null,
    };
  }

  #enforceGroupCap(): void {
    while (this.#groups.size > LIMITS.maxGroups) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, state] of this.#groups) {
        if (state.lastAt < oldestAt) {
          oldestAt = state.lastAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      this.#drop(oldestKey, 'expired');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* rendering                                                              */
  /* ---------------------------------------------------------------------- */

  #scheduleFlush(groupKey: string, state: GroupState): void {
    const interval = clampNumber(
      this.#settings.get('groupingIntervalMs'),
      RANGES.groupingIntervalMs.min,
      RANGES.groupingIntervalMs.max,
      5_000,
    );
    // Already pending a re-render for a notification we have shown: do not
    // restart the window on every incoming message, otherwise a busy chat would
    // postpone its notification forever.
    if (state.flushTimer !== null) return;
    state.flushTimer = this.#timers.setTimeout(() => {
      const current = this.#groups.get(groupKey);
      if (!current) return;
      current.flushTimer = null;
      void this.#flush(groupKey, current, 'grouping-window');
    }, interval);
  }

  /**
   * Bounded retry after a failed delivery. Two more attempts, spaced like the
   * grouping window: enough to ride out a restarting notification daemon, not
   * enough to spam the bus if something is permanently broken.
   */
  #scheduleRetry(groupKey: string, state: GroupState): void {
    if (state.retries >= 2 || state.flushTimer !== null) return;
    state.retries += 1;
    const delay = clampNumber(
      this.#settings.get('groupingIntervalMs'),
      RANGES.groupingIntervalMs.min,
      RANGES.groupingIntervalMs.max,
      1_000,
    );
    state.flushTimer = this.#timers.setTimeout(() => {
      const current = this.#groups.get(groupKey);
      if (!current) return;
      current.flushTimer = null;
      void this.#flush(groupKey, current, `retry-${state.retries}`);
    }, delay);
  }

  #scheduleExpiry(groupKey: string, state: GroupState): void {
    if (state.expiryTimer !== null) return;
    const ttl = clampNumber(
      this.#settings.get('expireAfterMs'),
      RANGES.expireAfterMs.min,
      RANGES.expireAfterMs.max,
      120_000,
    );
    state.expiryTimer = this.#timers.setTimeout(() => {
      const current = this.#groups.get(groupKey);
      if (!current) return;
      current.expiryTimer = null;
      if (current.count > current.deliveredCount) {
        // New messages arrived while the timer was running: keep the group, let
        // it be delivered, and re-arm expiry.
        this.#scheduleFlush(groupKey, current);
        this.#scheduleExpiry(groupKey, current);
        return;
      }
      this.#logger.debug('notification group expired', { groupKey, count: current.count });
      this.#drop(groupKey, 'expired');
    }, ttl);
  }

  /**
   * Is this group worth rendering? Either it grew since the last render, or the
   * last render did not actually reach the user (suppressed, failed) and the
   * reason for that has gone away.
   */
  #isPending(state: GroupState): boolean {
    if (state.count > state.deliveredCount) return true;
    return state.status === 'suppressed' || state.status === 'failed';
  }

  /** Force delivery of everything pending (used on DND off / quit / tests). */
  flushAll(reason: string): void {
    for (const [key, state] of [...this.#groups]) {
      if (this.#isPending(state)) void this.#flush(key, state, `flushAll:${reason}`);
    }
  }

  /** Deliver a single group now. Public for tests and for tray actions. */
  async flush(groupKey: string): Promise<void> {
    const state = this.#groups.get(groupKey);
    if (!state) return;
    await this.#flush(groupKey, state, 'manual');
  }

  async #flush(groupKey: string, state: GroupState, reason: string): Promise<void> {
    if (this.#disposed) return;
    if (!this.#isPending(state)) return;
    if (state.flushTimer !== null) {
      this.#timers.clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }

    // Anti-flicker: a notification that is *already visible* must not be
    // rewritten on every keystroke of an incoming burst, or its body jitters.
    // Only relevant when we replace in place (grouping); with grouping off every
    // message is its own notification and must appear immediately.
    if (state.deliveredCount > 0 && this.#settings.get('groupingEnabled')) {
      const sinceRender = this.#clock() - state.lastRenderAt;
      if (sinceRender < MIN_RE_RENDER_MS) {
        state.flushTimer = this.#timers.setTimeout(() => {
          const current = this.#groups.get(groupKey);
          if (!current) return;
          current.flushTimer = null;
          void this.#flush(groupKey, current, 're-render-spacing');
        }, MIN_RE_RENDER_MS - sinceRender);
        return;
      }
    }

    const settings = this.#settings.settings;
    const suppression = this.#suppressionReason(settings, state);
    if (suppression !== null) {
      state.status = 'suppressed';
      state.suppressReason = suppression;
      state.deliveredCount = state.count;
      this.#stats.suppressed += 1;
      this.#logger.debug('notification suppressed', {
        groupKey,
        reason: suppression,
        count: state.count,
        cause: reason,
      });
      this.emit('suppressed', { groupKey, reason: suppression, count: state.count });
      this.#scheduleExpiry(groupKey, state);
      return;
    }

    const notification = this.#render(groupKey, state, settings);
    state.deliveredCount = state.count;
    state.lastRenderAt = this.#clock();
    // Count the *attempt* here, synchronously: the rate limiter protects against
    // a storm of new chats, and the storm is what happens before any of the
    // awaits below resolve.
    this.#recentDeliveries.push(this.#clock());

    let result;
    try {
      result = await this.#service.show(notification);
    } catch (error: unknown) {
      this.#stats.failed += 1;
      state.status = 'failed';
      state.deliveredCount = Math.max(0, state.count - 1);
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.error('notification delivery threw', error, { groupKey });
      this.emit('failed', { groupKey, error: message });
      this.#scheduleRetry(groupKey, state);
      this.#scheduleExpiry(groupKey, state);
      return;
    }

    if (!result.ok) {
      this.#stats.failed += 1;
      state.status = 'failed';
      state.suppressReason = null;
      // Undo "rendered": the user never saw it, so the group stays pending and
      // expiry will not drop it as if it had been delivered.
      state.deliveredCount = Math.max(0, state.count - 1);
      this.#logger.warn('notification delivery failed', {
        groupKey,
        backend: result.backend,
        error: result.error ?? 'unknown error',
        retries: state.retries,
      });
      this.emit('failed', { groupKey, error: result.error ?? 'delivery failed' });
      this.#scheduleRetry(groupKey, state);
      this.#scheduleExpiry(groupKey, state);
      return;
    }

    this.#stats.delivered += 1;
    state.status = 'delivered';
    state.suppressReason = null;
    state.renderedId = notification.id;
    this.#byRenderedId.set(notification.id, groupKey);
    this.#logger.info('notification delivered', {
      groupKey,
      backend: result.backend,
      count: state.count,
      title: notification.title,
      id: notification.id,
      cause: reason,
    });
    this.emit('delivered', { groupKey, notification, status: 'delivered' });
    this.#scheduleExpiry(groupKey, state);
    this.emit('changed', { groups: this.#groups.size, queued: this.queuedCount });
  }

  #suppressionReason(
    settings: { readonly notificationsEnabled: boolean; readonly focusQuietMs: number },
    state: GroupState,
  ): string | null {
    if (!settings.notificationsEnabled) return 'notifications-disabled';
    if (this.#dnd.isEnabled()) return 'do-not-disturb';
    if (this.#isWindowActive() && settings.focusQuietMs >= 0) {
      // The user is looking at the chat list: a popup would be pure noise. The
      // group stays in the queue, so the counter still updates if they tab away.
      return 'window-focused';
    }
    if (this.#rateLimited(state)) return 'rate-limited';
    return null;
  }

  #rateLimited(state: GroupState): boolean {
    const now = this.#clock();
    const windowStart = now - this.#rateLimitWindowMs;
    while (this.#recentDeliveries.length > 0 && (this.#recentDeliveries[0] ?? 0) < windowStart) {
      this.#recentDeliveries.shift();
    }
    const isUpdate = state.deliveredCount > 0;
    if (isUpdate) return false; // refreshing an existing notification is never "new spam"
    if (this.#recentDeliveries.length >= this.#rateLimitMaxGroups) {
      this.#stats.rateLimited += 1;
      return true;
    }
    return false;
  }

  #render(
    groupKey: string,
    state: GroupState,
    settings: { showPreviews: boolean; playSound: boolean; globalShortcut: string },
  ): AppNotification {
    const group = this.#toView(groupKey, state);
    const rendered = present(group, {
      showPreviews: settings.showPreviews,
      fallbackTitle: 'WhatsApp',
      actions: true,
    });
    return {
      id: this.#settings.get('groupingEnabled')
        ? `wa:${groupKey}`
        : `wa:${groupKey}:${hashString(`${state.count}:${state.lastAt}`)}`,
      title: rendered.title,
      body: rendered.body,
      iconPath: this.#iconPath(),
      silent: !this.#settings.get('playSound') || this.#dnd.isEnabled(),
      // Never 'critical': that bypasses the *user's own* DND on some servers,
      // which would be a bug dressed up as a feature.
      urgency: 'normal',
      expireTimeoutMs: 0,
      category: rendered.category,
      actions: [{ id: 'open', label: 'Open chat' }],
      payload: {
        chatId: state.chatId,
        chatName: state.chatName,
        groupKey,
        activation: 'click',
      },
      count: state.count,
    };
  }

  /** Injected by the composition root; null when no PNG could be written. */
  #iconPathProvider: (() => string | null) | null = null;

  setIconProvider(provider: () => string | null): void {
    this.#iconPathProvider = provider;
  }

  #iconPath(): string | null {
    if (this.#iconPathProvider === null) return null;
    try {
      return this.#iconPathProvider();
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* activation                                                             */
  /* ---------------------------------------------------------------------- */

  async #handleActivation(groupKey: string, actionId: string): Promise<void> {
    const state = this.#groups.get(groupKey);
    if (!state) return;
    const payload: NotificationClickPayload = {
      chatId: state.chatId,
      chatName: state.chatName,
      groupKey,
      activation: actionId === 'default' || actionId === 'open' ? 'click' : 'action',
    };
    this.#logger.info('notification activated by the user', { groupKey, chat: state.chatName, actionId });

    if (actionId === 'open' || actionId === 'default') {
      try {
        this.#onActivate?.(payload);
      } catch (error: unknown) {
        this.#logger.error('activation handler threw', error);
      }
    }
    // The user has now seen this chat (or is about to): the group and its share
    // of the badge go away. If the chat did not actually open, the next message
    // simply starts a new group - losing nothing but a redundant popup.
    this.#drop(groupKey, 'read');
    this.#unread.markChatRead(state.chatId);
  }

  /* ---------------------------------------------------------------------- */
  /* queries and manual control                                              */
  /* ---------------------------------------------------------------------- */

  #toView(key: string, state: GroupState): NotificationGroup {
    return Object.freeze({
      key,
      chatId: state.chatId,
      chatName: state.chatName,
      isGroup: state.isGroup,
      senderName: state.senderName,
      preview: state.preview,
      firstAt: state.firstAt,
      lastAt: state.lastAt,
      count: state.count,
      hasMedia: state.hasMedia,
      status: state.status,
      backendId: state.renderedId,
      renderedId: state.renderedId,
    });
  }

  getQueue(): readonly NotificationGroup[] {
    return [...this.#groups.entries()]
      .sort((a, b) => b[1].lastAt - a[1].lastAt)
      .map(([key, state]) => this.#toView(key, state));
  }

  get groups(): number {
    return this.#groups.size;
  }

  /** Messages waiting to be rendered (count grew since the last delivery). */
  get queuedCount(): number {
    let total = 0;
    for (const state of this.#groups.values()) {
      total += Math.max(0, state.count - state.deliveredCount);
    }
    return total;
  }

  get snapshot(): NotificationQueueSnapshot {
    return {
      groups: this.getQueue(),
      totalMessages: [...this.#groups.values()].reduce((sum, state) => sum + state.count, 0),
      suppressed: this.#stats.suppressed,
      delivered: this.#stats.delivered,
      failed: this.#stats.failed,
      groupingIntervalMs: this.#settings.get('groupingIntervalMs'),
      expireAfterMs: this.#settings.get('expireAfterMs'),
    };
  }

  get stats(): NotificationStats {
    return { ...this.#stats };
  }

  /** The chat was opened from the app itself: forget its group. */
  markChatRead(chatId: string): void {
    for (const [key, state] of [...this.#groups]) {
      if (state.chatId === chatId) {
        this.#drop(key, 'read');
        this.#unread.markChatRead(chatId);
      }
    }
  }

  clearAll(reason: 'manual' | 'shutdown' = 'manual'): void {
    for (const key of [...this.#groups.keys()]) this.#drop(key, reason);
    this.#recentDeliveries.length = 0;
  }

  #drop(groupKey: string, reason: 'expired' | 'read' | 'manual' | 'shutdown'): void {
    const state = this.#groups.get(groupKey);
    if (!state) return;
    if (state.flushTimer !== null) this.#timers.clearTimeout(state.flushTimer);
    if (state.expiryTimer !== null) this.#timers.clearTimeout(state.expiryTimer);
    if (state.renderedId !== null) {
      this.#byRenderedId.delete(state.renderedId);
      void this.#service.close(state.renderedId).catch(() => undefined);
    }
    this.#groups.delete(groupKey);
    this.#groupMessages.delete(groupKey);
    this.emit('cleared', { groupKey, reason });
    this.emit('changed', { groups: this.#groups.size, queued: this.queuedCount });
  }

  /**
   * Route an activation for a group as if the user had clicked its
   * notification. Used by the tray's "test notification" flow and by the smoke
   * harness, because a headless test cannot click a real notification.
   */
  async simulateActivation(groupKey: string): Promise<boolean> {
    if (!this.#groups.has(groupKey)) return false;
    await this.#handleActivation(groupKey, 'default');
    return true;
  }

  /** The first group key in the queue (diagnostics and tests). */
  get firstGroupKey(): string | null {
    const first = this.#groups.keys().next();
    return first.done === true ? null : first.value;
  }

  /**
   * Called when the app regains focus: drop already-delivered groups so their
   * (now stale) popups disappear, but keep pending ones - the user may still be
   * typing in another chat and the count matters later.
   */
  onWindowFocused(): void {
    for (const [key, state] of [...this.#groups]) {
      if (state.count <= state.deliveredCount) this.#drop(key, 'read');
    }
  }

  get settings(): Readonly<{ groupingIntervalMs: number; expireAfterMs: number; groupingEnabled: boolean }> {
    return {
      groupingEnabled: this.#settings.get('groupingEnabled'),
      groupingIntervalMs: this.#settings.get('groupingIntervalMs'),
      expireAfterMs: this.#settings.get('expireAfterMs'),
    };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#serviceClickOff?.();
    this.#serviceDismissOff?.();
    this.#dndOff?.();
    this.#settingsOff?.();
    for (const key of [...this.#groups.keys()]) this.#drop(key, 'shutdown');
    this.#recent.clear();
    this.#groupMessages.clear();
    await this.#service.closeAll();
    this.removeAllListeners();
  }

  /** Exposed for the settings window preview button. */
  previewNotification(overrides: Partial<DetectedMessage> = {}): void {
    const now = this.#clock();
    // A stable chat id, so pressing the button twice demonstrates grouping
    // ("2 new messages") instead of producing two unrelated chats.
    this.ingest({
      id: `preview:${now}`,
      chatId: 'chat:preview',
      chatName: 'Preview Chat',
      senderName: 'Alice',
      isGroup: false,
      body: 'This is a test notification from WhatsApp Desktop.',
      hasMedia: false,
      timestamp: now,
      source: 'dom-notification',
      titleUnreadCount: null,
      ...overrides,
    });
  }

  /** Test/diagnostics helper: number of messages remembered as seen. */
  get dedupeSize(): number {
    return this.#recent.size;
  }
}
