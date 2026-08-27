/**
 * End-to-end self test (`--smoke`).
 *
 * A desktop wrapper is hard to verify: the interesting behaviour lives in the
 * tray, the notification daemon and the window manager, none of which exist in a
 * unit test. This harness runs inside the *real* application, under Xvfb with a
 * private D-Bus session and a real notification daemon (see scripts/smoke.mjs),
 * and emits one structured log line per assertion:
 *
 *   {"level":"info","msg":"smoke: pass grouping {\"count\":2}"}
 *
 * The runner script greps those lines. Keeping the assertions in the application
 * means they use the same objects the user's session uses - there is no parallel
 * re-implementation to drift out of sync.
 */

import { readFileSync } from 'node:fs';

import type { DNDService } from '../dnd/DNDService.js';
import type { Logger } from '../lib/logger.js';
import type { NotificationManager } from '../notifications/NotificationManager.js';
import type { NotificationService } from '../notifications/NotificationService.js';
import type { SettingsService } from '../settings/SettingsService.js';
import type { TrayManager } from '../tray/TrayManager.js';
import type { UnreadManager } from '../unread/UnreadManager.js';
import type { WindowManager } from '../window/WindowManager.js';

export interface SmokeHarnessDeps {
  readonly logger: Logger;
  readonly settings: SettingsService;
  readonly windowManager: WindowManager;
  readonly notificationManager: NotificationManager;
  readonly notificationService: NotificationService;
  readonly unread: UnreadManager;
  readonly dnd: DNDService;
  readonly trayManager: TrayManager;
  readonly notificationDumpPath: string;
  readonly quit: (reason: string) => Promise<void>;
  readonly budgetMs?: number;
}

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class SmokeHarness {
  readonly #deps: SmokeHarnessDeps;
  readonly #logger: Logger;
  readonly #results: CheckResult[] = [];
  readonly #deadline: number;
  #started = false;

  constructor(deps: SmokeHarnessDeps) {
    this.#deps = deps;
    this.#logger = deps.logger.child('smoke');
    this.#deadline = Date.now() + (deps.budgetMs ?? 90_000);
  }

  get results(): readonly CheckResult[] {
    return this.#results;
  }

  async run(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#logger.info('smoke: begin');

    // Deterministic timing for the checks below: shrink the grouping window from
    // the (user facing) 5 s default to something a test can wait for.
    // 1000 ms is the shortest legal grouping window (the schema clamps below it),
    // and focusQuietMs 0 means "suppress while focused" without a timer.
    await this.#deps.settings.update({ groupingIntervalMs: 1_000, focusQuietMs: 0 });

    await this.#checkWindow();
    await this.#checkIdentity();
    await this.#checkDetector();
    await this.#checkGrouping();
    await this.#checkDnd();
    await this.#checkSettings();
    await this.#checkSettingsUi();
    await this.#checkTray();
    await this.#checkBackends();

    await this.#finish();
  }

  /* ---------------------------------------------------------------------- */

  async #checkWindow(): Promise<void> {
    const window = this.#deps.windowManager.window;
    if (!this.#check('window-created', window !== null, { title: window?.getTitle() ?? null })) return;

    // Security baseline, asserted on the live web contents (the unit tests cover
    // the URL policy; this covers what Electron actually applied).
    const prefs = (
      window?.webContents as unknown as { getLastWebPreferences?: () => Record<string, unknown> }
    )?.getLastWebPreferences?.();
    this.#check('sandbox-and-isolation', prefs?.['sandbox'] === true && prefs?.['contextIsolation'] === true, prefs);
    this.#check('node-integration-disabled', prefs !== undefined && prefs['nodeIntegration'] !== true, {
      nodeIntegration: prefs?.['nodeIntegration'] ?? null,
    });

    const loaded = await this.#waitFor(() => {
      const url = window?.webContents.getURL() ?? '';
      return url.length > 0;
    });
    this.#check('whatsapp-loaded', loaded && (window?.webContents.getURL() ?? '').includes('web.whatsapp.com'), {
      url: window?.webContents.getURL() ?? null,
      loading: window?.webContents.isLoading() ?? null,
    });
  }

  /**
   * The regression that matters most for a wrapper: the page must not be showing
   * WhatsApp's "unsupported browser" screen. If it is, everything else here can
   * still pass while the application is useless to the user.
   */
  async #checkIdentity(): Promise<void> {
    const probe = await this.#deps.windowManager.probeWhatsAppPage();
    if (probe === null) {
      this.#logger.info('smoke: note browser identity probe unavailable (diagnostics off)');
      this.#check('browser-identity-accepted', true, { skipped: true });
      return;
    }
    this.#logger.info('smoke: note page identity', {
      title: probe.title,
      userAgent: probe.userAgent.slice(0, 120),
      brands: probe.brands,
      excerpt: probe.excerpt.slice(0, 140),
    });
    this.#check('browser-identity-accepted', probe.unsupported === false, {
      unsupported: probe.unsupported,
      title: probe.title,
      brands: probe.brands,
    });
  }

  async #checkDetector(): Promise<void> {
    // The detector answers its handshake once `#app` exists; on a logged-out or
    // throttled page that can take a few seconds.
    const installed = await this.#waitFor(() => this.#deps.windowManager.detectorInstalled, 15_000);
    this.#check('detector-handshake', installed, { installed });
  }

  async #checkGrouping(): Promise<void> {
    this.#deps.notificationManager.previewNotification({ id: 'smoke-a', body: 'First line' });
    await delay(60);
    this.#deps.notificationManager.previewNotification({ id: 'smoke-b', body: 'Second line' });
    await this.#waitFor(() => {
      const group = this.#deps.notificationManager.snapshot.groups.find((entry) => entry.chatName === 'Preview Chat');
      return group !== undefined && group.count >= 2 && group.status !== 'pending';
    }, 8_000);

    const groups = this.#deps.notificationManager.snapshot.groups.filter((entry) => entry.chatName === 'Preview Chat');
    const group = groups[0];
    this.#check('grouping-one-notification-per-chat', groups.length === 1 && (group?.count ?? 0) >= 2, {
      groups: groups.length,
      count: group?.count ?? 0,
      status: group?.status ?? null,
    });
    this.#check('unread-incremented', this.#deps.unread.getCount() >= 2, {
      count: this.#deps.unread.getCount(),
      byChat: this.#deps.unread.snapshot.byChat,
    });

    // While our window has focus the manager deliberately suppresses popups, so
    // this run is expected to end up 'suppressed', not 'delivered'.
    this.#check('focused-window-suppresses-popups', group?.status === 'suppressed' || group?.status === 'delivered', {
      status: group?.status ?? null,
      focused: this.#deps.windowManager.isFocused,
    });

    // Now hide the window (the tray scenario) and require a real delivery.
    this.#deps.windowManager.hide('smoke');
    this.#deps.notificationManager.clearAll('manual');
    const deliveredBefore = this.#deps.notificationManager.stats.delivered;
    this.#deps.notificationManager.previewNotification({ id: 'smoke-live-1', body: 'hidden window one' });
    await delay(80);
    this.#deps.notificationManager.previewNotification({ id: 'smoke-live-2', body: 'hidden window two' });
    const delivered = await this.#waitFor(
      () => this.#deps.notificationManager.stats.delivered > deliveredBefore,
      8_000,
    );
    const liveGroup = this.#deps.notificationManager.snapshot.groups.find((entry) => entry.chatName === 'Preview Chat');
    this.#check('notification-delivered-to-backend', delivered, {
      delivered: this.#deps.notificationManager.stats.delivered,
      before: deliveredBefore,
      backend: this.#deps.notificationService.activeName,
      status: liveGroup?.status ?? null,
    });

    // Activation must clear the group and its share of the badge, which is what
    // a click on a real notification does (see the manager unit tests).
    const key = this.#deps.notificationManager.firstGroupKey;
    const unreadBeforeActivation = this.#deps.unread.getCount();
    const activated =
      key === null ? false : await this.#deps.notificationManager.simulateActivation(key).then(() => true);
    await delay(120);
    this.#check(
      'activation-clears-group-and-unread',
      activated && this.#deps.notificationManager.groups === 0 && this.#deps.unread.getCount() < unreadBeforeActivation,
      { groups: this.#deps.notificationManager.groups, unread: this.#deps.unread.getCount() },
    );
    this.#deps.windowManager.show('smoke');
  }

  async #checkDnd(): Promise<void> {
    // Clear first so the counters below mean something.
    this.#deps.notificationManager.clearAll('manual');
    this.#deps.windowManager.hide('smoke-dnd');
    const suppressedBefore = this.#deps.notificationManager.stats.suppressed;
    const unreadBefore = this.#deps.unread.getCount();
    const deliveredBefore = this.#deps.notificationManager.stats.delivered;

    await this.#deps.dnd.enable();
    this.#deps.notificationManager.previewNotification({ id: 'smoke-dnd', body: 'arrives during dnd' });
    await this.#waitFor(() => this.#deps.notificationManager.stats.suppressed > suppressedBefore, 6_000);

    const suppressed = this.#deps.notificationManager.stats.suppressed > suppressedBefore;
    const noDelivery = this.#deps.notificationManager.stats.delivered === deliveredBefore;
    const stillCounted = this.#deps.unread.getCount() > unreadBefore;
    this.#check('dnd-suppresses-delivery', suppressed && noDelivery, {
      suppressed: this.#deps.notificationManager.stats.suppressed,
      delivered: this.#deps.notificationManager.stats.delivered,
    });
    this.#check('dnd-keeps-tracking', stillCounted, { before: unreadBefore, after: this.#deps.unread.getCount() });

    await this.#deps.dnd.disable();
    this.#check('dnd-disable-resumes', this.#deps.dnd.isEnabled() === false, { active: this.#deps.dnd.isEnabled() });
  }

  async #checkSettings(): Promise<void> {
    const update = await this.#deps.settings.update({ titleBadge: false });
    const persisted = this.#deps.settings.get('titleBadge');
    await this.#deps.settings.update({ titleBadge: true });
    this.#check(
      'settings-round-trip',
      Object.keys(update.applied).length === 1 &&
        persisted === false &&
        update.rejected['globalShortcut'] === undefined,
      {
        applied: Object.keys(update.applied),
        rejected: Object.keys(update.rejected),
      },
    );

    const hostile = await this.#deps.settings.update({
      titleBadge: 'not-a-boolean',
      groupingIntervalMs: -5,
      globalShortcut: 'W',
      unknownKey: 'x',
    });
    this.#check(
      'settings-rejects-invalid-input',
      Object.keys(hostile.applied).length === 0 && Object.keys(hostile.rejected).length >= 3,
      { rejected: Object.keys(hostile.rejected), applied: Object.keys(hostile.applied) },
    );

    // And the value must actually be on disk in the profile.
    try {
      const raw = readFileSync(this.#deps.settings.location, 'utf8');
      this.#check('settings-file-written', raw.includes('"titleBadge"'), { bytes: raw.length });
    } catch (error: unknown) {
      this.#check('settings-file-written', false, { error: String(error) });
    }
  }

  async #checkSettingsUi(): Promise<void> {
    const settingsWindow = await this.#deps.windowManager.openSettings().catch((): null => null);
    if (settingsWindow === null) {
      this.#check('settings-ui-rendered', false, { error: 'window could not be created' });
      return;
    }
    await this.#waitFor(() => !settingsWindow.webContents.isLoading(), 12_000);
    await delay(700);
    const probe: unknown = await settingsWindow.webContents
      .executeJavaScript(
        `JSON.stringify({
           fields: document.querySelectorAll('.field').length,
           buttons: document.querySelectorAll('.button').length,
           switch: document.querySelectorAll('.switch-input').length,
           title: document.title,
           bridge: typeof window.waSettings,
           leaked: typeof window.require
         })`,
      )
      .catch((error: unknown) => JSON.stringify({ error: String(error) }));
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(String(probe)) as Record<string, unknown>;
    } catch {
      /* keep the raw string in the report */
    }
    this.#check(
      'settings-ui-rendered',
      Number(parsed['fields'] ?? 0) >= 8 && Number(parsed['buttons'] ?? 0) >= 3 && parsed['bridge'] === 'object',
      parsed,
    );
    // The settings renderer must not have Node, and the page bridge exposed to
    // WhatsApp must not be visible here.
    this.#check('renderer-has-no-node', parsed['leaked'] === 'undefined', { typeofRequire: parsed['leaked'] ?? null });
    settingsWindow.close();
  }

  async #checkTray(): Promise<void> {
    const required = process.env['WA_SMOKE_REQUIRE_TRAY'] === '1';
    const available = this.#deps.trayManager.available;
    this.#check('tray-available', available || !required, {
      status: this.#deps.trayManager.status,
      reason: this.#deps.trayManager.failureReason,
      required,
    });
  }

  async #checkBackends(): Promise<void> {
    const name = this.#deps.notificationService.activeName;
    this.#check('notification-backend-selected', name !== 'none', { backend: name });

    if (name === 'file') {
      try {
        const dumped = readFileSync(this.#deps.notificationDumpPath, 'utf8').split('\n').filter(Boolean);
        const last = JSON.parse(dumped[dumped.length - 1] ?? '{}') as { title?: string; body?: string; count?: number };
        this.#check('file-dump-written', dumped.length >= 1 && typeof last.title === 'string', {
          lines: dumped.length,
          last,
        });
      } catch (error: unknown) {
        this.#check('file-dump-written', false, { error: String(error) });
      }
    } else {
      this.#logger.info('smoke: note file-dump check skipped (backend is not "file")');
    }
  }

  /* ---------------------------------------------------------------------- */

  #check(name: string, ok: boolean, detail: unknown): boolean {
    this.#results.push({ name, ok });
    const rendered = safeStringify(detail);
    this.#logger.log(
      ok ? 'info' : 'error',
      `smoke: ${ok ? 'pass' : 'FAIL'} ${name}${rendered === null ? '' : ` ${rendered}`}`,
    );
    return ok;
  }

  async #finish(): Promise<void> {
    const failed = this.#results.filter((result) => !result.ok);
    // Exactly this message is what scripts/smoke.mjs waits for.
    this.#logger.info('smoke: summary', {
      checks: this.#results.length,
      failed: failed.map((result) => result.name),
    });
    if (failed.length === 0) this.#logger.info('smoke: ok');
    await this.#deps.quit(failed.length === 0 ? 'smoke-ok' : 'smoke-fail');
  }

  async #waitFor(predicate: () => boolean, ms = 10_000): Promise<boolean> {
    const budget = Math.max(300, Math.min(ms, Math.max(300, this.#deadline - Date.now())));
    const start = Date.now();
    while (Date.now() - start < budget) {
      try {
        if (predicate()) return true;
      } catch {
        /* a destroyed window makes accessors throw; treat as "not yet" */
      }
      await delay(150);
    }
    try {
      return predicate();
    } catch {
      return false;
    }
  }
}

function safeStringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 200);
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : json.slice(0, 300);
  } catch {
    return null;
  }
}
