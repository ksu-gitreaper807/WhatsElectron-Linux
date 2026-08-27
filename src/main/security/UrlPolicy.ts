/**
 * Navigation policy.
 *
 * Pure functions with no Electron import so the security boundary can be unit
 * tested without a display, a session or a browser window. `WindowSecurity` is a
 * thin adapter that maps these decisions onto `will-navigate` /
 * `setWindowOpenHandler`.
 */

import { ALLOWED_HOSTS, SAFE_EXTERNAL_HOSTS, WHATSAPP_HOST, WHATSAPP_ORIGIN } from '../../shared/constants.js';

export type NavigationAction =
  /** keep it in the current web contents */
  | 'allow'
  /** preventDefault() and let the user's real browser handle it */
  | 'external'
  /** preventDefault() and drop it */
  | 'deny';

export interface ParsedUrl {
  readonly href: string;
  readonly scheme: string;
  readonly host: string;
  readonly origin: string;
}

const ALLOWED_HOST_SET = new Set(ALLOWED_HOSTS.map((host) => host.toLowerCase()));

/**
 * Parse defensively. Note that `new URL('file://…')` succeeds, and that blob:
 * URLs have an empty `hostname`, so the *scheme* check has to come first.
 */
export function parseUrl(input: string): ParsedUrl | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 32_768) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol === 'blob:' || url.protocol === 'filesystem:') {
    // `blob:https://web.whatsapp.com/<uuid>` - unwrap the inner origin.
    const inner = url.pathname.startsWith('//') ? url.pathname.slice(2) : url.pathname;
    try {
      const innerUrl = new URL(inner);
      return { href: input, scheme: url.protocol.replace(':', ''), host: '', origin: innerUrl.origin };
    } catch {
      return { href: input, scheme: url.protocol.replace(':', ''), host: '', origin: '' };
    }
  }
  return {
    href: input,
    scheme: url.protocol.replace(':', '').toLowerCase(),
    host: url.hostname.toLowerCase(),
    origin: url.origin,
  };
}

export function isWhatsAppOrigin(origin: string): boolean {
  return origin === WHATSAPP_ORIGIN;
}

export function isAllowedHost(host: string): boolean {
  const normalized = host.replace(/^www\./, '').toLowerCase();
  if (ALLOWED_HOST_SET.has(normalized)) return true;
  // WhatsApp serves assets from a handful of domains; keep the rule explicit
  // instead of a wildcard suffix that would also match `web.whatsapp.com.evil.tld`.
  return (
    normalized === WHATSAPP_HOST ||
    normalized.endsWith('.whatsapp.net') ||
    normalized.endsWith('.whatsapp.com') ||
    normalized === 'web.whatsapp.com'
  );
}

/**
 * Top level navigation: the *only* page this application shows is WhatsApp Web.
 * Anything else that is not obviously a WhatsApp asset host leaves the app.
 */
export function decideTopLevelNavigation(rawUrl: string): NavigationAction {
  const parsed = parseUrl(rawUrl);
  if (parsed === null) return 'deny';
  if (parsed.scheme === 'about' && parsed.href === 'about:blank') return 'allow';
  if (parsed.scheme !== 'https' && parsed.scheme !== 'http') return 'deny';
  if (parsed.scheme === 'http') return 'deny'; // never allow a downgrade of WhatsApp Web
  if (isAllowedHost(parsed.host)) return 'allow';
  return 'external';
}

/**
 * Sub frames: WhatsApp embeds a few same origin iframes (payments, map
 * previews, media viewers). We allow same origin and WhatsApp owned hosts and
 * deny everything else, because a cross origin frame inside our window is
 * indistinguishable from a hijack for the user.
 */
export function decideFrameNavigation(rawUrl: string, mainOrigin: string): NavigationAction {
  const parsed = parseUrl(rawUrl);
  if (parsed === null) return 'deny';
  if (parsed.scheme === 'data' || parsed.scheme === 'blob' || parsed.scheme === 'about') return 'allow';
  if (parsed.scheme !== 'https') return 'deny';
  if (parsed.origin !== '' && parsed.origin === mainOrigin) return 'allow';
  if (isAllowedHost(parsed.host)) return 'allow';
  return 'deny';
}

/**
 * `window.open` / `target=_blank`. The wrapper must never become a general
 * purpose browser, so popups are always denied; "safe" links are handed to the
 * default browser, everything else is dropped.
 */
export function decideWindowOpen(rawUrl: string): { action: NavigationAction; openExternal: boolean } {
  const action = decideTopLevelNavigation(rawUrl);
  if (action === 'allow') {
    // Even a WhatsApp owned URL opened with window.open is not something we need
    // a second window for: hand it to the browser instead.
    return { action: 'deny', openExternal: true };
  }
  if (action === 'external') {
    return { action: 'deny', openExternal: isSafeExternalTarget(rawUrl) };
  }
  // `deny` above can mean two different things: a dangerous scheme, or plain
  // `http://`. The second is not dangerous - it only must not happen *inside our
  // window* (no downgrade of WhatsApp Web). Refusing to open
  // `http://www.google.com/chrome/` in the user's browser would be overreach, so
  // the handoff decision is made on its own terms.
  const parsed = parseUrl(rawUrl);
  if (parsed !== null && (parsed.scheme === 'http' || parsed.scheme === 'https')) {
    return { action: 'deny', openExternal: isSafeExternalTarget(parsed) };
  }
  return { action: 'deny', openExternal: false };
}

/** External links: only http(s) and never obviously local/dangerous targets. */
export function shouldOpenExternally(rawUrl: string): boolean {
  const parsed = parseUrl(rawUrl);
  if (parsed === null) return false;
  if (parsed.scheme === 'mailto' || parsed.scheme === 'tel') return true;
  if (parsed.scheme !== 'https' && parsed.scheme !== 'http') return false;
  return isSafeExternalTarget(parsed);
}

function isSafeExternalTarget(parsedOrUrl: ParsedUrl | string): boolean {
  const parsed = typeof parsedOrUrl === 'string' ? parseUrl(parsedOrUrl) : parsedOrUrl;
  if (parsed === null) return false;
  if (parsed.scheme !== 'https' && parsed.scheme !== 'http' && parsed.scheme !== 'mailto' && parsed.scheme !== 'tel') {
    return false;
  }
  if (parsed.host === '') return true; // mailto:/tel:
  if (SAFE_EXTERNAL_HOSTS.includes(parsed.host)) return true;
  if (isAllowedHost(parsed.host)) return true;
  // Reject hosts that resolve to the local network even if they are https.
  if (isLocalHostName(parsed.host)) return false;
  return true;
}

const LOCAL_HOST_RE =
  /^(localhost|.*\.local|.*\.lan|\[?::1\]?|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/i;

export function isLocalHostName(host: string): boolean {
  return LOCAL_HOST_RE.test(host.toLowerCase());
}

/** Anything we hand to `shell.openExternal` must pass this. */
export function decideShellOpen(rawUrl: string): NavigationAction {
  const parsed = parseUrl(rawUrl);
  if (parsed === null) return 'deny';
  if (parsed.scheme === 'https' || parsed.scheme === 'http' || parsed.scheme === 'mailto' || parsed.scheme === 'tel') {
    return isSafeExternalTarget(parsed) ? 'external' : 'deny';
  }
  return 'deny';
}

/** Never let the page navigate our own settings window anywhere. */
export function decideInternalWindowNavigation(rawUrl: string): NavigationAction {
  const parsed = parseUrl(rawUrl);
  if (parsed === null) return 'deny';
  return parsed.scheme === 'file' ? 'allow' : 'deny';
}
