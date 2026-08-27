/**
 * WindowManager: the only place that touches a `BrowserWindow`.
 *
 * Owns
 *  - creation of the WhatsApp Web window (webPreferences, security, session)
 *    and of the settings window,
 *  - show / hide / toggle / focus / restore-from-minimised,
 *  - the close-to-tray decision (this is where "do not quit on close" lives),
 *  - the window title, which is one of the badge surfaces,
 *  - geometry persistence and network failure recovery.
 *
 * Everything else in the application talks to it through the small public
 * surface (`show()`, `hide()`, `toggle()`, `focus()`, `quit()`, ...) and never
 * holds a `BrowserWindow` of its own.
 */

import { BrowserWindow, app, screen, shell, type Event, type Rectangle } from 'electron';

import { IPC, LIMITS, TIMEOUTS, WHATSAPP_URL, WINDOW_TITLE_BASE } from '../../shared/constants.js';
import { formatBadgeTitle } from '../../shared/util.js';
import type { SessionStateName } from '../../shared/constants.js';
import type { Logger } from '../lib/logger.js';
import { TypedEmitter, type EventMap } from '../lib/typedEmitter.js';
import { applyWindowSecurity, buildWebPreferences } from '../security/WindowSecurity.js';
import { roleArgument, type RoleRegistry } from '../security/RoleRegistry.js';
import type { SettingsStore } from '../settings/SettingsStore.js';

const RETRY_BASE_MS = 1_000;
const MAX_RETRIES = 8;
const BOUNDS_DEBOUNCE_MS = 500;

export interface WindowTitleState {
  readonly unreadCount: number;
  readonly dndActive: boolean;
  readonly showBadge: boolean;
  readonly sessionWarning: string | null;
}

export interface PageProbe {
  readonly title: string;
  readonly url: string;
  readonly userAgent: string;
  readonly brands: readonly string[];
  readonly mobile: boolean | null;
  readonly platform: string | null;
  readonly unsupported: boolean;
  readonly excerpt: string;
}

export interface WindowManagerEvents extends EventMap {
  ready: { readonly role: 'whatsapp' | 'settings' };
  visibility: { readonly visible: boolean; readonly reason: string };
  focus: { readonly focused: boolean };
  'load-failed': { readonly code: number; readonly description: string; readonly attempt: number };
  'load-slow': { readonly ms: number };
  quit: { readonly reason: string };
}

export interface WindowManagerOptions {
  readonly logger: Logger;
  readonly roles: RoleRegistry;
  readonly preloadPath: string;
  readonly settingsPreloadPath: string;
  readonly settingsHtmlPath: string;
  readonly iconPath: string | null;
  readonly boundsStore?: SettingsStore;
  /** True when a tray or a dock will bring the window back if we hide it. */
  readonly canHideToTray: () => boolean;
  readonly onQuitRequested: (reason: string) => void;
  /** True while AppLifecycle is tearing the application down. */
  readonly isQuitting: () => boolean;
  readonly devTools?: boolean;
  readonly startHidden?: boolean;
  /**
   * Enables `probeWhatsAppPage()`: a fixed, read-only expression evaluated in the
   * page for diagnostics (Settings ▸ Status and the smoke harness). Off in
   * packaged builds, where "why is WhatsApp unhappy" is not ours to answer that way.
   */
  readonly allowDiagnostics?: boolean;
}

export class WindowManager extends TypedEmitter<WindowManagerEvents> {
  readonly #logger: Logger;
  readonly #roles: RoleRegistry;
  readonly #opts: WindowManagerOptions;
  #whatsapp: BrowserWindow | null = null;
  #settings: BrowserWindow | null = null;
  #retryAttempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #navigationTimer: ReturnType<typeof setTimeout> | null = null;
  #lastFocusedAt = 0;
  #titleState: WindowTitleState = {
    unreadCount: 0,
    dndActive: false,
    showBadge: true,
    sessionWarning: null,
  };
  #boundsTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(options: WindowManagerOptions) {
    super();
    this.#opts = options;
    this.#logger = options.logger.child('window');
    this.#roles = options.roles;
  }

  /* ---------------------------------------------------------------------- */
  /* creation                                                              */
  /* ---------------------------------------------------------------------- */

  async createWhatsAppWindow(): Promise<BrowserWindow> {
    if (this.#whatsapp && !this.#whatsapp.isDestroyed()) return this.#whatsapp;

    const bounds = await this.#restoreBounds();
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: WINDOW_TITLE_BASE,
      // `name` becomes the WM_CLASS instance/class, which is what the desktop
      // environment uses to pick the icon and to group windows.
      name: 'whatsapp-desktop',
      ...(this.#opts.iconPath === null ? {} : { icon: this.#opts.iconPath }),
      autoHideMenuBar: true,
      backgroundColor: '#111b21',
      transparent: false,
      fullscreenable: true,
      webPreferences: buildWebPreferences({
        preloadPath: this.#opts.preloadPath,
        devTools: this.#opts.devTools ?? !app.isPackaged,
        args: [roleArgument('whatsapp')],
      }),
    });

    this.#whatsapp = win;
    this.#roles.register(win.webContents, 'whatsapp');
    applyWindowSecurity(win.webContents, {
      logger: this.#logger,
      role: 'whatsapp',
      roles: { of: (contents) => this.#roles.of(contents) },
      openExternal: (url) => {
        void shell.openExternal(url).catch((error: unknown) => {
          this.#logger.error('could not open the link in the default browser', error);
        });
      },
      devTools: this.#opts.devTools,
    });

    this.#attachWindowEvents(win, 'whatsapp');

    win.once('ready-to-show', () => {
      if (this.#opts.startHidden === true) {
        this.#logger.info('starting hidden (window will stay in the tray)');
        this.emit('visibility', { visible: false, reason: 'start-hidden' });
        return;
      }
      if (!win.isVisible()) win.show();
      this.emit('visibility', { visible: true, reason: 'ready-to-show' });
      this.emit('ready', { role: 'whatsapp' });
    });

    this.#watchNavigation(win);
    await win.loadURL(WHATSAPP_URL);
    this.#logger.info('WhatsApp window created', {
      partition: 'persist:whatsapp',
      bounds: win.getBounds(),
    });
    return win;
  }

  /** Opens (or focuses) the settings window. One instance only. */
  async openSettings(): Promise<BrowserWindow> {
    if (this.#settings && !this.#settings.isDestroyed()) {
      const existing = this.#settings;
      if (existing.isMinimized()) existing.restore();
      if (!existing.isVisible()) existing.show();
      existing.focus();
      return existing;
    }
    const win = new BrowserWindow({
      width: 660,
      height: 780,
      minWidth: 520,
      minHeight: 420,
      show: false,
      title: `${WINDOW_TITLE_BASE} - Settings`,
      ...(this.#opts.iconPath === null ? {} : { icon: this.#opts.iconPath }),
      autoHideMenuBar: true,
      ...(this.#whatsapp && !this.#whatsapp.isDestroyed() ? { parent: this.#whatsapp } : {}),
      modal: false,
      webPreferences: buildWebPreferences({
        preloadPath: this.#opts.settingsPreloadPath,
        devTools: this.#opts.devTools ?? !app.isPackaged,
        args: [roleArgument('settings')],
        partition: 'persist:app-settings',
      }),
    });
    this.#settings = win;
    this.#roles.register(win.webContents, 'settings');
    applyWindowSecurity(win.webContents, {
      logger: this.#logger,
      role: 'settings',
      roles: { of: (contents) => this.#roles.of(contents) },
      devTools: this.#opts.devTools,
    });
    this.#attachWindowEvents(win, 'settings');
    win.once('ready-to-show', () => {
      if (!win.isVisible()) win.show();
      this.emit('ready', { role: 'settings' });
    });
    await win.loadFile(this.#opts.settingsHtmlPath);
    return win;
  }

  closeSettings(): void {
    const win = this.#settings;
    this.#settings = null;
    if (win && !win.isDestroyed()) win.close();
  }

  /* ---------------------------------------------------------------------- */
  /* events shared by both windows                                          */
  /* ---------------------------------------------------------------------- */

  #attachWindowEvents(win: BrowserWindow, role: 'whatsapp' | 'settings'): void {
    const createdAt = Date.now();

    win.on('close', (event: Event) => {
      if (this.#disposed || role === 'settings') return;
      // Requirement: closing the main window must not terminate the app while a
      // tray (or the dock) can bring it back. Without such a surface, hiding
      // would strand the user, so we let the quit proceed.
      const hideToTray = this.#opts.canHideToTray();
      if (!hideToTray) {
        this.#logger.info('no tray available: closing the window will quit the app');
        return;
      }
      if (win.isClosable() && !this.#opts.isQuitting()) {
        event.preventDefault();
        this.hide('window-close');
        this.#logger.info('window closed to tray');
      }
    });

    win.on('minimize', () => {
      if (role !== 'whatsapp') return;
      if (this.#opts.canHideToTray() && this.#minimizeToTray()) {
        // Minimise-to-tray: the taskbar entry disappears together with the window.
        win.hide();
        this.emit('visibility', { visible: false, reason: 'minimize' });
      }
    });

    win.on('focus', () => {
      this.#lastFocusedAt = Date.now();
      this.emit('focus', { focused: true });
      if (role === 'whatsapp') win.setTitle(this.#computeTitle());
    });

    win.on('blur', () => this.emit('focus', { focused: false }));

    win.on('show', () => this.emit('visibility', { visible: true, reason: 'show' }));
    win.on('hide', () => this.emit('visibility', { visible: false, reason: 'hide' }));

    win.on('restore', () => {
      if (!win.isFocused()) win.focus();
    });

    const persist = (): void => this.#scheduleBoundsSave(win, role);
    win.on('resize', persist);
    win.on('move', persist);
    win.on('maximize', persist);
    win.on('unmaximize', persist);

    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* ABORTED */) return;
      this.#logger.warn('navigation failed', { errorCode, errorDescription, url: validatedURL });
      this.#scheduleRetry(win);
      this.emit('load-failed', { code: errorCode, description: errorDescription, attempt: this.#retryAttempt });
    });

    win.webContents.on('did-finish-load', () => {
      if (this.#retryAttempt !== 0) {
        this.#retryAttempt = 0;
        this.#logger.info('recovered after a failed load');
      }
      this.#clearNavigationTimer();
      const ms = Date.now() - createdAt;
      this.#logger.info('page finished loading', { role, ms });
      if (ms > 20_000) this.emit('load-slow', { ms });
    });

    win.webContents.on('render-process-gone', (_event, details) => {
      this.#logger.error('renderer crashed, recreating the window', undefined, { reason: details.reason });
      if (role === 'whatsapp') void this.#recreateAfterCrash(win);
    });

    win.once('closed', () => {
      if (role === 'whatsapp') this.#whatsapp = null;
      else this.#settings = null;
    });
  }

  async #recreateAfterCrash(dead: BrowserWindow): Promise<void> {
    if (this.#whatsapp === dead) this.#whatsapp = null;
    if (!this.#disposed) {
      try {
        await this.createWhatsAppWindow();
      } catch (error: unknown) {
        this.#logger.error('could not recreate the window after a crash', error);
      }
    }
  }

  #minimizeToTray(): boolean {
    // Read from settings through the getter installed by the composition root,
    // so the manager stays free of a settings import cycle.
    return this.#minimizeToTrayFlag;
  }

  #minimizeToTrayFlag = false;

  setMinimizeToTray(enabled: boolean): void {
    this.#minimizeToTrayFlag = enabled;
  }

  /* ---------------------------------------------------------------------- */
  /* navigation watchdog / retry                                            */
  /* ---------------------------------------------------------------------- */

  #watchNavigation(win: BrowserWindow): void {
    this.#clearNavigationTimer();
    this.#navigationTimer = setTimeout(() => {
      this.#navigationTimer = null;
      if (win.isDestroyed() || win.webContents.isLoading()) return;
      if (win.webContents.getURL() === '' || win.webContents.getURL() === WHATSAPP_URL) {
        this.#logger.warn('WhatsApp did not finish loading in time');
        this.#scheduleRetry(win);
      }
    }, TIMEOUTS.navigationMs);
    this.#navigationTimer.unref?.();
  }

  #clearNavigationTimer(): void {
    if (this.#navigationTimer !== null) {
      clearTimeout(this.#navigationTimer);
      this.#navigationTimer = null;
    }
  }

  #scheduleRetry(win: BrowserWindow): void {
    if (this.#retryTimer !== null || this.#disposed) return;
    if (this.#retryAttempt >= MAX_RETRIES) {
      this.#logger.error('giving up on automatic reload after repeated failures', undefined, {
        attempts: this.#retryAttempt,
      });
      this.#setTitleWarning('WhatsApp could not be loaded - press Ctrl+R to retry');
      return;
    }
    this.#retryAttempt += 1;
    const delay = RETRY_BASE_MS * 2 ** (this.#retryAttempt - 1);
    this.#logger.info('scheduling a reload', { attempt: this.#retryAttempt, delayMs: delay });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (win.isDestroyed()) return;
      this.#watchNavigation(win);
      // A full loadURL (rather than reload()) is deliberate: it re-runs the
      // navigation policy and re-injects the preload after a failed load.
      void win.webContents.loadURL(WHATSAPP_URL);
    }, delay);
    this.#retryTimer.unref?.();
  }

  /** Called from the menu / tray: manual retry resets the backoff. */
  retryLoad(): void {
    this.#retryAttempt = 0;
    const win = this.#whatsapp;
    if (!win || win.isDestroyed()) return;
    this.#watchNavigation(win);
    win.webContents.reload();
    this.#setTitleWarning(null);
  }

  /* ---------------------------------------------------------------------- */
  /* visibility API (the one the rest of the app uses)                      */
  /* ---------------------------------------------------------------------- */

  get window(): BrowserWindow | null {
    return this.#whatsapp !== null && !this.#whatsapp.isDestroyed() ? this.#whatsapp : null;
  }

  get isVisible(): boolean {
    const win = this.window;
    return win !== null && win.isVisible() && !win.isMinimized();
  }

  get isFocused(): boolean {
    const win = this.window;
    return win !== null && win.isFocused();
  }

  get windowCount(): number {
    return BrowserWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed()).length;
  }

  /** Reflect the login/loading state reported by the page (see schemas.ts). */
  setSessionState(state: SessionStateName, titleUnreadCount: number | null, detectorInstalled?: boolean | null): void {
    this.#sessionState = state;
    if (detectorInstalled !== undefined && detectorInstalled !== null) this.#detectorInstalled = detectorInstalled;
    const warning =
      state === 'error'
        ? 'WhatsApp failed to load'
        : state === 'logged-out'
          ? 'Not linked - open WhatsApp to link this device'
          : null;
    this.setTitleState({ sessionWarning: warning });
    if (titleUnreadCount !== null) this.#onTitleUnread?.(titleUnreadCount);
  }

  get sessionState(): SessionStateName {
    return this.#sessionState;
  }

  /** Called by the composition root so the window does not own the unread manager. */
  setUnreadBridge(callbacks: { onTitleUnread?: (count: number) => void }): void {
    if (callbacks.onTitleUnread) this.#onTitleUnread = callbacks.onTitleUnread;
  }

  #onTitleUnread: ((count: number) => void) | undefined = undefined;
  #sessionState: SessionStateName = 'unknown';
  #detectorInstalled = false;

  /** Whether the injected detector answered its handshake in the page world. */
  get detectorInstalled(): boolean {
    return this.#detectorInstalled;
  }

  markDetectorInstalled(value: boolean): void {
    this.#detectorInstalled = value;
  }

  /** True when this web contents belongs to a window we created. */
  ownsContents(webContentsId: number): boolean {
    return this.#roles.ofId(webContentsId) !== null;
  }

  /**
   * Read-only page diagnostics for the status view and the smoke harness. Returns
   * null unless diagnostics were explicitly enabled, and never mutates anything:
   * the expression reads a few properties and one text slice, nothing else.
   */
  async probeWhatsAppPage(): Promise<PageProbe | null> {
    if (this.#opts.allowDiagnostics !== true) return null;
    const win = this.window;
    if (win === null) return null;
    try {
      return (await win.webContents.executeJavaScript(PAGE_PROBE_EXPRESSION, true)) as PageProbe;
    } catch (error: unknown) {
      this.#logger.debug('page probe failed', { error: String(error) });
      return null;
    }
  }

  /** Every live window we own, for state broadcasts. */
  openWindows(): readonly BrowserWindow[] {
    return BrowserWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed());
  }

  show(reason = 'api'): void {
    const win = this.window;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.moveTop();
    win.focus();
    win.webContents.focus();
    this.emit('visibility', { visible: true, reason });
  }

  /**
   * Restore and focus. `show()` plus an explicit user-attention dance that
   * window managers (rightfully) may ignore: nothing here pretends it can beat
   * the compositor's focus policy.
   */
  focus(reason = 'focus'): void {
    const win = this.window;
    if (!win) return;
    this.show(reason);
    if (!win.isFocused()) win.focus();
    // Linux: `focus()` on an unfocused window can be ignored by the WM.
    // `moveTop()` + `show()` is the strongest hint that does not steal focus
    // from another application in a way the user did not ask for.
    if (typeof win.flashFrame === 'function' && !win.isFocused()) {
      win.flashFrame(true);
      setTimeout(() => {
        if (!win.isDestroyed()) win.flashFrame(false);
      }, 1_200).unref?.();
    }
  }

  hide(reason = 'api'): void {
    const win = this.window;
    if (!win) return;
    if (win.isVisible() || win.isMinimized()) win.hide();
    this.emit('visibility', { visible: false, reason });
  }

  toggle(reason = 'toggle'): boolean {
    if (this.isVisible && this.isFocused) {
      this.hide(reason);
      return false;
    }
    this.focus(reason);
    return true;
  }

  /**
   * Explicit quit. Distinct from `close()` because "the user pressed X" and
   * "the user chose Quit" are different intents and must not be confused.
   */
  quit(reason = 'window-manager'): void {
    this.#logger.info('quit requested', { reason });
    this.emit('quit', { reason });
    this.#opts.onQuitRequested(reason);
  }

  minimize(): void {
    this.window?.minimize();
  }

  maximizeOrRestore(): void {
    const win = this.window;
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }

  zoom(factor: number): void {
    const win = this.window;
    if (!win) return;
    const current = win.webContents.getZoomFactor();
    const next = Math.min(3, Math.max(0.5, Number((current + factor).toFixed(2))));
    win.webContents.setZoomFactor(next);
  }

  toggleDevTools(): void {
    const win = this.window;
    if (!win) return;
    if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
    else win.webContents.openDevTools({ mode: 'detach' });
  }

  /**
   * Best effort conversation focus, sent to our *own* preload as an opaque id.
   * No DOM automation happens: if WhatsApp does not act on it, the visible
   * outcome is simply "WhatsApp in front", which is the documented behaviour.
   */
  navigateToChat(chatId: string, chatName: string): boolean {
    const win = this.window;
    if (!win) return false;
    if (chatId.length === 0 || chatId.length > 96) return false;
    win.webContents.send(IPC.events.navigate, {
      kind: 'open-chat' as const,
      chatId,
      chatName: chatName.slice(0, LIMITS.nameMaxChars),
      nonce: Date.now(),
    });
    return true;
  }

  reload(): void {
    const win = this.window;
    if (!win) return;
    win.webContents.reload();
  }

  clearStorageWarning(): void {
    this.#setTitleWarning(null);
  }

  /* ---------------------------------------------------------------------- */
  /* title / badge                                                          */
  /* ---------------------------------------------------------------------- */

  setTitleState(patch: Partial<WindowTitleState>): void {
    this.#titleState = { ...this.#titleState, ...patch };
    const win = this.window;
    if (win) win.setTitle(this.#computeTitle());
  }

  #computeTitle(): string {
    const base = this.#titleState.showBadge
      ? formatBadgeTitle(WINDOW_TITLE_BASE, this.#titleState.unreadCount, LIMITS.badgeSoftCap)
      : WINDOW_TITLE_BASE;
    const suffix = this.#titleState.sessionWarning
      ? ` - ${this.#titleState.sessionWarning}`
      : this.#titleState.dndActive
        ? ' - Do Not Disturb'
        : '';
    return truncateTitle(`${base}${suffix}`);
  }

  #setTitleWarning(text: string | null): void {
    this.#titleState = { ...this.#titleState, sessionWarning: text };
    const win = this.window;
    if (win) win.setTitle(this.#computeTitle());
  }

  /** True while the user is looking at us, or was a moment ago. */
  isQuietNow(quietMs: number): boolean {
    if (quietMs <= 0) return this.isFocused;
    if (this.isFocused) return true;
    return this.#lastFocusedAt > 0 && Date.now() - this.#lastFocusedAt < quietMs;
  }

  /* ---------------------------------------------------------------------- */
  /* bounds persistence                                                     */
  /* ---------------------------------------------------------------------- */

  #scheduleBoundsSave(win: BrowserWindow, role: 'whatsapp' | 'settings'): void {
    if (role !== 'whatsapp' || !this.#opts.boundsStore || this.#boundsTimer !== null) return;
    this.#boundsTimer = setTimeout(() => {
      this.#boundsTimer = null;
      void this.#saveBounds(win);
    }, BOUNDS_DEBOUNCE_MS);
    this.#boundsTimer.unref?.();
  }

  async #saveBounds(win: BrowserWindow): Promise<void> {
    const store = this.#opts.boundsStore;
    if (!store || win.isDestroyed() || win.isMaximized() || win.isMinimized()) return;
    try {
      await store.write({ bounds: win.getBounds(), maximized: false, at: Date.now() });
    } catch (error: unknown) {
      this.#logger.debug('could not persist window bounds', { error: String(error) });
    }
  }

  async #restoreBounds(): Promise<Partial<Rectangle> & { maximized?: boolean; center?: boolean }> {
    const store = this.#opts.boundsStore;
    if (!store) return { width: 1100, height: 800 };
    let raw: Record<string, unknown>;
    try {
      raw = await store.read();
    } catch (error: unknown) {
      this.#logger.debug('could not read window bounds', { error: String(error) });
      return { width: 1100, height: 800 };
    }
    const bounds = sanitizeBounds(raw['bounds']);
    if (bounds === null) return { width: 1100, height: 800 };
    if (!intersectsAnyDisplay(bounds)) {
      this.#logger.info('restored window bounds are off screen, centering instead', { bounds });
      return { width: Math.max(800, bounds.width), height: Math.max(600, bounds.height), center: true };
    }
    return { ...bounds, ...(raw['maximized'] === true ? { maximized: true } : {}) };
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#clearNavigationTimer();
    if (this.#boundsTimer !== null) clearTimeout(this.#boundsTimer);
    for (const win of [this.#whatsapp, this.#settings]) {
      if (win && !win.isDestroyed()) {
        try {
          win.destroy();
        } catch {
          /* already gone */
        }
      }
    }
    this.#whatsapp = null;
    this.#settings = null;
    this.removeAllListeners();
  }
}

/**
 * The read-only expression behind `probeWhatsAppPage()`.
 *
 * A module-level constant, exported, for one reason: inside a TypeScript
 * template literal `\s` silently becomes `s`, so a regex written in one needs a
 * doubled backslash — and that class of bug is invisible until something reads
 * the output. `test/user-agent.test.ts` asserts the escapes survive, and asserts
 * the expression stays read-only.
 */
export const PAGE_PROBE_EXPRESSION = `(async () => {
  const raw = (document.body && document.body.innerText) || '';
  const text = raw.replace(/\\s+/gu, ' ').slice(0, 300);
  const hints = navigator.userAgentData || null;
  return {
    title: document.title || '',
    url: location.href,
    userAgent: navigator.userAgent || '',
    brands: hints && Array.isArray(hints.brands) ? hints.brands.map((b) => String(b && b.brand)) : [],
    mobile: hints ? Boolean(hints.mobile) : null,
    platform: hints ? String(hints.platform || '') : null,
    unsupported: /works with Google Chrome|update Google Chrome|unsupported browser|use Mozilla Firefox/iu.test(text),
    excerpt: text
  };
})();`;

function truncateTitle(value: string): string {
  // X11 window titles are not length limited in practice, but a huge title is a
  // symptom of a bug (usually an unclamped counter), not a feature.
  return value.length <= 160 ? value : `${value.slice(0, 157)}...`;
}

function sanitizeBounds(input: unknown): Rectangle | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const numbers = ['x', 'y', 'width', 'height'].map((key) => record[key]);
  if (numbers.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return null;
  const [x, y, width, height] = numbers as [number, number, number, number];
  if (Math.abs(x) > 100_000 || Math.abs(y) > 100_000) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(Math.max(600, Math.min(10_000, width))),
    height: Math.round(Math.max(400, Math.min(10_000, height))),
  };
}

function intersectsAnyDisplay(bounds: Rectangle): boolean {
  try {
    const displays = screen.getAllDisplays();
    return displays.some((display) => {
      const area = display.workArea;
      // Require at least a strip of the window to be inside a work area,
      // otherwise a half-off-screen title bar is impossible to drag back.
      const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
      const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
      return overlapX > 60 && overlapY > 60;
    });
  } catch {
    // No display information (headless CI): accept and let the WM decide.
    return true;
  }
}
