import { describe, expect, it } from 'vitest';

import { UnreadManager } from '../src/main/unread/UnreadManager.js';
import { LIMITS } from '../src/shared/constants.js';

describe('UnreadManager', () => {
  it('counts up and down, and never goes below zero', () => {
    const manager = new UnreadManager();
    expect(manager.getCount()).toBe(0);
    manager.increment();
    manager.increment();
    expect(manager.getCount()).toBe(2);
    manager.decrement();
    expect(manager.getCount()).toBe(1);
    manager.decrement();
    manager.decrement();
    expect(manager.getCount()).toBe(0);
  });

  it('clears everything', () => {
    const manager = new UnreadManager();
    manager.increment('chat:a', 'Alice');
    manager.increment('chat:b', 'Bob');
    manager.clear();
    expect(manager.getCount()).toBe(0);
    expect(manager.snapshot.byChat).toEqual({});
  });

  it('clamps to the configured maximum', () => {
    const manager = new UnreadManager({ max: 10 });
    manager.set(500);
    expect(manager.getCount()).toBe(10);
    manager.increment('chat:x', 'X', 1_000);
    expect(manager.getCount()).toBe(10);
  });

  it('ignores NaN, negatives and non numbers', () => {
    const manager = new UnreadManager();
    manager.set(Number.NaN);
    expect(manager.getCount()).toBe(0);
    manager.set(-5);
    expect(manager.getCount()).toBe(0);
    manager.set(1_000_000_000);
    expect(manager.getCount()).toBeLessThanOrEqual(LIMITS.maxUnread);

    const fresh = new UnreadManager();
    fresh.increment('chat:a', 'A', -3);
    // A nonsense delta becomes a single increment: the counter must never go
    // backwards because a caller passed a negative number.
    expect(fresh.getCount()).toBe(1);
    fresh.decrement('chat:missing');
    expect(fresh.getCount()).toBe(0);
  });

  it('emits an event only when the value actually changes', () => {
    const manager = new UnreadManager();
    const seen: number[] = [];
    manager.on('changed', ({ count }) => seen.push(count));
    manager.increment();
    manager.set(1);
    manager.decrement();
    expect(seen).toEqual([1, 0]);
  });

  it('tracks per chat and subtracts the whole chat when it is read', () => {
    const manager = new UnreadManager();
    manager.increment('chat:a', 'Alice');
    manager.increment('chat:a', 'Alice');
    manager.increment('chat:b', 'Bob');
    expect(manager.snapshot.byChat).toEqual({ Alice: 2, Bob: 1 });
    manager.markChatRead('chat:a');
    expect(manager.getCount()).toBe(1);
    expect(manager.snapshot.byChat).toEqual({ Bob: 1 });
  });

  it('reports where the last change came from', () => {
    const manager = new UnreadManager();
    manager.increment();
    expect(manager.snapshot.source).toBe('notification');
    manager.set(4, 'title');
    expect(manager.snapshot.source).toBe('title');
    manager.clear('focus');
    expect(manager.snapshot.source).toBe('focus');
  });

  it('is safe to listen to from many places', () => {
    const manager = new UnreadManager();
    manager.setMaxListeners(128); // the test deliberately exceeds the default
    for (let index = 0; index < 60; index += 1) {
      manager.on('changed', () => undefined);
    }
    expect(() => manager.increment()).not.toThrow();
  });
});
