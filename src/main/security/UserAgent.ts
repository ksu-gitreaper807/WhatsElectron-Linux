/**
 * Browser identity presented to WhatsApp Web.
 *
 * WhatsApp Web refuses to run in a browser it does not recognise, and Electron's
 * default User-Agent is unmissable:
 *
 *   Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)
 *   whatsapp-desktop/1.0.0 Chrome/152.0.7977.54 Electron/44.0.0 Safari/537.36
 *                                    ^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^
 *
 * The page then shows "WhatsApp works with Google Chrome 100+" and refuses to
 * boot. So the identity is derived from the UA Electron would have sent and the
 * two identifying tokens are removed, which yields a canonical
 * Chrome-stable-on-Linux UA without hardcoding any version:
 *
 *   Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)
 *   Chrome/152.0.7977.54 Safari/537.36
 *
 * Why this is not a security tradeoff: it changes an *advertised string*, not
 * the sandbox, the origin, the CSP or the permissions the page gets. It is the
 * ordinary price of wrapping a site in a Chromium shell, and the same trick the
 * official desktop clients use.
 *
 * Why no `webRequest` rewriting and no page script: the point is to stop the
 * page from refusing to load, not to lie to it in depth. If a future WhatsApp
 * build starts checking `navigator.userAgentData` (client hints, exposed to page
 * JavaScript), a header override would not help and a JS shim would be page
 * tampering - so the escape hatch is `userAgentMode: 'default'` plus a manual
 * string, and the honest answer stays in the docs.
 */

/** Product tokens that must not reach WhatsApp Web. */
const ELECTRON_TOKEN = /\s+Electron\/[^\s]+/giu;
/** `<appName>/<version>` token(s) that Electron inserts before `Chrome/`. */
const APP_TOKEN = /\s+[\w.()-]+\/[\w.+-]+(?=\s+Chrome\/)/gu;
/** Anything a header would not like: CR, LF, NUL, other control bytes. */
// eslint-disable-next-line no-control-regex -- rejecting control bytes in a header value is the whole point
const CONTROL_BYTES = /[\u0000-\u001F\u007F]/u;

export const MIN_UA_LENGTH = 16;
export const MAX_UA_LENGTH = 512;

/** Reject anything unusable as a header value; never sanitise-and-accept. */
export function isSafeUserAgent(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < MIN_UA_LENGTH || trimmed.length > MAX_UA_LENGTH) return false;
  if (CONTROL_BYTES.test(trimmed)) return false;
  // A UA that does not look like a UA at all is a typo, not an override.
  return /Mozilla\/5\.0/u.test(trimmed) && /AppleWebKit\/\d+/u.test(trimmed);
}

/**
 * Strip Electron/app identity from a UA string. Pure and total: if the input
 * does not contain a `Chrome/<version>` token it is returned unchanged, because
 * inventing a UA is worse than keeping the (already broken) one.
 */
export function chromeIdentity(userAgent: string): string {
  const stripped = userAgent.replace(ELECTRON_TOKEN, '').replace(APP_TOKEN, '').trim();
  if (!/Chrome\/\d+/u.test(stripped)) return userAgent.trim();
  return stripped;
}

export type UserAgentMode = 'chrome' | 'default' | 'custom';

export interface ResolvedUserAgent {
  /** The value to pass to `session.setUserAgent`, or null to leave Electron's. */
  readonly value: string | null;
  readonly mode: UserAgentMode;
  readonly reason: string | null;
}

/**
 * Decide what to send.
 *
 * `default` is a deliberate escape hatch: if a WhatsApp change ever makes a
 * Chrome-styled UA *worse*, the user can turn the override off in Settings
 * without waiting for a release.
 */
export function resolveUserAgent(mode: UserAgentMode, electronUserAgent: string, custom?: unknown): ResolvedUserAgent {
  if (mode === 'default') {
    return { value: null, mode, reason: 'Electron default identity (WhatsApp Web may refuse this)' };
  }
  if (mode === 'custom') {
    if (!isSafeUserAgent(custom)) {
      return {
        value: null,
        mode,
        reason:
          'custom user agent rejected (must be 16-512 chars, contain Mozilla/5.0 + AppleWebKit, and no control characters)',
      };
    }
    return { value: custom.trim(), mode, reason: null };
  }
  const derived = chromeIdentity(electronUserAgent);
  if (derived === electronUserAgent.trim()) {
    return { value: null, mode, reason: 'could not derive a Chrome identity from the runtime UA' };
  }
  if (!isSafeUserAgent(derived)) {
    return { value: null, mode, reason: 'derived user agent failed validation' };
  }
  return { value: derived, mode, reason: null };
}

/** What the page will see, for the diagnostics view. */
export interface BrowserIdentityProbe {
  readonly userAgent: string;
  readonly brands: readonly string[];
  readonly mobile: boolean | null;
  readonly platform: string | null;
}

export function formatIdentity(probe: BrowserIdentityProbe): string {
  return `ua="${probe.userAgent}" brands=[${probe.brands.join(', ')}] mobile=${String(probe.mobile)} platform=${probe.platform ?? '?'}`;
}
