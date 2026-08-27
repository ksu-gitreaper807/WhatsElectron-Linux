import { describe, expect, it } from 'vitest';

import {
  decideFrameNavigation,
  decideShellOpen,
  decideTopLevelNavigation,
  decideWindowOpen,
  isAllowedHost,
  isLocalHostName,
  parseUrl,
  shouldOpenExternally,
} from '../src/main/security/UrlPolicy.js';

/**
 * The navigation policy is the boundary that keeps this application "a WhatsApp
 * window" instead of a general purpose browser. Every case below is a decision
 * that a compromised or changed page could try to force.
 */

const WHATSAPP = 'https://web.whatsapp.com';

describe('parseUrl', () => {
  it('returns null for anything unparseable or absurdly long', () => {
    expect(parseUrl('')).toBeNull();
    expect(parseUrl('not a url')).toBeNull();
    expect(parseUrl('https://x'.repeat(9_000))).toBeNull();
  });

  it('understands blob: URLs by unwrapping the inner origin', () => {
    const parsed = parseUrl('blob:https://web.whatsapp.com/0f0f-1234');
    expect(parsed?.scheme).toBe('blob');
    expect(parsed?.origin).toBe(WHATSAPP);
  });
});

describe('decideTopLevelNavigation', () => {
  const allowed = [
    'https://web.whatsapp.com/',
    'https://web.whatsapp.com/#forceJid=123',
    'https://web.whatsapp.com/media?v=1',
    'about:blank',
  ];
  it.each(allowed)('allows %s', (url) => {
    expect(decideTopLevelNavigation(url)).toBe('allow');
  });

  const denied = [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'chrome://version',
    'devtools://devtools/bundled/inspector.html',
    'view-source:https://web.whatsapp.com',
    'ftp://web.whatsapp.com',
    'file://localhost/etc/shadow',
  ];
  it.each(denied)('denies %s', (url) => {
    expect(decideTopLevelNavigation(url)).toBe('deny');
  });

  it('never allows an http downgrade of WhatsApp', () => {
    expect(decideTopLevelNavigation('http://web.whatsapp.com/')).toBe('deny');
  });

  it('sends unrelated https pages to the default browser instead of rendering them', () => {
    expect(decideTopLevelNavigation('https://example.com/')).toBe('external');
    expect(decideTopLevelNavigation('https://accounts.google.com/o/oauth2/auth')).toBe('external');
  });

  it('is not fooled by suffix tricks', () => {
    expect(isAllowedHost('web.whatsapp.com.evil.tld')).toBe(false);
    expect(isAllowedHost('whatsapp.net.evil.tld')).toBe(false);
    expect(isAllowedHost('evil-whatsapp.com')).toBe(false);
    expect(isAllowedHost('mmg.whatsapp.net')).toBe(true);
    expect(isAllowedHost('www.whatsapp.com')).toBe(true);
  });

  it('rejects malformed input outright', () => {
    expect(decideTopLevelNavigation('https://[bad')).toBe('deny');
    expect(decideTopLevelNavigation(undefined as unknown as string)).toBe('deny');
  });
});

describe('decideFrameNavigation', () => {
  it('allows same origin and blob/data frames', () => {
    expect(decideFrameNavigation('https://web.whatsapp.com/inner', WHATSAPP)).toBe('allow');
    expect(decideFrameNavigation('blob:https://web.whatsapp.com/x', WHATSAPP)).toBe('allow');
    expect(decideFrameNavigation('data:image/png;base64,AAA', WHATSAPP)).toBe('allow');
  });

  it('denies cross origin frames', () => {
    expect(decideFrameNavigation('https://evil.example/frame', WHATSAPP)).toBe('deny');
    expect(decideFrameNavigation('http://web.whatsapp.com/frame', WHATSAPP)).toBe('deny');
    expect(decideFrameNavigation('file:///etc/passwd', WHATSAPP)).toBe('deny');
  });
});

describe('decideWindowOpen', () => {
  it('never opens a second window, even for WhatsApp', () => {
    for (const url of [WHATSAPP + '/new', 'https://example.com', 'file:///x', 'javascript:alert(1)']) {
      expect(decideWindowOpen(url).action).toBe('deny');
    }
  });

  it('hands WhatsApp links to the browser, and drops the dangerous ones', () => {
    expect(decideWindowOpen(WHATSAPP + '/send?phone=123').openExternal).toBe(true);
    expect(decideWindowOpen('https://example.com').openExternal).toBe(true);
    expect(decideWindowOpen('file:///etc/passwd').openExternal).toBe(false);
    expect(decideWindowOpen('javascript:alert(1)').openExternal).toBe(false);
  });

  it('opens a plain http link externally while still refusing to navigate to it', () => {
    // This is the "Update Google Chrome" button on WhatsApp's own error page:
    // it must not load in our window (no downgrade), but the user clicking it
    // expects their browser to open.
    const decision = decideWindowOpen('http://www.google.com/chrome/');
    expect(decision.action).toBe('deny');
    expect(decision.openExternal).toBe(true);
    expect(decideTopLevelNavigation('http://www.google.com/chrome/')).toBe('deny');
  });
});

describe('external handoff', () => {
  it('opens https, mailto and tel, and nothing else', () => {
    expect(shouldOpenExternally('https://example.com/x')).toBe(true);
    expect(shouldOpenExternally('mailto:someone@example.com')).toBe(true);
    expect(shouldOpenExternally('tel:+15551234567')).toBe(true);
    expect(shouldOpenExternally('ftp://example.com')).toBe(false);
    expect(shouldOpenExternally('smb://share/x')).toBe(false);
    expect(shouldOpenExternally('file:///home/user/x.pdf')).toBe(false);
  });

  it('refuses to launch a browser at a loopback or link-local address', () => {
    for (const host of [
      'http://127.0.0.1:8080/',
      'http://localhost/',
      'http://192.168.1.1/admin',
      'http://[::1]/',
      'http://169.254.1.1/',
    ]) {
      expect(decideShellOpen(host)).toBe('deny');
    }
  });

  it('recognises local host names', () => {
    expect(isLocalHostName('printer.local')).toBe(true);
    expect(isLocalHostName('router.lan')).toBe(true);
    expect(isLocalHostName('example.com')).toBe(false);
  });

  it('never treats a scheme-less string as a URL', () => {
    expect(decideShellOpen('/bin/sh')).toBe('deny');
    expect(decideShellOpen('chrome-extension://abc/page.html')).toBe('deny');
  });
});
