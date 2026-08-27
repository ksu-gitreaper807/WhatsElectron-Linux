/**
 * Preload for the *settings* window (our own UI, still sandboxed).
 *
 * Unlike the WhatsApp bridge, this one exposes functions - because a settings
 * screen has to act. The surface is nevertheless narrow: exactly the invocations
 * the main process allows for the `settings` role, plus one subscription for
 * pushed state. No channel strings are constructed from renderer input, so the
 * renderer cannot reach any other channel.
 */

import { contextBridge, ipcRenderer } from 'electron';

import { IPC } from '../shared/constants.js';

/** Channels the settings UI may subscribe to (main -> renderer only). */
const ALLOWED_EVENTS = new Set<string>([IPC.events.settingsChanged, IPC.events.stateChanged]);

type Listener = (payload: unknown) => void;

const api = {
  getAll: () => ipcRenderer.invoke(IPC.settings.getAll),
  status: () => ipcRenderer.invoke(IPC.settings.status),
  update: (patch: unknown) => ipcRenderer.invoke(IPC.settings.update, patch),
  reset: () => ipcRenderer.invoke(IPC.settings.reset),
  previewNotification: () => ipcRenderer.invoke(IPC.settings.previewNotification),
  clearUnread: () => ipcRenderer.invoke(IPC.settings.clearUnread),
  showWhatsApp: () => ipcRenderer.invoke(IPC.settings.showWhatsApp),
  quit: () => ipcRenderer.invoke(IPC.settings.quit),
  probeAccelerator: (accelerator: unknown) => {
    // Validated again in main; this only keeps nonsense out of the wire.
    if (typeof accelerator !== 'string' || accelerator.length === 0 || accelerator.length > 64) {
      return Promise.resolve({ ok: true, value: { ok: false, error: 'invalid accelerator' } });
    }
    return ipcRenderer.invoke('shortcuts:probe', accelerator);
  },

  /**
   * Subscribe to a pushed state change. Returns an unsubscribe function; the
   * listener is wrapped so a throwing UI callback can never break IPC.
   */
  on(channel: string, listener: Listener): () => void {
    if (typeof channel !== 'string' || !ALLOWED_EVENTS.has(channel)) return () => undefined;
    const wrapped = (_event: unknown, payload: unknown): void => {
      try {
        listener(payload);
      } catch (error: unknown) {
        console.error('settings listener failed', error);
      }
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
} as const;

export type SettingsBridgeApi = typeof api;

contextBridge.exposeInMainWorld('waSettings', api);
