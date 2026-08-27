import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './helpers/harness.js';

/**
 * The notification manager owns grouping, retention, dedupe and the policy gate.
 * These tests run the real class (no Electron, no timers, no sleeps) against the
 * mock backend, and assert on what a user would see.
 */

const tick = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('NotificationManager', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  describe('grouping', () => {
    it('renders one notification per chat, not one per message', async () => {
      harness.push({ id: 'a1', body: 'first' });
      harness.push({ id: 'a2', body: 'second' });
      harness.push({ id: 'a3', body: 'third' });
      harness.clock.advance(600);
      await tick();

      expect(harness.backend.deliveries).toHaveLength(1);
      const notification = harness.backend.lastDelivery();
      expect(notification?.title).toBe('Alice');
      expect(notification?.body).toContain('3 new messages');
      expect(notification?.count).toBe(3);
      expect(notification?.body).toContain('third');
    });

    it('keeps different chats in different notifications', async () => {
      harness.push({ id: 'a1', chatId: 'chat:alice', chatName: 'Alice' });
      harness.push({ id: 'b1', chatId: 'chat:bob', chatName: 'Bob' });
      harness.clock.advance(600);
      await tick();

      expect(harness.backend.deliveries).toHaveLength(2);
      const titles = harness.backend.deliveries.map((delivery) => delivery.notification.title).sort();
      expect(titles).toEqual(['Alice', 'Bob']);
    });

    it('groups by sender when the chat id is unknown', async () => {
      harness.push({ id: 's1', chatId: '', chatName: 'Cara', senderName: 'Cara' });
      harness.push({ id: 's2', chatId: '', chatName: 'Cara', senderName: 'Cara' });
      harness.clock.advance(600);
      await tick();

      expect(harness.backend.deliveries).toHaveLength(1);
      expect(harness.backend.lastDelivery()?.count).toBe(2);
    });

    it('prefixes the author inside group chats', async () => {
      harness.push({ id: 'g1', chatId: 'chat:team', chatName: 'Team', senderName: 'Bob', isGroup: true, body: 'hi' });
      harness.clock.advance(600);
      await tick();

      const notification = harness.backend.lastDelivery();
      expect(notification?.title).toBe('Team');
      expect(notification?.body).toContain('Bob:');
    });

    it('re-renders a delivered group when more messages arrive', async () => {
      harness.push({ id: 'r1' });
      harness.clock.advance(600);
      await tick();
      expect(harness.backend.deliveries).toHaveLength(1);

      // A visible notification is not rewritten more than once a second, so the
      // second render needs one more grouping window plus that spacing.
      harness.push({ id: 'r2' });
      harness.clock.advance(1_600);
      await tick();

      expect(harness.backend.deliveries).toHaveLength(2);
      expect(harness.backend.deliveries[1]?.notification.count).toBe(2);
      // Same id: the D-Bus backend uses it to replace the visible notification
      // instead of stacking a second one.
      expect(harness.backend.deliveries[1]?.notification.id).toBe(harness.backend.deliveries[0]?.notification.id);
    });

    it('delivers immediately when grouping is off', async () => {
      await harness.settings.update({ groupingEnabled: false });
      harness.push({ id: 'x1' });
      await tick();
      harness.push({ id: 'x2' });
      await tick();

      // No grouping window, no re-render spacing: two immediate notifications.
      expect(harness.backend.deliveries).toHaveLength(2);
      expect(harness.backend.deliveries[0]?.notification.id).not.toBe(harness.backend.deliveries[1]?.notification.id);
    });
  });

  describe('unread tracking', () => {
    it('counts every message even when nothing is delivered', async () => {
      await harness.settings.update({ notificationsEnabled: false });
      harness.push({ id: 'u1' });
      harness.push({ id: 'u2' });
      harness.push({ id: 'u3' });
      harness.clock.advance(600);
      await tick();

      expect(harness.backend.deliveries).toHaveLength(0);
      expect(harness.unread.getCount()).toBe(3);
      expect(harness.manager.stats.suppressed).toBe(1);
    });

    it('never counts the same message twice', async () => {
      const message = { id: 'dup', body: 'same text', timestamp: harness.clock.now };
      harness.push(message);
      harness.push(message);
      harness.push(message);
      expect(harness.unread.getCount()).toBe(1);
    });

    it('reports per chat counters', async () => {
      harness.push({ id: 'p1', chatId: 'chat:alice', chatName: 'Alice' });
      harness.push({ id: 'p2', chatId: 'chat:alice', chatName: 'Alice' });
      harness.push({ id: 'p3', chatId: 'chat:bob', chatName: 'Bob' });
      expect(harness.unread.snapshot.byChat).toEqual({ Alice: 2, Bob: 1 });
    });
  });

  describe('do not disturb', () => {
    it('suppresses delivery but keeps queue and counters', async () => {
      await harness.dnd.enable();
      harness.push({ id: 'd1' });
      harness.push({ id: 'd2' });
      harness.clock.advance(600);
      await tick();

      expect(harness.backend.deliveries).toHaveLength(0);
      expect(harness.unread.getCount()).toBe(2);
      const group = harness.manager.getQueue()[0];
      expect(group?.status).toBe('suppressed');
      expect(group?.count).toBe(2);
    });

    it('delivers what is still pending as soon as it is turned off', async () => {
      await harness.dnd.enable();
      harness.push({ id: 'd3' });
      harness.clock.advance(600);
      await tick();
      expect(harness.backend.deliveries).toHaveLength(0);

      await harness.dnd.disable();
      await tick();

      expect(harness.backend.deliveries).toHaveLength(1);
      expect(harness.unread.getCount()).toBe(1);
    });

    it('stays silent while snoozed and resumes afterwards', async () => {
      harness.dnd.snooze(5);
      expect(harness.dnd.isEnabled()).toBe(true);
      harness.push({ id: 'sn1' });
      harness.clock.advance(600);
      await tick();
      expect(harness.backend.deliveries).toHaveLength(0);

      harness.clock.advance(5 * 60_000 + 10);
      expect(harness.dnd.isEnabled()).toBe(false);
      harness.push({ id: 'sn2' });
      harness.clock.advance(600);
      await tick();
      expect(harness.backend.deliveries.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('focus policy', () => {
    it('does not notify while the user is looking at the window', async () => {
      harness.setFocused(true);
      harness.push({ id: 'f1' });
      harness.clock.advance(600);
      await tick();

      expect(harness.backend.deliveries).toHaveLength(0);
      expect(harness.manager.getQueue()[0]?.status).toBe('suppressed');
    });

    it('drops already delivered groups when the window regains focus', async () => {
      harness.push({ id: 'f2' });
      harness.clock.advance(600);
      await tick();
      expect(harness.manager.groups).toBe(1);

      harness.manager.onWindowFocused();
      expect(harness.manager.groups).toBe(0);
    });
  });

  describe('expiry', () => {
    it('removes an idle group without touching the unread counter', async () => {
      harness.push({ id: 'e1' });
      harness.clock.advance(600);
      await tick();
      expect(harness.manager.groups).toBe(1);

      harness.clock.advance(5_001);
      expect(harness.manager.groups).toBe(0);
      expect(harness.unread.getCount()).toBe(1);
    });

    it('closes the notification it rendered', async () => {
      harness.push({ id: 'e2' });
      harness.clock.advance(600);
      await tick();
      const id = harness.backend.open.size;
      expect(id).toBe(1);

      harness.clock.advance(5_001);
      await tick();
      expect(harness.backend.open.size).toBe(0);
    });
  });

  describe('abuse resistance', () => {
    it('caps the number of concurrent groups', async () => {
      for (let index = 0; index < 120; index += 1) {
        harness.push({ id: `cap-${index}`, chatId: `chat:${index}`, chatName: `Chat ${index}`, body: 'x' });
      }
      expect(harness.manager.groups).toBeLessThanOrEqual(40);
      // and the counter keeps the truth about all 120 messages
      expect(harness.unread.getCount()).toBe(120);
    });

    it('stops opening new groups of notifications in a burst', async () => {
      for (let index = 0; index < 20; index += 1) {
        harness.push({
          id: `spam-${index}`,
          chatId: `chat:spam${index}`,
          chatName: `Spam ${index}`,
          body: 'x',
        });
      }
      harness.clock.advance(600);
      await tick();

      expect(harness.backend.deliveries.length).toBeLessThanOrEqual(9);
      expect(harness.manager.stats.rateLimited).toBeGreaterThan(0);
    });

    it('ignores payloads that are not objects', () => {
      for (const junk of [null, undefined, 42, 'string', [], {}]) {
        expect(harness.manager.ingest(junk).accepted).toBe(false);
      }
    });

    it('clamps oversized strings instead of rejecting the message', () => {
      const result = harness.manager.ingest({
        id: 'big',
        chatId: 'chat:big',
        chatName: 'A'.repeat(10_000),
        body: 'B'.repeat(100_000),
        isGroup: false,
        hasMedia: false,
        timestamp: harness.clock.now,
      });
      expect(result.accepted).toBe(true);
      const group = harness.manager.getQueue()[0];
      expect((group?.chatName ?? '').length).toBeLessThanOrEqual(121);
      expect((group?.preview ?? '').length).toBeLessThanOrEqual(241);
    });

    it('survives a backend that throws', async () => {
      harness.backend.failNext('simulated daemon failure');
      harness.push({ id: 'fail-1' });
      harness.clock.advance(600);
      await tick();

      expect(harness.manager.stats.failed).toBe(1);
      expect(harness.unread.getCount()).toBe(1);
      // and the next message still works
      harness.push({ id: 'fail-2' });
      harness.clock.advance(600);
      await tick();
      expect(harness.backend.deliveries.length).toBeGreaterThan(0);
    });
  });

  describe('activation', () => {
    it('clears the group, decrements the badge and notifies the app', async () => {
      const manager = harness.manager;

      harness.push({ id: 'act-1' });
      harness.push({ id: 'act-2' });
      harness.clock.advance(600);
      await tick();
      expect(harness.unread.getCount()).toBe(2);

      const notificationId = harness.backend.lastDelivery()?.id ?? '';
      expect(notificationId).not.toBe('');
      harness.backend.simulateClick(notificationId);
      await tick();

      expect(manager.groups).toBe(0);
      expect(harness.unread.getCount()).toBe(0);
    });

    it('ignores activation for a group that is no longer queued', async () => {
      harness.push({ id: 'act-3' });
      harness.clock.advance(600);
      await tick();
      const delivered = harness.backend.lastDelivery();
      expect(delivered).not.toBeNull();
      const id = delivered?.id ?? '';
      const unreadBefore = harness.unread.getCount();

      // Retention expired (or the user cleared it): a late click must not
      // negative-count the badge or throw.
      harness.manager.clearAll('manual');
      await tick();
      harness.backend.simulateClick(id);
      await tick();
      expect(harness.unread.getCount()).toBe(unreadBefore);
      expect(harness.manager.groups).toBe(0);
    });
  });

  describe('presentation', () => {
    it('omits message text when previews are disabled', async () => {
      await harness.settings.update({ showPreviews: false });
      harness.push({ id: 'v1', body: 'a secret message' });
      harness.clock.advance(600);
      await tick();

      const body = harness.backend.lastDelivery()?.body ?? '';
      expect(body).toBe('New message');
      expect(body).not.toContain('secret');
    });

    it('marks media-only notifications when there is no text', async () => {
      harness.push({ id: 'm1', body: '', hasMedia: true });
      harness.clock.advance(600);
      await tick();
      expect(harness.backend.lastDelivery()?.body).toBe('Media');
    });

    it('is silent when the user turned sounds off', async () => {
      await harness.settings.update({ playSound: false });
      harness.push({ id: 's1' });
      harness.clock.advance(600);
      await tick();
      expect(harness.backend.lastDelivery()?.silent).toBe(true);
    });
  });
});
