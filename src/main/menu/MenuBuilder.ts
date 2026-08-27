/**
 * Menu construction for both menus in the application: the tray context menu and
 * the (optional) window menu bar.
 *
 * Accelerators are deliberately absent from the *tray* menu. A tray context menu
 * is not attached to a window, so it has no `GtkAccelGroup`; registering one is a
 * no-op for the user and makes GTK print
 * `gtk_widget_add_accelerator: assertion 'GTK_IS_ACCEL_GROUP (accel_group)' failed`
 * once per entry on every build (which is exactly the noise these used to cause).
 * The window menu bar below does use accelerators, because it is attached.
 *
 * Both are *rebuilt* whenever state changes. Electron's menu items are mutable,
 * but rebuilding is simpler to reason about and, on Linux, the tray menu is a
 * fresh D-Bus exported object graph anyway. Rebuilds are debounced by the
 * caller (menus are rebuilt on show / on state change, not per keystroke).
 */

import { Menu, type MenuItemConstructorOptions } from 'electron';

import { WINDOW_TITLE_BASE } from '../../shared/constants.js';
import type { DNDService } from '../dnd/DNDService.js';
import type { Logger } from '../lib/logger.js';
import type { UnreadManager } from '../unread/UnreadManager.js';

export interface MenuActions {
  show(): void;
  hide(): void;
  toggle(): void;
  /** Restore, raise and focus (used by the tray click and notification clicks). */
  focus(): void;
  openSettings(): void;
  retryLoad(): void;
  reload(): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  toggleDevTools(): void;
  toggleMenu(): void;
  quit(reason: string): void;
}

export interface MenuState {
  readonly unreadCount: number;
  readonly dndActive: boolean;
  readonly dndDescription: string;
  readonly visible: boolean;
  readonly backendName: string;
  readonly trayAvailable: boolean;
  readonly appVersion: string;
}

export interface MenuDeps {
  readonly actions: MenuActions;
  readonly dnd: DNDService;
  readonly unread: UnreadManager;
  readonly logger: Logger;
  readonly state: () => MenuState;
  readonly snooze: (minutes: number) => void;
  readonly clearUnread: () => void;
  readonly copyDiagnostics: () => void;
}

const SNOOZE_PRESETS: readonly number[] = [5, 15, 30, 60, 240];

/** The tray context menu: exactly the five required entries, plus context. */
export function buildTrayMenu(deps: MenuDeps): Menu {
  const state = deps.state();
  const template: MenuItemConstructorOptions[] = [
    {
      label:
        state.unreadCount > 0
          ? `${WINDOW_TITLE_BASE} - ${state.unreadCount} unread`
          : `${WINDOW_TITLE_BASE} - up to date`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Show WhatsApp',
      click: () => {
        deps.logger.debug('tray: show');
        deps.actions.show();
      },
    },
    {
      label: 'Hide WhatsApp',
      enabled: state.visible,
      click: () => {
        deps.logger.debug('tray: hide');
        deps.actions.hide();
      },
    },
    {
      label: 'Toggle Visibility',
      click: () => {
        deps.logger.debug('tray: toggle');
        deps.actions.toggle();
      },
    },
    { type: 'separator' },
    {
      label: 'Do Not Disturb',
      submenu: [
        {
          label: 'Enable Do Not Disturb',
          type: 'checkbox',
          checked: state.dndActive,
          click: () => {
            void deps.dnd.toggle().then((next) => {
              deps.logger.info('tray: do not disturb toggled', { active: next.active });
            });
          },
        },
        {
          label: state.dndDescription,
          enabled: false,
        },
        { type: 'separator' },
        ...SNOOZE_PRESETS.map<MenuItemConstructorOptions>((minutes) => ({
          label: `Silence for ${minutes} minute${minutes === 1 ? '' : 's'}`,
          click: () => {
            deps.snooze(minutes);
            deps.logger.info('tray: notifications snoozed', { minutes });
          },
        })),
      ],
    },
    {
      label: 'Clear Unread Counter',
      enabled: state.unreadCount > 0,
      click: () => {
        deps.clearUnread();
        deps.logger.debug('tray: unread cleared');
      },
    },
    { type: 'separator' },
    {
      label: 'Settings…',
      click: () => deps.actions.openSettings(),
    },
    {
      label: 'Reload WhatsApp Web',
      click: () => deps.actions.retryLoad(),
    },
    {
      label: 'Diagnostics',
      submenu: [
        { label: `Notification backend: ${state.backendName}`, enabled: false },
        { label: `System tray: ${state.trayAvailable ? 'available' : 'not available'}`, enabled: false },
        { label: `Version: ${state.appVersion}`, enabled: false },
        { type: 'separator' },
        {
          label: 'Toggle Developer Tools',
          click: () => deps.actions.toggleDevTools(),
        },
      ],
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        deps.logger.info('tray: quit requested');
        deps.actions.quit('tray-menu');
      },
    },
  ];

  return Menu.buildFromTemplate(template);
}

/**
 * Window menu bar (optional; off by default, `showMenu` setting). On Linux this
 * is the only menu most users ever see, so it must carry the same actions as the
 * tray for the case where the tray is unavailable.
 */
export function buildAppMenu(deps: MenuDeps): Menu {
  const state = deps.state();
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: WINDOW_TITLE_BASE,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: 'Settings…', click: () => deps.actions.openSettings() },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => deps.actions.openSettings() },
        { type: 'separator' },
        {
          label: 'Hide to Tray',
          accelerator: 'CommandOrControl+W',
          click: () => deps.actions.hide(),
        },
        {
          label: 'Quit',
          accelerator: isMac ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => deps.actions.quit('menu'),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: state.visible ? 'Hide WhatsApp' : 'Show WhatsApp', click: () => deps.actions.toggle() },
        { label: 'Reload', accelerator: 'CommandOrControl+R', click: () => deps.actions.reload() },
        { label: 'Force Reload', accelerator: 'CommandOrControl+Shift+R', click: () => deps.actions.retryLoad() },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CommandOrControl+Plus', click: () => deps.actions.zoomIn() },
        { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: () => deps.actions.zoomOut() },
        { label: 'Reset Zoom', accelerator: 'CommandOrControl+0', click: () => deps.actions.resetZoom() },
        { type: 'separator' },
        { label: 'Toggle Menu Bar', click: () => deps.actions.toggleMenu() },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'CommandOrControl+Shift+I',
          click: () => deps.actions.toggleDevTools(),
        },
      ],
    },
    {
      label: 'Messages',
      submenu: [
        {
          label: 'Do Not Disturb',
          type: 'checkbox',
          checked: state.dndActive,
          click: () => {
            void deps.dnd.toggle();
          },
        },
        ...SNOOZE_PRESETS.map<MenuItemConstructorOptions>((minutes) => ({
          label: `Snooze ${minutes} min`,
          click: () => deps.snooze(minutes),
        })),
        { type: 'separator' },
        { label: 'Clear Unread Counter', click: () => deps.clearUnread() },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: `About ${WINDOW_TITLE_BASE}…`,
          click: () => deps.actions.openSettings(),
        },
        {
          label: `Notification backend: ${state.backendName}`,
          enabled: false,
        },
        {
          label: 'Copy diagnostic information',
          click: () => deps.copyDiagnostics(),
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
