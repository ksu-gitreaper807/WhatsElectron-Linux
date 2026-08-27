/**
 * Menu bar ownership.
 *
 * Whether a menu bar is shown at all is a *desktop environment* question as much
 * as a preference question: GNOME shows nothing, KDE shows a global menu for
 * some styles, and on a tiling window manager the menu is often the only way to
 * reach "Reload". So the menu is always *set* ( accelerators and the app-wide
 * keymap keep working ) and only its visibility is toggled with `autoHideMenuBar`
 * - which is what the `showMenu` setting controls.
 */

import { Menu, app, clipboard } from 'electron';

import { IPC } from '../../shared/constants.js';
import { buildAppMenu, type MenuActions, type MenuState } from './MenuBuilder.js';
export type { MenuActions, MenuState };
import type { DNDService } from '../dnd/DNDService.js';
import type { Logger } from '../lib/logger.js';
import type { SettingsService } from '../settings/SettingsService.js';
import type { StatusProvider } from '../status/StatusProvider.js';
import type { UnreadManager } from '../unread/UnreadManager.js';
import type { WindowManager } from '../window/WindowManager.js';

export interface ApplicationMenuDeps {
  readonly logger: Logger;
  readonly settings: SettingsService;
  readonly windowManager: WindowManager;
  readonly dnd: DNDService;
  readonly unread: UnreadManager;
  readonly status: StatusProvider;
  readonly actions: MenuActions;
  readonly snooze: (minutes: number) => void;
  readonly clearUnread: () => void;
  readonly trayAvailable: () => boolean;
  readonly backendName: () => string;
}

export function attachApplicationMenu(deps: ApplicationMenuDeps): () => void {
  const { logger } = deps;
  let unsubscribe: readonly (() => void)[] = [];

  const state = (): MenuState => ({
    unreadCount: deps.unread.getCount(),
    dndActive: deps.dnd.isEnabled(),
    dndDescription: deps.dnd.describe(),
    visible: deps.windowManager.isVisible,
    backendName: deps.backendName(),
    trayAvailable: deps.trayAvailable(),
    appVersion: app.getVersion(),
  });

  const copyDiagnostics = (): void => {
    void (async () => {
      try {
        const status = await deps.status.get();
        await clipboard.writeText(await deps.status.toText(status));
        logger.info('diagnostic information copied to the clipboard');
      } catch (error: unknown) {
        logger.error('could not copy diagnostics', error);
      }
    })();
  };

  const apply = (): void => {
    const menu = buildAppMenu({
      actions: deps.actions,
      dnd: deps.dnd,
      unread: deps.unread,
      logger,
      state,
      snooze: deps.snooze,
      clearUnread: deps.clearUnread,
      copyDiagnostics,
    });
    Menu.setApplicationMenu(menu);
    const showMenu = deps.settings.get('showMenu');
    const window = deps.windowManager.window;
    if (window) {
      // `autoHideMenuBar` keeps the accelerators alive while hiding the bar, so
      // Ctrl+R / Ctrl+Shift+I still work in the default configuration.
      try {
        window.setAutoHideMenuBar(!showMenu);
        window.setMenuBarVisibility(showMenu);
      } catch (error: unknown) {
        logger.debug('could not apply the menu bar visibility', { error: String(error) });
      }
    }
  };

  apply();

  // Rebuilding a menu costs a D-Bus round trip on Linux, so coalesce bursts
  // (a chat typing indicator can move the unread counter many times a second).
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      apply();
    }, 300);
    timer.unref?.();
  };

  unsubscribe = [
    deps.settings.on('changed', schedule),
    deps.unread.on('changed', schedule),
    deps.dnd.on('changed', schedule),
    deps.windowManager.on('visibility', schedule),
  ];

  return () => {
    if (timer !== null) clearTimeout(timer);
    for (const off of unsubscribe) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    unsubscribe = [];
    try {
      Menu.setApplicationMenu(null);
    } catch {
      /* ignore */
    }
  };
}

/** Channel used by the settings window to ask for a fresh status snapshot. */
export const STATUS_CHANNEL = IPC.settings.status;
