# WhatsApp Desktop (Linux)

An unofficial, security-hardened **Electron wrapper around [WhatsApp Web](https://web.whatsapp.com/)** for Linux
desktops. It adds the parts that a browser tab cannot provide — a system tray icon, native
desktop notifications with per-chat grouping, Do Not Disturb, an unread badge, a global shortcut,
start-on-login, and a persistent login profile.

It does **not** implement, automate, scrape or reverse-engineer the WhatsApp protocol. There is no
private API usage anywhere: the application displays `https://web.whatsapp.com/` in a sandboxed
`BrowserWindow` and integrates that window with the desktop.

```bash
npm install     # downloads Electron 44 (needs Node >= 22.12 - see below)
npm run build   # tsc + esbuild + generated icons
npm start       # run it
```

On a Linux desktop with a running session that is all there is: the window opens on
WhatsApp Web, the tray icon appears, and you scan the QR code once. Your login is then
kept in `~/.config/whatsapp-desktop/Partitions/whatsapp`. If you want to try it without
logging in, `npm run demo` queues two test notifications through the mock backend.

```bash
node -v          # must be >= 22.12, or Electron's installer silently skips the download
npx electron --version
```

No display (CI, container, ssh)? `npm run smoke` starts Xvfb, a private D-Bus session and
`dunst` for you. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#smoke).

---

## Contents

- [What you get](#what-you-get)
- [What this is not (and cannot be)](#what-this-is-not-and-cannot-be)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Building for Linux](#building-for-linux)
- [Testing](#testing)
- [Architecture](#architecture)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Repository layout](#repository-layout)
- [Brand assets](#brand-assets)
- [Documentation](#documentation)

---

## What you get

| Feature                  | Behaviour                                                                                                                                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Persistent login**     | Dedicated `persist:whatsapp` session partition. Cookies, `localStorage`, IndexedDB (where WhatsApp keeps its keys) and the service worker survive restarts, updates and reinstalls. Nothing is ever cleared on start or on exit.                                                                         |
| **System tray**          | Left click toggles the window. Menu: Show, Hide, Toggle visibility, Do Not Disturb (with snooze presets), Clear unread, Settings, Reload, Diagnostics, Quit. The tray is probed for a real StatusNotifier host, so "close hides to tray" is automatically disabled when there is nowhere to hide _into_. |
| **Close to tray**        | Pressing ✕ hides the window and keeps running. `Quit` (tray, menu, or `Ctrl+Q`) tears everything down and exits — including unregistering the global shortcut.                                                                                                                                           |
| **Native notifications** | Sent to `org.freedesktop.Notifications` over D-Bus (`replaces_id`, hints, `desktop-entry`, actions, `ActionInvoked`), with Electron's `Notification` API as a fallback and a JSONL dump backend for debugging.                                                                                           |
| **Grouping**             | Messages are collected per chat and rendered as `Alice` / `3 new messages`, replacing the visible notification in place instead of stacking. The window is configurable (default 5 s).                                                                                                                   |
| **Click to open**        | Activating a notification restores, raises and focuses the window. Conversation deep-linking is attempted as a best effort and never required (see [limitations](#what-this-is-not-and-cannot-be)).                                                                                                      |
| **Do Not Disturb**       | Suppresses delivery only: messages keep being counted and stay in the queue. Optional snooze, and optional mirroring of the desktop's own DND state (XDG portal). Persisted.                                                                                                                             |
| **Unread badge**         | Independent `UnreadManager`: window title (`WhatsApp (5)`), tray title/tooltip, badge drawn into the tray icon, and `app.setBadgeCount()` where the desktop supports it. Cleared on focus (configurable), or from the `(N)` prefix of the page title when WhatsApp itself changes it.                    |
| **Global shortcut**      | `Ctrl+Shift+W` by default, configurable, registered at startup, unregistered on shutdown, with an explicit "already taken by another application" path and a "Test" button in Settings.                                                                                                                  |
| **Start on login**       | XDG autostart entry (`$XDG_CONFIG_HOME/autostart/com.whatsappdesktop.app.desktop`) launched with `--hidden`. Reconciled on every toggle, so a moved AppImage is repaired instead of silently broken.                                                                                                     |
| **Settings window**      | A schema-driven, sandboxed UI over the same validated settings store, plus a live status panel (backend, capabilities, tray availability, D-Bus, queue counters, profile size) and "copy diagnostics".                                                                                                   |

## What this is not (and cannot be)

Honest limits, all of which follow from being a _wrapper_:

- **No protocol access.** No `WhatsApp.*` objects, no `window.Store`, no IndexedDB reads, no
  WebSocket interception, no message sending, no auto-replying, no "mark as read" from the outside.
  If a feature would need any of that, it is not implemented here.
- **Notification content is best effort.** Message text and chat names are read from the elements
  WhatsApp Web already renders for assistive technology (accessibility labels, visible text) plus the
  document title. That is a heuristic: if WhatsApp changes its markup, previews can degrade to
  generic text. Notifications are a convenience, never the source of truth.
- **Opening the exact chat from a notification is not reliably possible.** WhatsApp Web exposes no
  documented deep link for "open conversation X". The click handler therefore guarantees _window
  focus_ and hands an opaque id to our own preload as a hook; nothing in the page is automated.
  See [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md#click-activation-and-conversation-focus).
- **The unread counter is ours, not the server's.** It counts what you were not told about while
  away. It is not synced with the phone or with WhatsApp's own database.
- **The tray depends on the desktop providing a StatusNotifier host.** Stock GNOME without an
  AppIndicator extension and wlroots compositors without a tray plugin have none; the application
  detects that and changes its close behaviour instead of hiding your window where you cannot get
  it back. Details per desktop: [docs/LINUX_INTEGRATION.md](docs/LINUX_INTEGRATION.md).
- **Not affiliated with WhatsApp/Meta.** See [Brand assets](#brand-assets).

## Requirements

- Linux with X11 or Wayland (the smoke test runs under Xvfb; both are supported by Electron).
- Electron 44 (bundled by `npm install`), which implies a recent Chromium/GTK runtime set that your
  distribution already provides for any Electron app.
- Node.js **≥ 22.12** for development (Electron 44's own tooling requires it).
- Optional: `dbus-next` (an `optionalDependency`) — install it to get the D-Bus notification
  backend with in-place grouping and click events. Without it, everything still works through
  Electron's `Notification` API.
- Optional for GNOME users: an AppIndicator/KStatusNotifier extension for the tray.

## Quick start

```bash
git clone <your-fork> whatsapp-desktop
cd whatsapp-desktop
npm install

npm run build     # tsc (main) + esbuild (preloads, settings UI) + generated icons
npm start         # run it
npm run dev       # same, with --dev (console logging, DevTools enabled, useful dialogs)
npm start         # build + run (uses package.json "main" so the app name/version resolve)
npm run demo      # --demo-notifications: queue two test notifications, no real delivery
```

Useful flags (all are read from `process.argv` by `src/main/main.ts`):

| Flag                   | Effect                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `--hidden`             | Start straight into the tray. This is what the autostart entry uses.                            |
| `--no-tray`            | Disable the tray (useful on a desktop with no StatusNotifier host, or for screenshots).         |
| `--dev`                | Development behaviour: pretty console logs, DevTools allowed, dialogs for recoverable problems. |
| `--smoke`              | Run the in-process end-to-end self test and quit (see [Testing](#testing)).                     |
| `--demo-notifications` | Force the `mock` notification backend and queue two test notifications.                         |
| `--log-level=debug`    | Also: `silly`, `info`, `warn`, `error`, `silent`. Env: `WA_DESKTOP_LOG_LEVEL`.                  |
| `--debug-crash`        | Throw from the main process on purpose, to exercise the error boundary.                         |

Logs: `<userData>/logs/main.jsonl` (JSON lines, rotated at 5 MB, 3 generations) plus human-readable
lines on stderr in `--dev`. On a typical install that is `~/.config/whatsapp-desktop/logs/main.jsonl`.

## Configuration

Settings live in `<userData>/settings.json` as a versioned envelope, written atomically (temp file +
rename) and validated against a schema on **every** read and write:

```json
{
  "version": 1,
  "updatedAt": "2026-08-27T12:00:00.000Z",
  "settings": { "groupingEnabled": true, "globalShortcut": "Ctrl+Shift+W" }
}
```

A corrupt file is quarantined as `settings.json.corrupt-<timestamp>` and defaults are used — the
application starts anyway, which matters on a machine where you are mid-edit. Unknown keys are
dropped with a log line, invalid values are never coerced.

The keys (all editable in the Settings window, which is generated from the same schema):

`startOnLogin`, `dndEnabled`, `syncSystemDnd`, `globalShortcutEnabled`, `globalShortcut`,
`notificationsEnabled`, `groupingEnabled`, `groupingIntervalMs`, `expireAfterMs`, `showPreviews`,
`playSound`, `closeToTray`, `minimizeToTray`, `clearUnreadOnFocus`, `focusQuietMs`, `titleBadge`,
`showMenu`, `notificationBackend`.

## Building for Linux

```bash
npm ci
npm run build:prod          # tsc + esbuild (minified, no source maps) + icons
npx electron-builder --linux AppImage deb      # or: npm run dist:linux
```

Artefacts land in `release/`:

| Target            | Notes                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AppImage**      | Zero-install. Put it in `~/.local/bin` or `/opt`, `chmod +x`, run. `Exec` in the autostart entry is set to `$APPIMAGE`, so replacing the file keeps start-on-login working. |
| **.deb**          | `sudo apt install ./whatsapp-desktop_1.0.0_amd64.deb`. Installs `/opt/WhatsApp Desktop/`, the `whatsapp-desktop` launcher, the `.desktop` entry and the hicolor icons.      |
| **.rpm / tar.gz** | Configured in `electron-builder.yml`; add the same runtime dependencies your distribution expects.                                                                          |

Practical notes that matter on Linux specifically:

- **Icon/`.desktop` identity.** Two ids, on purpose: `APP_ID` (`com.whatsappdesktop.app`) is the
  application/lock/autostart-file identity, while `DESKTOP_FILE_NAME` (`whatsapp-desktop`) is the
  **installed `.desktop` file name**, used for the `desktop-entry` notification hint, `Icon=`,
  `StartupWMClass` and `app.setDesktopName()` (which is what associates the LauncherEntry badge and
  the notification icon with the launcher). electron-builder derives that name from
  `linux.executableName`; the three must agree or notifications get a generic icon and the window does
  not group with its launcher. Change them in `src/shared/constants.ts` and `electron-builder.yml`
  together.
- **Tray.** Needs a StatusNotifier host (KDE/XFCE/Cinnamon out of the box; GNOME via an AppIndicator
  extension). `libayatana-appindicator3-1` is listed as a _recommends_ — some distribution builds of
  Electron link it, some do not; install it if the icon does not appear.
- **Wayland.** Works, including D-Bus notifications and the tray (they are session-bus, not X11).
  Global shortcuts are a compositor responsibility on Wayland: Electron grabs them via the
  `org.freedesktop.impl.portal.GlobalShortcuts` portal where available, otherwise a Wayland
  compositor can refuse the grab — Settings then reports "already used". See
  [docs/LINUX_INTEGRATION.md](docs/LINUX_INTEGRATION.md#wayland).
- **Sandbox.** Do not ship `--no-sandbox`. `npm run smoke` passes it because containers may lack user
  namespaces; that is a test concession, and the app logs a warning when it sees the flag.
- **Reproducible icons.** `build/icons/*.png` are generated by `npm run build:icons` from
  `src/main/icons/`, not committed as binary blobs.

## Testing

```bash
npm run typecheck      # three TypeScript programs: main, preloads+renderer, tests
npm run lint           # eslint (typed rules)
npm run format:check   # prettier
npm test               # 226 unit tests, no display required
npm run smoke          # headless END-TO-END test of the real app
npm run dist:dir       # package and check the asar layout
```

- **Unit tests** (`test/`) run the real classes — `NotificationManager`, `SettingsService`,
  `DNDService`, `UnreadManager`, `NotificationService`, the URL policy, the IPC validators, the PNG
  encoder, and the **detector string** (evaluated against a fake DOM). Fake timers make grouping,
  retention and rate limiting deterministic; nothing sleeps.
- **`npm run smoke`** starts the built application under Xvfb with a private D-Bus session, a real
  notification daemon (`dunst`) and a `StatusNotifierWatcher` fixture, and runs
  `--smoke` in-process. It asserts on things only a running app can prove: Electron applied
  `sandbox`/`contextIsolation`, navigation is restricted, the injected detector completed its
  handshake, two messages became one grouped notification, a hidden window gets a real delivery from
  the selected backend, activation clears the group and the badge, DND suppresses delivery without
  losing counts, an invalid settings patch is rejected, the settings window renders from the schema,
  the tray exists, and the renderer has no `require`. It prints `smoke: PASSED`/`FAILED` and exits
  non-zero, so CI can gate on it.
- CI (`.github/workflows/ci.yml`) runs all of the above on Linux/macOS/Windows plus a packaging job.

## Architecture

```
WhatsApp Web page (untrusted remote content, read only)
        │  injected detector: MutationObserver + Notification hook + title parse
        ▼
preload (sandboxed, contextBridge)          postMessage → ipcRenderer.send
        ▼
ipc/schemas.ts            validate + clamp every field
        ▼
NotificationManager       dedupe → group → queue → policy gate → render
        ├── event ──▶ UnreadManager ──▶ TrayManager (icon+title), window title, settings window
        ├── query ──▶ DNDService      (user switch | system state | snooze)
        ▼
NotificationService       backend selection, fallback, capability probing
        ▼
LinuxDBusBackend │ ElectronNotificationBackend │ FileNotificationBackend │ MockNotificationBackend
```

Everything is event-driven and small: `WindowManager` is the only file that touches `BrowserWindow`,
`TrayManager` the only one that touches `Tray`, and no module in `src/shared` or the notification
stack imports Electron. Full details, including what was deliberately _not_ done and why:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/SECURITY.md](docs/SECURITY.md)
- [docs/LINUX_INTEGRATION.md](docs/LINUX_INTEGRATION.md)
- [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)

## Security model

Short version — the full checklist is in [docs/SECURITY.md](docs/SECURITY.md):

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webviewTag: false`,
  `webSecurity: true`, DevTools off when packaged (`src/main/security/WindowSecurity.ts`).
- The only page ever displayed is `https://web.whatsapp.com`. Top-level navigation elsewhere is
  denied or handed to the user's default browser; `setWindowOpenHandler` always returns `deny`; frame
  navigations must be same-origin or WhatsApp-owned (`src/main/security/UrlPolicy.ts`, unit tested).
- The bridge exposed to the page is **read-only data** (`window.waDesktop = { isDesktopApp, ... }`):
  no function the page can call. Notification _content_ flows one way, is validated twice, clamped,
  stripped of control characters, and rate limited.
- IPC senders are authenticated against a `RoleRegistry` keyed by `webContents.id`; a payload can
  never claim a role it does not have.
- Permissions (notifications, camera/mic for calls, clipboard, geolocation, …) are granted per
  allowlist only for the WhatsApp origin in the WhatsApp session; every other request is denied
  immediately rather than left pending.
- Settings input is validated against a schema with an accelerator grammar; a hand-edited or corrupt
  file cannot crash startup.
- Logging redacts anything that looks like a cookie, token, phone number or JID.

## Troubleshooting

| Symptom                                         | Cause and fix                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No tray icon                                    | Your desktop has no StatusNotifier host. On GNOME install an "AppIndicator and KStatusNotifierItem" extension; on wlroots enable a tray plugin. Until then, ✕ quits instead of hiding (that is intentional and is logged). Check `tray:` in Settings ▸ Status. |
| No notifications                                | Check Settings ▸ Status ▸ `Notification backend`. `unavailable (…)` names the reason. If the detector says "not installed", WhatsApp changed its markup — the app keeps working, without popups.                                                               |
| One notification per message instead of a group | Grouping is off or the window had focus: `groupingEnabled`, `focusQuietMs`. "Do not notify while focused" is the default behaviour.                                                                                                                            |
| Clicking a notification does nothing            | Some notification servers do not report activations over the legacy bus. `Settings ▸ Advanced ▸ Notification backend` → force `Linux notification daemon` (needs `dbus-next`) or `Electron Notification API` and compare.                                      |
| `Ctrl+Shift+W` does nothing                     | Another client owns it. Settings ▸ Global shortcut ▸ Test tells you; Status shows the error verbatim.                                                                                                                                                          |
| Asked to log in after every start               | The profile is not persistent: check `Settings ▸ Status ▸ Profile directory` and make sure you did not pass a fresh `--user-data-dir` or run as another user.                                                                                                  |
| Blank window                                    | Offline/DNS failure. The app retries with exponential backoff and says so in the title; `Ctrl+R` (or tray ▸ Reload) forces a retry.                                                                                                                            |
| Everything looks wrong in a bug report          | Settings ▸ Status ▸ `Copy diagnostics` (or the Help menu) puts a full text snapshot on the clipboard.                                                                                                                                                          |

## Repository layout

```
src/
├── main/                     # Electron main process
│   ├── main.ts               # composition root: which objects exist, in what order
│   ├── autostart/            # XDG autostart backend (no Electron) + service/factory
│   ├── dbus/                 # one shared session-bus connection, timeouts, signal router
│   ├── dnd/                  # DNDService (+ sources/XdgPortalDndSource)
│   ├── detection/            # the injected read-only detector, as a string
│   ├── icons/                # PNG encoder + renderer + on-disk icon provider
│   ├── ipc/                  # handlers + input validation (schemas.ts)
│   ├── lib/                  # logger, typed emitter, error boundaries, Late<T>, fs helpers
│   ├── lifecycle/            # AppLifecycle (startup/shutdown order) + SmokeHarness
│   ├── menu/                 # tray + application menu construction
│   ├── notifications/        # NotificationManager, NotificationService, backends/
│   ├── security/             # UrlPolicy (pure), WindowSecurity (adapters), RoleRegistry
│   ├── settings/             # SettingsService + pluggable SettingsStore
│   ├── shortcuts/            # ShortcutManager
│   ├── status/               # RuntimeStatus snapshot + diagnostics text
│   ├── tray/                 # TrayManager (availability probe, badge, menu)
│   ├── unread/               # UnreadManager
│   └── window/               # WindowManager (only place that touches BrowserWindow)
├── preload/
│   ├── whatsapp.ts           # sandboxed, read-only bridge for the WhatsApp contents
│   └── settings.ts           # narrow invoke API for our own settings window
├── renderer/settings/        # settings UI (no framework, no Node)
├── shared/                   # types, constants, settings schema, util — imported by every layer
└── tools/buildIcons.ts       # icon generation, shared with the runtime renderer
test/                         # unit tests + fixtures (fake timers, fake DOM, harness)
scripts/                      # esbuild step, icon step, smoke runner, fake SNI watcher
docs/                         # architecture, security, Linux integration, notifications, dev
```

## Brand assets

This project is **not** affiliated with, endorsed by, or sponsored by WhatsApp or Meta. It contains
no WhatsApp logo, no icons extracted from WhatsApp's properties, and no bundled trademark assets:
`src/main/icons/` draws a generic chat bubble with an optional unread badge, so the build is
reproducible and trademark-free. If you fork and redistribute this with the real logo, you need the
rights to do that; the [WhatsApp Brand Resource Centre](https://about.whatsapp.com/press/) is where
to look. Do not present a build as an official WhatsApp product, and note that WhatsApp's Terms of
Service apply to your use of the service itself.

## Documentation

| Document                                          | Contents                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md)           | Module responsibilities, event flows, dependency rules, design decisions and rejected alternatives.  |
| [SECURITY.md](docs/SECURITY.md)                   | Threat model, hardening checklist mapped to code, IPC contract, reporting.                           |
| [LINUX_INTEGRATION.md](docs/LINUX_INTEGRATION.md) | Per-desktop matrix for tray/notifications/badges/autostart, D-Bus details, Wayland and portal notes. |
| [NOTIFICATIONS.md](docs/NOTIFICATIONS.md)         | How detection works, its reliability limits, grouping semantics, and how to add a backend.           |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md)             | Day-to-day workflow, adding a setting, the smoke harness, release checklist.                         |

## Licence

MIT. See [LICENSE](LICENSE) — including the note that it covers this wrapper only, not any brand
assets.
# WhatsElectron-Linux
