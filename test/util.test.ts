import { describe, expect, it } from 'vitest';

import {
  BoundedSet,
  clampNumber,
  collapseWhitespace,
  dedupeKeyOf,
  formatBadgeTitle,
  hashString,
  nonEmptyString,
  sanitizeName,
  truncate,
} from '../src/shared/util.js';

describe('truncate / collapseWhitespace', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(collapseWhitespace('  a \n\t  b  ')).toBe('a b');
  });

  it('removes zero width characters and control bytes', () => {
    expect(collapseWhitespace('a​b﻿c')).toBe('a b c');
    expect(collapseWhitespace('bell\x07here')).toBe('bell here');
    expect(collapseWhitespace('esc\u001B[31mred')).toBe('esc [31mred');
  });

  it('counts characters, not UTF-16 units, and never splits a surrogate pair', () => {
    const emoji = 'a😀b😀c😀d😀e😀'.repeat(30);
    const out = truncate(emoji, 10);
    // The documented limit is in *characters*: an emoji costs one character and
    // two UTF-16 units, so `.length` may exceed the bound while the visible
    // length does not. What must never happen is a lone surrogate (mojibake).
    expect(Array.from(out).length).toBeLessThanOrEqual(10);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    // an orphan low surrogate would render as � in the notification
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('adds an ellipsis only when it cut something', () => {
    expect(truncate('short', 100)).toBe('short');
    expect(truncate('long enough to cut', 6)).toBe('long …');
  });

  it('survives non strings', () => {
    expect(collapseWhitespace(undefined as unknown as string)).toBe('');
    expect(truncate(null as unknown as string, 5)).toBe('');
  });
});

describe('name handling', () => {
  it('falls back when the page gives nothing usable', () => {
    expect(sanitizeName('   ', 'WhatsApp', 20)).toBe('WhatsApp');
    expect(sanitizeName(42, 'WhatsApp', 20)).toBe('WhatsApp');
    expect(sanitizeName('Alice', 'WhatsApp', 20)).toBe('Alice');
  });

  it('returns null for empty after sanitising', () => {
    expect(nonEmptyString('  ')).toBeNull();
    expect(nonEmptyString(5)).toBeNull();
    expect(nonEmptyString(' x ')).toBe('x');
  });
});

describe('numbers', () => {
  it('clamps into range and rejects nonsense', () => {
    expect(clampNumber(5, 1, 10)).toBe(5);
    expect(clampNumber(-1, 1, 10)).toBe(1);
    expect(clampNumber(100, 1, 10)).toBe(10);
    expect(clampNumber(Number.NaN, 1, 10, 7)).toBe(7);
    expect(clampNumber('3' as unknown as number, 1, 10, 2)).toBe(2);
  });
});

describe('badge titles', () => {
  it('shows nothing at zero, the number above, and a soft cap', () => {
    expect(formatBadgeTitle('WhatsApp', 0, 99)).toBe('WhatsApp');
    expect(formatBadgeTitle('WhatsApp', 5, 99)).toBe('WhatsApp (5)');
    expect(formatBadgeTitle('WhatsApp', 500, 99)).toBe('WhatsApp (99+)');
  });
});

describe('BoundedSet', () => {
  it('reports first sight correctly', () => {
    const set = new BoundedSet(3);
    expect(set.add('a')).toBe(true);
    expect(set.add('a')).toBe(false);
    expect(set.size).toBe(1);
  });

  it('evicts the oldest entries and stays bounded', () => {
    const set = new BoundedSet(3);
    for (const key of ['a', 'b', 'c', 'd']) set.add(key);
    expect(set.size).toBe(3);
    expect(set.has('a')).toBe(false);
    expect(set.has('d')).toBe(true);
  });

  it('tolerates a silly limit', () => {
    const set = new BoundedSet(0);
    set.add('x');
    expect(set.has('x')).toBe(true);
  });
});

describe('hashing', () => {
  it('is stable, short and collision-resistant enough for grouping', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    expect(dedupeKeyOf('a', 'b').length).toBeLessThan(12);
    expect(dedupeKeyOf('a', 'b')).toBe(dedupeKeyOf('a', 'b'));
  });
});
