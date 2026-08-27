/**
 * Preload for the WhatsApp Web contents.
 *
 * Security posture
 * ----------------
 *  - Runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
 *    There is no `require`, no `fs`, no `child_process` here - only the three
 *    Electron modules below.
 *  - The bridge exposed to `web.whatsapp.com` is *read only and informational*.
 *    The page gets no function that can call into the main process. Everything
 *    the wrapper needs travels the other way: this file *sends* observations.
 *  - The detector is injected into the page world with `webFrame.executeJavaScript`
 *    rather than `eval`, because the isolated world of a sandboxed preload
 *    cannot see the page's DOM at all (by design) and the page's own CSP must
 *    not be weakened.
 *
 * Trust model
 * -----------
 * Anything arriving from the page world is treated as hostile input, even
 * though the origin is WhatsApp: it is rate limited, size limited, and forwarded
 * verbatim to the main process, which validates it again. That is deliberate -
 * the renderer boundary is where a compromised or changed page would try to
 * talk, and the main process must not care.
 */

import { contextBridge, ipcRenderer, webFrame } from 'electron';

import { DETECTOR_CHANNEL, DETECTOR_KINDS } from '../main/detection/DetectionScript.js';
import { IPC, LIMITS } from '../shared/constants.js';
import { collapseWhitespace } from '../shared/util.js';

/** Frames we will ever touch: exactly one, the top one. */
const isTopFrame = (): boolean => {
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
};

interface DetectorEvent {
  readonly channel: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly at: number;
}

class Bridge {
  #installed = false;
  #ready = false;
  #attempts = 0;
  #tokenBucket = { tokens: 40, updated: Date.now() };
  #dropped = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    if (this.#installed) return;
    this.#installed = true;
    if (!isTopFrame()) {
      // Sub-frames (media viewers, map previews) never produce notifications;
      // installing there would only multiply the message volume.
      return;
    }
    window.addEventListener('message', (event) => this.onMessage(event), false);
    void this.inject();
  }

  private async inject(): Promise<void> {
    this.#attempts += 1;
    let offer: { ok: boolean; value?: { source: string; enabled: boolean } } | undefined;
    try {
      offer = (await ipcRenderer.invoke('wa:get-detector')) as typeof offer;
    } catch (error: unknown) {
      this.report('detector request failed', error);
      return;
    }
    if (!offer || offer.ok !== true || offer.value === undefined) return;
    if (offer.value.enabled === false) {
      // Notifications are off: nothing to observe, nothing to retry.
      return;
    }
    const source = offer.value.source;
    if (typeof source !== 'string' || source.length === 0) return;
    try {
      // The promise resolves with whatever the script returns ('installed',
      // 'already-installed'). We do not depend on it.
      void webFrame.executeJavaScript(source, false);
    } catch (error: unknown) {
      this.report('detector injection failed', error);
    }
    this.armReadinessTimer();
  }

  /**
   * If the page never answers with `ready`, retry a few times. This is the
   * "WhatsApp changed its markup" safety net: the wrapper keeps working, just
   * without native notifications, and logs one clear line about it.
   */
  private armReadinessTimer(): void {
    if (this.#ready || this.#retryTimer !== null) return;
    if (this.#attempts > 3) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#ready) return;
      this.#dropped += 1;
      void this.inject();
    }, 5_000);
    this.#retryTimer.unref?.();
  }

  private onMessage(event: MessageEvent): void {
    const data = event.data as DetectorEvent | undefined;
    if (!data || typeof data !== 'object') return;
    if (data.channel !== DETECTOR_CHANNEL) return;
    // Only the top frame of *this* window, and only the world that received the
    // payload synchronously (postMessage is same-window): both are cheap checks
    // that rule out sub-frames and any other browsing context.
    if (event.source !== window) return;
    if (!this.rateLimit()) {
      this.#dropped += 1;
      if (this.#dropped === 20) this.report('detector flooded the bridge; messages are being dropped', null);
      return;
    }
    if (typeof data.payload !== 'object' || data.payload === null) return;

    switch (data.kind) {
      case DETECTOR_KINDS.message:
        ipcRenderer.send(IPC.whatsapp.detected, clampPayload(data.payload));
        break;
      case DETECTOR_KINDS.session:
      case DETECTOR_KINDS.ready: {
        if (data.kind === DETECTOR_KINDS.ready) this.#ready = true;
        const payload = data.payload as Record<string, unknown>;
        // Normalise both kinds into the one `session` shape the main process
        // validates: the page world must never choose the contract.
        ipcRenderer.send(IPC.whatsapp.session, {
          state: typeof payload['state'] === 'string' ? payload['state'] : (payload['session'] ?? 'loading'),
          url: window.location.href,
          at: Date.now(),
          titleUnreadCount: typeof payload['titleUnreadCount'] === 'number' ? payload['titleUnreadCount'] : null,
          detectorInstalled: true,
        });
        break;
      }
      case DETECTOR_KINDS.error:
        ipcRenderer.send(IPC.whatsapp.rendererError, data.payload);
        // A dead detector is worth knowing about: report the session channel too
        // so the status view stops claiming it is installed.
        ipcRenderer.send(IPC.whatsapp.session, {
          state: 'error',
          url: window.location.href,
          at: Date.now(),
          titleUnreadCount: null,
          detectorInstalled: false,
        });
        break;
      default:
        return;
    }
  }

  /** 40 messages, refilled at 20/s: far above any real burst, below a DoS. */
  private rateLimit(): boolean {
    const now = Date.now();
    const elapsed = (now - this.#tokenBucket.updated) / 1_000;
    this.#tokenBucket.updated = now;
    this.#tokenBucket.tokens = Math.min(40, this.#tokenBucket.tokens + elapsed * 20);
    if (this.#tokenBucket.tokens < 1) return false;
    this.#tokenBucket.tokens -= 1;
    return true;
  }

  private report(message: string, error: unknown): void {
    try {
      ipcRenderer.send(IPC.whatsapp.rendererError, {
        message,
        stack: error instanceof Error ? String(error.stack ?? '').slice(0, 2_000) : null,
      });
    } catch {
      /* the bridge is gone; nothing to do */
    }
  }
}

/**
 * Trim the worst cases before the message even reaches IPC. The main process
 * repeats this: the two layers must not need to agree on the details, only on
 * the fact that both clamp.
 */
function clampPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const input = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['id', 'chatId', 'chatName', 'senderName', 'body']) {
    const value = input[key];
    if (typeof value === 'string') out[key] = collapseWhitespace(value).slice(0, LIMITS.previewMaxChars);
    else if (value === null || value === undefined) out[key] = value ?? '';
  }
  out['isGroup'] = input['isGroup'] === true;
  out['hasMedia'] = input['hasMedia'] === true;
  out['timestamp'] = typeof input['timestamp'] === 'number' ? input['timestamp'] : Date.now();
  out['source'] = typeof input['source'] === 'string' ? input['source'] : 'dom-notification';
  if (typeof input['titleUnreadCount'] === 'number') out['titleUnreadCount'] = input['titleUnreadCount'];
  return out;
}

/* -------------------------------------------------------------------------- */
/* the only thing the page can see                                             */
/* -------------------------------------------------------------------------- */

contextBridge.exposeInMainWorld('waDesktop', {
  isDesktopApp: true,
  app: 'whatsapp-desktop',
  platform: process.platform,
} as const);

new Bridge().start();
