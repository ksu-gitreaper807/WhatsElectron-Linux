import { describe, expect, it } from 'vitest';

import { PAGE_PROBE_EXPRESSION } from '../src/main/window/WindowManager.js';
import { chromeIdentity, isSafeUserAgent, resolveUserAgent } from '../src/main/security/UserAgent.js';

const ELECTRON_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) whatsapp-desktop/1.0.0 Chrome/152.0.7977.54 Electron/44.0.0 Safari/537.36';
const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.54 Safari/537.36';

describe('chromeIdentity()', () => {
  it('removes the tokens that make WhatsApp Web refuse the session', () => {
    const derived = chromeIdentity(ELECTRON_UA);
    expect(derived).toBe(CHROME_UA);
    expect(derived).not.toMatch(/Electron/iu);
    expect(derived).not.toContain('whatsapp-desktop');
  });

  it('keeps the Chromium version, so the "Chrome 100+" gate is satisfied truthfully', () => {
    expect(chromeIdentity(ELECTRON_UA)).toContain('Chrome/152.0.7977.54');
  });

  it('is a no-op on an UA that already looks like Chrome', () => {
    expect(chromeIdentity(CHROME_UA)).toBe(CHROME_UA);
  });

  it('does not invent a Chrome version when there is none', () => {
    const odd = 'Mozilla/5.0 (compatible; MyBot/1.0)';
    expect(chromeIdentity(odd)).toBe(odd);
  });

  it('is idempotent', () => {
    const once = chromeIdentity(ELECTRON_UA);
    expect(chromeIdentity(once)).toBe(once);
  });
});

describe('isSafeUserAgent()', () => {
  it('accepts a normal UA', () => {
    expect(isSafeUserAgent(CHROME_UA)).toBe(true);
  });

  it('accepts any string that looks like a browser UA, even a terse one', () => {
    // The gate is "is this usable as a header value and does it look like a UA",
    // not "is this a real Chrome build": people pasting a UA from a support forum
    // must not be told their typo-free string is invalid.
    expect(isSafeUserAgent('Mozilla/5.0 AppleWebKit/537.36')).toBe(true);
  });

  const rejected: readonly unknown[] = [
    '', // empty
    42, // not a string
    null,
    undefined,
    'x'.repeat(600), // absurdly long: a smuggled payload, not a UA
    'short', // below the minimum
    'Mozilla/5.0 AppleWebKit/', // no AppleWebKit version
    'not a browser at all, really', // no Mozilla/5.0 token
    `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36${String.fromCharCode(13)}${String.fromCharCode(10)}X-Evil: 1`, // header injection
    `Mozilla/5.0 AppleWebKit/537.36 Chrome/120 ${String.fromCharCode(0)}`, // control byte
  ];

  it.each(rejected)('rejects %p', (value) => {
    expect(isSafeUserAgent(value)).toBe(false);
  });
});

describe('page probe expression', () => {
  it('keeps its escapes through the template literal', () => {
    // A single backslash here would have been eaten by TypeScript, turning the
    // whitespace collapse into a "collapse runs of the letter s" bug.
    // One backslash, exactly: what the page must receive is the regex /\s+/gu.
    expect(PAGE_PROBE_EXPRESSION).toContain(`replace(/${String.fromCharCode(92)}s+/gu`);
    expect(PAGE_PROBE_EXPRESSION).toContain('document.body.innerText');
  });

  it('is strictly read-only', () => {
    expect(PAGE_PROBE_EXPRESSION).not.toMatch(/document\.write|\.click\(|innerHTML\s*=|\.focus\(|fetch\(/);
  });
});

describe('resolveUserAgent()', () => {
  it('derives the Chrome identity by default', () => {
    const resolved = resolveUserAgent('chrome', ELECTRON_UA);
    expect(resolved.value).toBe(CHROME_UA);
    expect(resolved.reason).toBeNull();
  });

  it('leaves the runtime identity alone for "default"', () => {
    const resolved = resolveUserAgent('default', ELECTRON_UA);
    expect(resolved.value).toBeNull();
    expect(resolved.reason).toContain('may refuse');
  });

  it('uses a validated custom string', () => {
    const resolved = resolveUserAgent('custom', ELECTRON_UA, CHROME_UA);
    expect(resolved.value).toBe(CHROME_UA);
  });

  it('refuses an unusable custom string and says why, rather than sending it', () => {
    for (const bad of ['', 'x', 'not a ua', `Mozilla/5.0 AppleWebKit/1 ${String.fromCharCode(7)}`]) {
      const resolved = resolveUserAgent('custom', ELECTRON_UA, bad);
      expect(resolved.value).toBeNull();
      expect(resolved.reason).toContain('custom user agent rejected');
    }
  });

  it('degrades to the runtime UA when derivation is impossible', () => {
    const resolved = resolveUserAgent('chrome', 'Mozilla/5.0 (compatible; bot)');
    expect(resolved.value).toBeNull();
    expect(resolved.reason).toContain('could not derive');
  });
});
