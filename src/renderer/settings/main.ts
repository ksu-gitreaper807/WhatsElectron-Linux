/**
 * Settings window UI.
 *
 * Deliberately framework free: this screen is a form over a validated schema,
 * it must load instantly, and a supply-chain-free renderer is easier to trust.
 * The whole file talks to the main process through `window.waSettings` only
 * (see `src/preload/settings.ts`), and never touches the DOM of the WhatsApp
 * window - it has no idea it exists.
 */

import { clear, debounce, el, formatBytes, fromSeconds, toSeconds, type Attrs } from './dom.js';
import { IPC, type NotificationBackendName } from '../../shared/constants.js';
import type {
  AppSettings,
  AppStatePayload,
  IpcResult,
  RuntimeStatus,
  SettingField,
  SettingsUpdateResult,
  SettingsView,
} from '../../shared/types.js';

const SECTIONS: readonly { id: SettingField['group']; title: string; hint: string }[] = [
  { id: 'startup', title: 'Startup', hint: 'How the application starts and where it goes.' },
  { id: 'shortcuts', title: 'Global shortcut', hint: 'System wide key combination, independent of focus.' },
  { id: 'notifications', title: 'Notifications', hint: 'Grouping, previews and Do Not Disturb.' },
  { id: 'window', title: 'Window & tray', hint: 'Close behaviour and the unread badge.' },
  {
    id: 'advanced',
    title: 'Advanced',
    hint: 'Backends and diagnostics. Only touch these if something is not working.',
  },
];

interface Pending {
  errors: Record<string, string>;
  notes: string[];
}

const state: {
  settings: AppSettings | null;
  status: RuntimeStatus | null;
  schema: readonly SettingField[];
  pending: Pending;
} = {
  settings: null,
  status: null,
  schema: [],
  pending: { errors: {}, notes: [] },
};

const bridge = window.waSettings ?? null;

type BridgeName =
  | 'getAll'
  | 'status'
  | 'update'
  | 'reset'
  | 'previewNotification'
  | 'clearUnread'
  | 'showWhatsApp'
  | 'quit'
  | 'probeAccelerator';

/**
 * Every call goes through here: it is the one place that knows the bridge may be
 * missing (window opened outside the app, or a preload load failure) and the one
 * place that converts a rejection into a renderable error.
 */
async function call<T>(name: BridgeName, ...args: unknown[]): Promise<IpcResult<T> | null> {
  if (bridge === null) return null;
  const table = bridge as unknown as Record<BridgeName, ((...inner: unknown[]) => Promise<IpcResult<T>>) | undefined>;
  const fn = table[name];
  if (typeof fn !== 'function') return null;
  try {
    return await fn(...args);
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) return;
  clear(root);

  const view = await call<SettingsView>('getAll');
  if (view === null || !view.ok) {
    root.append(
      el('div', { class: 'error-box' }, [
        el('strong', { text: 'Settings could not be loaded' }),
        el('p', { text: view?.error ?? 'the settings bridge is unavailable' }),
      ]),
    );
    return;
  }
  state.settings = view.value.settings;
  state.status = view.value.status;
  state.schema = view.value.schema;

  render(root);
  subscribe();
}

function render(root: HTMLDivElement): void {
  clear(root);
  root.append(renderHeader());
  const body = el('div', { class: 'body' });
  for (const section of SECTIONS) {
    const fields = state.schema.filter((field) => field.group === section.id && !field.platformOnly);
    if (fields.length === 0) continue;
    body.append(renderSection(section, fields));
  }
  body.append(renderStatusSection());
  body.append(renderAboutSection());
  root.append(body);
  root.append(renderFooter());
}

/* -------------------------------------------------------------------------- */
/* header / footer                                                            */
/* -------------------------------------------------------------------------- */

function renderHeader(): HTMLElement {
  const status = state.status;
  const unread = status?.unreadCount ?? 0;
  const header = el('header', { class: 'header' }, [
    el('div', { class: 'title' }, [
      el('h1', { text: 'WhatsApp Desktop' }),
      el('p', {
        text:
          status === null
            ? 'settings'
            : `${status.desktopEnvironment} · ${status.sessionType} · Electron ${status.electronVersion}`,
      }),
    ]),
    el('div', { class: 'badges' }, [
      badge(`Unread: ${unread}`, unread > 0 ? 'accent' : 'muted'),
      badge(status?.dndActive ? 'Do Not Disturb on' : 'Do Not Disturb off', status?.dndActive ? 'warn' : 'muted'),
      badge(`Backend: ${status?.notificationBackend ?? 'unknown'}`, 'muted'),
    ]),
  ]);
  return header;
}

function badge(text: string, tone: string): HTMLElement {
  return el('span', { class: `badge badge-${tone}`, text });
}

function renderFooter(): HTMLElement {
  const buttons = el('div', { class: 'row' });
  buttons.append(
    button('Show WhatsApp', async () => {
      await call('showWhatsApp');
    }),
    button('Send test notification', async () => {
      const result = await call('previewNotification');
      flash(result?.ok === true ? 'Test notification queued.' : `Could not queue: ${result?.error ?? 'unknown'}`);
    }),
    button(`Clear unread${state.status ? ` (${state.status.unreadCount})` : ''}`, async () => {
      await call('clearUnread');
    }),
    button(
      'Quit WhatsApp Desktop',
      async () => {
        await call('quit');
      },
      'danger',
    ),
  );
  const notes = el('div', { class: 'notes' });
  for (const note of state.pending.notes) notes.append(el('p', { class: 'note' }, [note]));
  return el('footer', { class: 'footer' }, [buttons, notes]);
}

/* -------------------------------------------------------------------------- */
/* sections and controls                                                      */
/* -------------------------------------------------------------------------- */

function renderSection(section: (typeof SECTIONS)[number], fields: readonly SettingField[]): HTMLElement {
  const list = el('div', { class: 'fields' });
  for (const field of fields) list.append(renderField(field));
  return el('section', { class: 'section' }, [
    el('h2', { text: section.title }),
    el('p', { class: 'hint', text: section.hint }),
    list,
  ]);
}

function renderField(field: SettingField): HTMLElement {
  const value = state.settings === null ? field.default : state.settings[field.key];
  const id = `field-${field.key}`;
  const error = state.pending.errors[field.key];

  const control =
    field.type === 'boolean'
      ? toggleControl(field, value as boolean, id)
      : field.type === 'enum'
        ? enumControl(field, String(value), id)
        : field.type === 'integer'
          ? integerControl(field, Number(value), id)
          : field.type === 'accelerator'
            ? acceleratorControl(field, String(value), id)
            : textControl(field, String(value), id);

  const label = el('label', { class: 'label', for: id }, [field.label]);
  const description = el('p', { class: 'description' }, [field.description]);
  const meta: string[] = [];
  if (field.requiresRestart === true) meta.push('applies after restart');
  if (error) meta.push(error);
  const errorNode =
    meta.length > 0 ? el('p', { class: meta.some((m) => m === error) ? 'error' : 'meta' }, [meta.join(' · ')]) : null;

  return el('div', { class: `field field-${field.type}${field.type === 'boolean' ? ' field-inline' : ''}` }, [
    el('div', { class: 'field-text' }, [label, description, ...(errorNode ? [errorNode] : [])]),
    el('div', { class: 'field-control' }, [control]),
  ]);
}

function commit(key: keyof AppSettings, value: unknown): void {
  void (async () => {
    const result = await call<SettingsUpdateResult>('update', { [key]: value });
    if (result === null) return;
    if (!result.ok) {
      state.pending.errors = { [key]: result.error };
      rebuild();
      return;
    }
    state.settings = result.value.settings;
    state.pending.errors = result.value.rejected;
    state.pending.notes = [...result.value.notes];
    rebuild();
  })();
}

const debouncedCommit = new Map<keyof AppSettings, ReturnType<typeof debounce>>();

function commitDebounced(key: keyof AppSettings, value: unknown, ms = 250): void {
  let fn = debouncedCommit.get(key);
  if (!fn) {
    fn = debounce(
      ((patch: readonly unknown[]) => {
        commit(key, patch[0]);
      }) as (...args: readonly unknown[]) => void,
      ms,
    );
    debouncedCommit.set(key, fn);
  }
  fn(value);
}

function toggleControl(field: SettingField, value: boolean, id: string): HTMLElement {
  // A real checkbox, styled. The native input keeps keyboard, screen reader and
  // "space toggles" behaviour for free, which a fake switch always gets wrong.
  const input = el('input', { id, type: 'checkbox', class: 'switch-input' });
  input.checked = value;
  input.setAttribute('aria-label', field.label);
  input.addEventListener('change', () => commit(field.key, input.checked));
  return el('label', { class: 'switch-wrap' }, [
    input,
    el('span', { class: 'switch', 'aria-hidden': 'true' }, [el('span', { class: 'knob' })]),
  ]);
}

function enumControl(field: SettingField, value: string, id: string): HTMLElement {
  const select = el('select', { id, class: 'select' });
  for (const option of field.options ?? []) {
    const item = el('option', { value: option, text: labelForOption(field.key, option) });
    if (option === value) item.selected = true;
    select.append(item);
  }
  select.addEventListener('change', () => commit(field.key, select.value as NotificationBackendName));
  return select;
}

/** Nice names for the enums whose raw values are implementation-flavoured. */
function labelForOption(key: keyof AppSettings, option: string): string {
  if (key === 'userAgentMode') {
    switch (option) {
      case 'chrome':
        return 'Chrome-styled (recommended)';
      case 'default':
        return 'Electron default (identifies as Electron)';
      case 'custom':
        return 'Custom string';
      default:
        return option;
    }
  }
  if (key === 'notificationBackend') {
    switch (option) {
      case 'auto':
        return 'Auto (D-Bus first, then Electron)';
      case 'dbus':
        return 'Linux notification daemon over D-Bus';
      case 'electron':
        return 'Electron Notification API';
      case 'file':
        return 'Write to a JSONL file (debug)';
      case 'mock':
        return 'Discard (mock, for testing)';
      default:
        return option;
    }
  }
  return option;
}

function integerControl(field: SettingField, value: number, id: string): HTMLElement {
  const isTime = field.key === 'groupingIntervalMs' || field.key === 'expireAfterMs' || field.key === 'focusQuietMs';
  const box = el('div', { class: 'number-box' });
  const number = el('input', {
    id,
    type: 'number',
    class: 'number',
    min: String(isTime ? Math.round((field.min ?? 0) / 1_000) : (field.min ?? 0)),
    max: String(isTime ? Math.round((field.max ?? 0) / 1_000) : (field.max ?? 0)),
    step: String(isTime ? 1 : (field.step ?? 1)),
    value: String(isTime ? toSeconds(value) : value),
  });
  const suffix = el('span', { class: 'suffix', text: isTime ? 's' : '' });
  const range = isTime
    ? el('input', {
        type: 'range',
        class: 'range',
        min: number.min,
        max: number.max,
        step: number.step,
        value: number.value,
      })
    : null;

  const syncFromNumber = (): void => {
    const raw = Number.parseInt(number.value, 10);
    if (Number.isNaN(raw)) return;
    const next = isTime ? fromSeconds(raw) : raw;
    if (range) range.value = String(isTime ? toSeconds(next) : next);
    commitDebounced(field.key, next);
  };
  number.addEventListener('input', syncFromNumber);
  number.addEventListener('change', syncFromNumber);
  if (range) {
    range.addEventListener('input', () => {
      number.value = range.value;
      syncFromNumber();
    });
  }

  box.append(number, suffix);
  if (range) box.append(range);
  return box;
}

function acceleratorControl(field: SettingField, value: string, id: string): HTMLElement {
  const box = el('div', { class: 'accel-box' });
  const input = el('input', {
    id,
    type: 'text',
    class: 'text',
    value,
    spellcheck: 'false',
    placeholder: 'Ctrl+Shift+W',
  });
  const status = el('span', { class: 'inline-status', text: '' });
  input.addEventListener('change', () => commitDebounced(field.key, input.value.trim(), 0));
  input.addEventListener('keydown', (event) => {
    // Capture-style recording is deliberately *not* implemented: the settings
    // window is sandboxed and cannot register a system-wide grab, so "press the
    // combination" UI would lie about what it can verify. Editing the text and
    // pressing "Test" is honest and works.
    if (event.key === 'Enter') commit(field.key, input.value.trim());
  });

  const test = button('Test', async () => {
    status.textContent = 'testing…';
    status.className = 'inline-status';
    const result = await call<{ ok: boolean; error: string | null }>('probeAccelerator', input.value.trim());
    let message = 'unavailable';
    let ok = false;
    if (result !== null) {
      if (result.ok) {
        ok = result.value.ok;
        message = ok ? 'available' : (result.value.error ?? 'unavailable');
      } else {
        message = result.error;
      }
    }
    status.textContent = message;
    status.className = `inline-status ${ok ? 'ok' : 'warn'}`;
  });

  box.append(input, test, status);
  return box;
}

function textControl(field: SettingField, value: string, id: string): HTMLElement {
  const input = el('input', { id, type: 'text', class: 'text', value });
  input.addEventListener('change', () => commit(field.key, input.value));
  return input;
}

/* -------------------------------------------------------------------------- */
/* status + about                                                             */
/* -------------------------------------------------------------------------- */

function renderStatusSection(): HTMLElement {
  const status = state.status;
  const grid = el('dl', { class: 'grid' });
  if (status === null) {
    return el('section', { class: 'section' }, [el('h2', { text: 'Status' }), el('p', { text: 'unavailable' })]);
  }
  const rows: readonly (readonly [string, string])[] = [
    ['Version', `${status.appVersion} (Electron ${status.electronVersion}, Chromium ${status.chromeVersion})`],
    ['Platform', `${status.platform} / ${status.desktopEnvironment} / ${status.sessionType}`],
    ['System tray', status.trayAvailable ? 'available' : 'not available - closing the window will quit'],
    ['Notification backend', status.notificationBackend],
    [
      'Backend capabilities',
      status.notificationBackends
        .map(
          (backend) =>
            `${backend.name}: ${backend.available ? 'ready' : `unavailable (${backend.reason ?? 'unknown'})`}` +
            `${backend.available ? ` [clicks ${backend.clickEvents ? 'yes' : 'no'}, actions ${backend.actions ? 'yes' : 'no'}, grouping ${backend.inPlaceGrouping ? 'in place' : 'replace'}]` : ''}`,
        )
        .join('\n'),
    ],
    ['Session bus', status.dbusConnected ? 'connected' : 'not connected'],
    ['Unread', String(status.unreadCount)],
    ['Do Not Disturb', status.dndActive ? (status.dndReason ?? 'on') : 'off'],
    [
      'Global shortcut',
      status.globalShortcutActive
        ? `active (${status.globalShortcut})`
        : `inactive${status.globalShortcutError ? ` - ${status.globalShortcutError}` : ''}`,
    ],
    ['Start on login', `${status.startOnLoginActive ? 'enabled' : 'disabled'} (${status.autostartLocation})`],
    [
      'Notification detector',
      status.detectorInstalled ? 'installed in the page world' : 'not installed - notifications may be generic',
    ],
    ['WhatsApp session partition', status.sessionPartition],
    ['Profile directory', status.userDataDir],
    ['Settings file', status.settingsPath],
    ['Session size', formatBytes(status.sessionSizeBytes)],
    ['Notification queue', `${status.queue.groups.length} groups, ${status.queue.totalMessages} messages`],
    [
      'Queue counters',
      `delivered ${status.queue.delivered} · suppressed ${status.queue.suppressed} · failed ${status.queue.failed}`,
    ],
    ['Window', status.windowVisible ? 'visible' : 'hidden'],
    ['WhatsApp state', status.sessionState],
  ];
  for (const [key, value] of rows) {
    grid.append(el('dt', { text: key }), el('dd', { class: value.includes('unavailable') ? 'warn' : '', text: value }));
  }
  return el('section', { class: 'section' }, [
    el('h2', { text: 'Status' }),
    el('p', {
      class: 'hint',
      text: 'Everything the wrapper can observe about this desktop session. Useful when reporting a problem.',
    }),
    grid,
  ]);
}

function renderAboutSection(): HTMLElement {
  return el('section', { class: 'section' }, [
    el('h2', { text: 'About this wrapper' }),
    el('p', {
      text: 'This application is a secure Electron shell around https://web.whatsapp.com. It does not speak the WhatsApp protocol, does not automate the page, and stores nothing outside your own profile directory.',
    }),
    el('ul', { class: 'limits' }, [
      el('li', {
        text: 'Notification content is read from the accessibility labels and visible text that WhatsApp Web already renders. If WhatsApp changes its markup, previews may become generic; the message itself is never affected.',
      }),
      el('li', {
        text: 'Clicking a notification always restores and focuses WhatsApp. Opening the exact conversation is only possible when WhatsApp itself supports it, so it is attempted as a best effort and never assumed.',
      }),
      el('li', {
        text: 'The unread counter counts what you were not told about. It is cleared when you focus the window (configurable), not synced with the server.',
      }),
      el('li', {
        text: 'On GNOME the tray needs an AppIndicator extension; without one, close-to-tray is disabled automatically so the window is never lost.',
      }),
    ]),
  ]);
}

/* -------------------------------------------------------------------------- */
/* live updates                                                               */
/* -------------------------------------------------------------------------- */

function subscribe(): void {
  if (bridge === null || typeof bridge.on !== 'function') return;
  bridge.on(IPC.events.settingsChanged, (payload) => {
    const event = payload as { settings?: AppSettings };
    if (event?.settings) {
      state.settings = event.settings;
      rebuild(false);
    }
  });
  bridge.on(IPC.events.stateChanged, (payload) => {
    const event = payload as AppStatePayload;
    if (!event) return;
    if (state.status !== null) {
      state.status = {
        ...state.status,
        unreadCount: event.unread.count,
        dndActive: event.dnd.active,
        dndReason: event.dnd.reason,
        windowVisible: event.visible,
        sessionState: event.sessionState,
      };
    }
    rebuild(false);
  });
}

let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

function rebuild(resetNotes = true): void {
  if (resetNotes && state.pending.notes.length === 0) state.pending.notes = [];
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) return;
  if (rebuildTimer !== null) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    render(root);
  }, 60);
}

function flash(text: string): void {
  state.pending.notes = [text];
  rebuild();
  setTimeout(() => {
    state.pending.notes = state.pending.notes.filter((note) => note !== text);
    const root = document.querySelector<HTMLDivElement>('#app');
    if (root) render(root);
  }, 4_000);
}

function button(
  label: string,
  onClick: () => Promise<void> | void,
  tone: 'danger' | 'default' = 'default',
): HTMLElement {
  const attrs: Attrs = { class: `button button-${tone}`, type: 'button', text: label };
  const node = el('button', attrs);
  node.addEventListener('click', () => {
    void onClick();
  });
  return node;
}

declare global {
  interface Window {
    readonly waSettings?: {
      getAll(): Promise<IpcResult<SettingsView>>;
      status(): Promise<IpcResult<RuntimeStatus>>;
      update(patch: unknown): Promise<IpcResult<SettingsUpdateResult>>;
      reset(): Promise<IpcResult<SettingsUpdateResult>>;
      previewNotification(): Promise<IpcResult<{ sent: boolean }>>;
      clearUnread(): Promise<IpcResult<{ count: number }>>;
      showWhatsApp(): Promise<IpcResult<{ visible: boolean }>>;
      quit(): Promise<IpcResult<{ ok: boolean }>>;
      probeAccelerator(value: string): Promise<IpcResult<{ ok: boolean; error: string | null }>>;
      on?(channel: string, listener: (payload: unknown) => void): () => void;
    };
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot());
else void boot();
