/**
 * IPC: the only door between renderers and the main process.
 *
 * Two rules, enforced in the code below:
 *
 *  1. *Sender authentication by registry, not by payload.* Every handler looks
 *     up `event.sender.id` in the `RoleRegistry` that `WindowManager` populates
 *     and compares it with the roles allowed for that channel. A renderer can
 *     never claim to be something it is not, and an unregistered web contents
 *     (a popup that somehow exists) can use nothing at all.
 *  2. *Nothing crosses without validation.* Inbound payloads from the WhatsApp
 *     contents are parsed by `ipc/schemas.ts`; the settings patch is validated
 *     against the settings schema. Everything else is dropped with a log line.
 *
 * `ipcMain.handle` is used only for request/response (settings, status, the
 * detector script). The notification path uses `ipcMain.on`, because awaiting a
 * round trip per message would add latency to the pipeline for no benefit - and
 * because a renderer that cannot await a reply cannot be *asked* to behave.
 */

import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

import { IPC, LIMITS } from '../../shared/constants.js';
import { SETTING_FIELDS } from '../../shared/settings.js';
import type {
  AppStatePayload,
  IpcResult,
  RuntimeStatus,
  SettingsUpdateResult,
  SettingsView,
} from '../../shared/types.js';
import type { DNDService } from '../dnd/DNDService.js';
import { DETECTOR_CHANNEL, DETECTOR_KINDS, detectorSource } from '../detection/DetectionScript.js';
import type { Logger } from '../lib/logger.js';
import type { NotificationManager } from '../notifications/NotificationManager.js';
import type { NotificationService } from '../notifications/NotificationService.js';
import { parseDetectedMessage, parseRendererError, parseSessionReport } from './schemas.js';
import type { RoleRegistry, WindowRole } from '../security/RoleRegistry.js';
import type { SettingsService } from '../settings/SettingsService.js';
import type { ShortcutManager } from '../shortcuts/ShortcutManager.js';
import type { UnreadManager } from '../unread/UnreadManager.js';
import type { WindowManager } from '../window/WindowManager.js';

export interface IpcDeps {
  readonly logger: Logger;
  readonly roles: RoleRegistry;
  readonly settings: SettingsService;
  readonly windowManager: WindowManager;
  readonly notifications: NotificationManager;
  readonly notificationService: NotificationService;
  readonly unread: UnreadManager;
  readonly dnd: DNDService;
  readonly shortcuts: ShortcutManager;
  readonly statusProvider: () => Promise<RuntimeStatus>;
  readonly publishState: () => void;
  readonly requestQuit: (reason: string) => void;
}

export interface DetectorScriptOffer {
  readonly source: string;
  readonly channel: string;
  readonly kinds: typeof DETECTOR_KINDS;
  readonly enabled: boolean;
}

const ALL_ROLES: readonly WindowRole[] = ['whatsapp', 'settings'];

/** Register every handler. The return value tears all of them down again. */
export function registerIpcHandlers(deps: IpcDeps): () => void {
  const { logger } = deps;
  const pushListeners: [string, (event: IpcMainEvent, ...args: unknown[]) => void][] = [];
  const invokedChannels: string[] = [];

  const on = (
    channel: string,
    allowed: readonly WindowRole[],
    listener: (event: IpcMainEvent, payload: unknown) => void,
  ): void => {
    const wrapped = (event: IpcMainEvent, ...args: unknown[]): void => {
      if (!assertSender(deps, event.sender.id, allowed, channel)) return;
      try {
        listener(event, args[0]);
      } catch (error: unknown) {
        logger.error(`ipc listener for ${channel} threw`, error);
      }
    };
    ipcMain.on(channel, wrapped);
    pushListeners.push([channel, wrapped]);
  };

  const handle = <T>(
    channel: string,
    allowed: readonly WindowRole[],
    listener: (event: IpcMainInvokeEvent, args: readonly unknown[]) => Promise<T> | T,
  ): void => {
    const wrapped = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<IpcResult<T>> => {
      if (!assertSender(deps, event.sender.id, allowed, channel)) {
        return { ok: false, error: 'this window may not use this channel' };
      }
      try {
        return { ok: true, value: await listener(event, args) };
      } catch (error: unknown) {
        logger.error(`ipc handler ${channel} failed`, error);
        return { ok: false, error: error instanceof Error ? error.message : 'internal error' };
      }
    };
    ipcMain.handle(channel, wrapped);
    invokedChannels.push(channel);
  };

  /* ------------------------------------------------------------------ */
  /* WhatsApp Web contents -> main (push, one way)                       */
  /* ------------------------------------------------------------------ */

  on(IPC.whatsapp.detected, ['whatsapp'], (_event, payload) => {
    const parsed = parseDetectedMessage(payload);
    if (!parsed.ok) {
      logger.debug('dropped detection payload', { reason: parsed.reason });
      return;
    }
    const result = deps.notifications.ingest(parsed.value);
    if (!result.accepted) {
      logger.debug('message ignored by the notification manager', {
        reason: result.reason,
        chat: truncateForLog(parsed.value.chatName),
      });
      return;
    }
    logger.info('message detected', {
      chat: truncateForLog(parsed.value.chatName),
      groups: deps.notifications.groups,
      unread: deps.unread.getCount(),
    });
  });

  on(IPC.whatsapp.session, ['whatsapp'], (_event, payload) => {
    const parsed = parseSessionReport(payload);
    if (!parsed.ok) {
      logger.debug('dropped session report', { reason: parsed.reason });
      return;
    }
    deps.windowManager.setSessionState(
      parsed.value.state,
      parsed.value.titleUnreadCount,
      parsed.value.detectorInstalled,
    );
    logger.debug('session state reported', { state: parsed.value.state });
    deps.publishState();
  });

  on(IPC.whatsapp.rendererError, ALL_ROLES, (_event, payload) => {
    const parsed = parseRendererError(payload);
    if (!parsed.ok) return;
    logger.error('renderer reported an error', undefined, {
      message: parsed.value.message,
      stack: parsed.value.stack,
    });
  });

  /**
   * The preload asks for the detector source on `dom-ready`. Handing it out on
   * demand keeps the preload tiny, keeps the *page world* free of our bundle,
   * and lets the whole settings window work while the detector is absent.
   */
  handle<DetectorScriptOffer>('wa:get-detector', ['whatsapp'], () => ({
    source: detectorSource(),
    channel: DETECTOR_CHANNEL,
    kinds: DETECTOR_KINDS,
    enabled: deps.settings.get('notificationsEnabled'),
  }));

  /* ------------------------------------------------------------------ */
  /* Settings window <-> main (request/response)                         */
  /* ------------------------------------------------------------------ */

  handle<SettingsView>(IPC.settings.getAll, ['settings'], async () => ({
    settings: deps.settings.settings,
    status: await deps.statusProvider(),
    schema: SETTING_FIELDS,
  }));

  handle<RuntimeStatus>(IPC.settings.status, ALL_ROLES, async () => await deps.statusProvider());

  handle<SettingsUpdateResult>(IPC.settings.update, ['settings'], (_event, args) => {
    const patch = readPatch(args);
    const result = deps.settings.update(patch);
    // `update()` is async; the wrapper awaits it for us.
    return (async (): Promise<SettingsUpdateResult> => {
      const settled = await result;
      if (Object.keys(settled.rejected).length > 0) {
        logger.warn('settings patch partially rejected', { rejected: settled.rejected });
      }
      deps.publishState();
      return settled;
    })();
  });

  handle<SettingsUpdateResult>(IPC.settings.reset, ['settings'], async () => {
    const result = await deps.settings.reset();
    deps.publishState();
    return result;
  });

  handle<{ readonly sent: boolean }>(IPC.settings.previewNotification, ['settings'], () => {
    deps.notifications.previewNotification();
    return { sent: true };
  });

  handle<{ readonly count: number }>(IPC.settings.clearUnread, ['settings'], () => {
    deps.unread.clear('manual');
    deps.notifications.clearAll('manual');
    deps.publishState();
    return { count: deps.unread.getCount() };
  });

  handle<{ readonly visible: boolean }>(IPC.settings.showWhatsApp, ['settings'], () => {
    deps.windowManager.focus('settings-action');
    return { visible: deps.windowManager.isVisible };
  });

  handle<{ readonly ok: boolean }>('app:open-settings', ALL_ROLES, async () => {
    await deps.windowManager.openSettings();
    return { ok: true };
  });

  handle<{ readonly ok: boolean }>(IPC.settings.quit, ['settings'], () => {
    deps.requestQuit('settings-window');
    return { ok: true };
  });

  handle<{ readonly ok: boolean; readonly error: string | null }>('shortcuts:probe', ['settings'], (_event, args) =>
    deps.shortcuts.probe(readAccelerator(args)),
  );

  logger.debug('ipc handlers registered', {
    push: pushListeners.length,
    invoke: invokedChannels.length,
  });

  return () => {
    for (const [channel, listener] of pushListeners) {
      try {
        ipcMain.removeListener(channel, listener);
      } catch (error: unknown) {
        logger.debug('ipc teardown failed', { channel, error: String(error) });
      }
    }
    for (const channel of invokedChannels) {
      try {
        ipcMain.removeHandler(channel);
      } catch (error: unknown) {
        logger.debug('ipc handler teardown failed', { channel, error: String(error) });
      }
    }
  };
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function assertSender(deps: IpcDeps, senderId: number, allowed: readonly WindowRole[], channel: string): boolean {
  const role = deps.roles.ofId(senderId);
  if (role !== null && allowed.includes(role)) return true;
  deps.logger.warn('rejected an ipc message from an unexpected sender', {
    channel,
    role: role ?? 'unregistered',
    allowed,
  });
  return false;
}

/**
 * Only the first argument is ever read, it must be a plain object, and its size
 * is bounded. A hostile or buggy renderer cannot make us parse 10 MB of JSON.
 */
function readPatch(args: readonly unknown[]): Record<string, unknown> {
  const candidate = args[0];
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return {};
  const record = candidate as Record<string, unknown>;
  if (Object.keys(record).length > SETTING_FIELDS.length * 2) return {};
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.length > LIMITS.stringMaxLen) continue;
    if (typeof value === 'string' && value.length > LIMITS.stringMaxLen) continue;
    if (typeof value === 'object' && value !== null) continue;
    bounded[key] = value;
  }
  return bounded;
}

function readAccelerator(args: readonly unknown[]): string {
  const candidate = args[0];
  if (typeof candidate !== 'string') return '';
  return candidate.length > LIMITS.acceleratorMaxLen ? '' : candidate;
}

function truncateForLog(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

/** Broadcast a state snapshot to every window that renders state. */
export function broadcastState(windowManager: WindowManager, payload: AppStatePayload): void {
  const windows: readonly BrowserWindow[] = windowManager.openWindows();
  for (const win of windows) {
    try {
      if (win.isDestroyed()) continue;
      win.webContents.send(IPC.events.stateChanged, payload);
    } catch {
      /* destroyed between the check and the send */
    }
  }
}
