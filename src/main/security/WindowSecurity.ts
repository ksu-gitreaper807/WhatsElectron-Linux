/**
 * Electron hardening for the two kinds of web contents this application owns:
 *
 *  - the WhatsApp Web contents: untrusted remote content, *sandboxed*, with a
 *    read only preload,
 *  - the settings contents: our own local UI, sandboxed as well, so no renderer
 *    in this process ever has Node access.
 *
 * All decisions are delegated to `UrlPolicy` (pure, unit tested); this module is
 * only the adapter that maps decisions onto Electron events.
 */

import { app, session, shell, type Session, type WebContents, type WebPreferences } from 'electron';

import { WHATSAPP_ORIGIN, WHATSAPP_PARTITION } from '../../shared/constants.js';
import type { Logger } from '../lib/logger.js';
import type { WindowRole } from './RoleRegistry.js';
import {
  decideFrameNavigation,
  decideInternalWindowNavigation,
  decideShellOpen,
  decideTopLevelNavigation,
  decideWindowOpen,
} from './UrlPolicy.js';

/** Permissions WhatsApp Web legitimately asks for. Everything else: denied. */
const GRANTED_PERMISSIONS: ReadonlySet<string> = new Set([
  'notifications',
  'geolocation',
  'media',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'openExternal',
  'speaker-selection',
  'idle-detection',
  'display-capture',
  'storage-access',
  'top-level-storage-access',
]);

export interface SecurityHooks {
  readonly logger: Logger;
  readonly role: WindowRole;
  readonly roles: { of(contents: WebContents | null): WindowRole | null };
  /**
   * Overrides `shell.openExternal`. Exposed so the policy can be observed in
   * tests and so the app can show its own confirmation later.
   */
  readonly openExternal?: (url: string) => void;
  readonly devTools?: boolean | undefined;
}

/**
 * The webPreferences used for the WhatsApp window. A pure factory so tests can
 * assert on the security flags without launching Electron.
 */
export function buildWebPreferences(options: {
  readonly preloadPath: string;
  readonly devTools: boolean;
  readonly args: readonly string[];
  readonly partition?: string;
}): WebPreferences {
  return {
    // --- non negotiable security baseline ---
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    // --- wrapper specific ---
    partition: options.partition ?? WHATSAPP_PARTITION,
    preload: options.preloadPath,
    devTools: options.devTools,
    // A window hidden in the tray must keep receiving messages - that is the
    // entire point of a tray wrapper. Without this Chromium throttles timers in
    // hidden contents to roughly one tick per minute and notifications stop.
    backgroundThrottling: false,
    javascript: true,
    images: true,
    textAreasAreResizable: false,
    zoomFactor: 1.0,
    spellcheck: false,
    additionalArguments: [...options.args],
  };
}

/** Apply the navigation / popup / crash policy to one web contents. */
export function applyWindowSecurity(contents: WebContents, hooks: SecurityHooks): void {
  const { logger, role } = hooks;
  const devTools = hooks.devTools ?? !app.isPackaged;

  // 1. Top level navigation is restricted to WhatsApp Web.
  contents.on('will-navigate', (event) => {
    const url = event.url;
    const action = role === 'settings' ? decideInternalWindowNavigation(url) : decideTopLevelNavigation(url);
    if (action === 'allow') return;
    event.preventDefault();
    if (action === 'external') {
      logger.info('navigation outside WhatsApp Web delegated to the default browser', { url });
      openExternally(url, hooks);
      return;
    }
    logger.warn('blocked navigation', { url, role });
  });

  // 2. Sub frames: same origin or WhatsApp owned, nothing else.
  contents.on('will-frame-navigate', (event) => {
    const action = decideFrameNavigation(event.url, role === 'settings' ? '' : WHATSAPP_ORIGIN);
    if (action === 'allow') return;
    event.preventDefault();
    logger.warn('blocked frame navigation', { url: event.url, role });
  });

  // 3. No new windows, ever. `window.open` returns null inside the page.
  contents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url);
    if (decision.openExternal) {
      logger.info('popup denied, opening in default browser', { url });
      openExternally(url, hooks);
    } else {
      logger.warn('popup denied', { url });
    }
    return { action: 'deny' };
  });

  // 4. <webview> is disabled by webPreferences; deny attachment anyway.
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    logger.warn('blocked <webview> attachment');
  });

  // 5. Downloads are audited at session level (see applySessionSecurity): the
  //    default behaviour - native save dialog - is what users expect.

  // 6. Renderer failures are logged here; AppLifecycle decides what to do.
  contents.on('render-process-gone', (_event, details) => {
    logger.error('render process gone', undefined, {
      role,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  contents.on('unresponsive', () => {
    logger.warn('renderer unresponsive', { role });
  });
  contents.on('console-message', (event) => {
    // Only interesting severities; WhatsApp is chatty at debug level.
    if (event.level === 'warning' || event.level === 'error') {
      logger.debug('renderer console', {
        role,
        level: event.level,
        message: event.message.slice(0, 300),
        line: event.lineNumber,
      });
    }
  });

  if (!devTools) {
    contents.on('devtools-opened', () => {
      contents.closeDevTools();
      logger.warn('devtools are disabled in packaged builds');
    });
  }
}

function openExternally(url: string, hooks: SecurityHooks): void {
  if (decideShellOpen(url) !== 'external') {
    hooks.logger.warn('refused to open external url', { url });
    return;
  }
  if (hooks.openExternal) {
    hooks.openExternal(url);
    return;
  }
  void shell.openExternal(url).catch((error: unknown) => {
    hooks.logger.error('shell.openExternal failed', error);
  });
}

/**
 * Session level hardening, called once per session.
 *
 * Note what is deliberately *absent*: no `clearStorageData`, no `flushCache` on
 * quit, no UA override, no request interception. The login session has to
 * survive restarts, and every interception point is a chance to break WhatsApp
 * (or to become a privacy problem) for no functional gain.
 */
export function applySessionSecurity(target: Session, hooks: Pick<SecurityHooks, 'logger' | 'roles'>): void {
  const { logger } = hooks;

  target.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const role = hooks.roles.of(webContents);
    const requestingUrl = details.requestingUrl ?? '';
    const fromWhatsApp = isWhatsAppUrl(requestingUrl);
    const allowed = role === 'whatsapp' && fromWhatsApp && GRANTED_PERMISSIONS.has(permission);
    logger[allowed ? 'info' : 'warn'](`permission ${allowed ? 'granted' : 'denied'}`, {
      permission,
      requestingUrl: requestingUrl.slice(0, 200),
    });
    // Always answer: leaving a permission request pending hangs the page.
    callback(allowed);
  });

  target.setPermissionCheckHandler((checkContents, permission, requestingOrigin) => {
    if (checkContents === null) return false;
    const role = hooks.roles.of(checkContents);
    const fromWhatsApp = isWhatsAppUrl(requestingOrigin);
    return role === 'whatsapp' && fromWhatsApp && GRANTED_PERMISSIONS.has(permission);
  });

  target.on('will-download', (_event, item) => {
    logger.info('download started', {
      filename: item.getFilename(),
      totalBytes: item.getTotalBytes(),
      url: item.getURL().slice(0, 200),
    });
  });

  logger.debug('session security applied', {
    isDefaultSession: target === session.defaultSession,
    grantedPermissions: [...GRANTED_PERMISSIONS],
  });
}

function isWhatsAppUrl(rawUrl: string): boolean {
  if (rawUrl === WHATSAPP_ORIGIN) return true;
  try {
    const parsed = new URL(rawUrl);
    return parsed.origin === WHATSAPP_ORIGIN || parsed.hostname === WHATSAPP_PARTITION_HOST;
  } catch {
    return false;
  }
}

const WHATSAPP_PARTITION_HOST = 'web.whatsapp.com';

/** Resolve the persistent partition used for the WhatsApp Web session. */
export function whatsappWebSession(): Session {
  return session.fromPartition(WHATSAPP_PARTITION);
}
