# Security

What this application is exposed to: **one remote website** (`https://web.whatsapp.com`), the local
desktop session (D-Bus, tray, notification daemon), the user's own profile directory, and the
command line. There is no network listener, no custom protocol handler, no remote update feed and no
telemetry.

- [Checklist: requirement → implementation](#checklist)
- [Threat model](#threat-model)
- [IPC contract](#ipc-contract)
- [Trust boundary of the injected detector](#the-injected-detector)
- [Data on disk](#data-on-disk)
- [Reporting](#reporting)

---

## Checklist

Every mandatory item from the brief, and where it lives. `npm run smoke` asserts the ones marked
✔ at runtime, on the real window.

| Requirement                                                                                                   | Implementation                                                                                                                                                                                                                     | Verified                                    |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `nodeIntegration: false`                                                                                      | `security/WindowSecurity.ts` → `buildWebPreferences()` (single factory used by both windows)                                                                                                                                       | ✔ (`getLastWebPreferences`)                 |
| `contextIsolation: true`                                                                                      | same                                                                                                                                                                                                                               | ✔                                           |
| `sandbox: true`                                                                                               | same                                                                                                                                                                                                                               | ✔                                           |
| `webviewTag: false`, `webSecurity: true`, `experimentalFeatures: false`, `allowRunningInsecureContent: false` | same                                                                                                                                                                                                                               |                                             |
| `will-attach-webview` prevented anyway                                                                        | `applyWindowSecurity()`                                                                                                                                                                                                            |                                             |
| Preload + `contextBridge` only                                                                                | `preload/whatsapp.ts` exposes **data, no functions**; `preload/settings.ts` exposes 9 named invocations + one filtered subscription channel                                                                                        | ✔ (`typeof window.require === 'undefined'`) |
| Restrict navigation                                                                                           | `security/UrlPolicy.ts` (pure) applied in `will-navigate` / `will-frame-navigate`; a second global guard in `AppLifecycle` via `app.on('web-contents-created')` covers any contents not created by us                              |                                             |
| Prevent arbitrary external navigation                                                                         | Only `https://web.whatsapp.com` + WhatsApp asset hosts may load in-app; `http://` is refused (no downgrade), `file:`/`chrome:`/`devtools:`/`view-source:`/`data:`/`javascript:` refused; anything else is denied                   | unit tested (26 cases)                      |
| Prevent untrusted new windows                                                                                 | `setWindowOpenHandler` → always `{ action: 'deny' }`; safe links are handed to the default browser instead                                                                                                                         |                                             |
| Validate IPC messages                                                                                         | `ipc/schemas.ts`: type checks, clamps (`LIMITS`), strips control/zero-width characters, recomputes ids, rejects oversized strings; the settings path validates against the schema                                                  | unit tested                                 |
| Authenticate the sender, not the payload                                                                      | `security/RoleRegistry.ts` keyed by `webContents.id`; `assertSender()` in `ipc/ipcHandlers.ts` rejects unregistered contents and wrong roles                                                                                       |                                             |
| Do not expose Node to WhatsApp                                                                                | sandbox + no preload surface + no `remote` module                                                                                                                                                                                  |                                             |
| Keep sensitive logic in main                                                                                  | DND, unread, settings, tray, shortcuts, autostart, notifications are all main-process only                                                                                                                                         |                                             |
| Permissions denied unless needed                                                                              | `applySessionSecurity`: allowlist (`notifications`, `geolocation`, `media`, clipboard, fullscreen, `openExternal`, …) **and** WhatsApp origin **and** role `whatsapp`; always answered (never left pending)                        |                                             |
| `shell.openExternal` guarded                                                                                  | `decideShellOpen`: `https`/`http`/`mailto`/`tel` only, loopback/link-local/`.local` refused                                                                                                                                        |                                             |
| No secret in logs                                                                                             | `lib/logger.ts` redacts keys matching `cookie                                                                                                                                                                                      | authorization                               | token | secret | password | api[_-]?key | phone | jid | …`and masks`NNNN@s.whatsapp.net`/`@c.us` inside string values |     |
| Do not destroy the session                                                                                    | No `clearStorageData`, no `flushCache`, no `clearCache` anywhere — including teardown, where the reason is stated in a comment                                                                                                     |                                             |
| DevTools gated                                                                                                | `devTools: !app.isPackaged`, plus `closeDevTools()` on `devtools-opened` when packaged                                                                                                                                             |                                             |
| Settings window CSP                                                                                           | `src/renderer/settings/index.html`: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`                                | ✔ (the window renders, so the policy holds) |
| Corrupt/hand-edited config cannot crash startup                                                               | `FileSettingsStore` quarantines and falls back; `validateSettings` drops bad keys                                                                                                                                                  | ✔                                           |
| Crash containment                                                                                             | `attachProcessErrorBoundaries` (`uncaughtException`, `unhandledRejection`), `render-process-gone`, `child-process-gone`, per-backend try/catch, per-listener isolation in `TypedEmitter`, one-off dialogs instead of restart loops | ✔ (`--debug-crash`)                         |

## Threat model

**"The page is hostile or compromised."** Consequences are limited by design: it can render its own
content, and it can send us _text_ through one channel (`wa:detected`) that is clamped, validated,
rate limited twice, and used only to draw a notification. It cannot: obtain a main-process function,
open a window, navigate our window away, read settings, read the filesystem, or make us run a
subprocess. `contextIsolation` means it also cannot see our preload's variables at all.

**"Someone edits `settings.json`."** Every key is validated on load and on write; out-of-range
integers, wrong types, and unknown keys are dropped with a log line. `globalShortcut` must match the
accelerator grammar _before_ it is handed to `globalShortcut.register()`. A non-JSON file is
quarantined, not fatal.

**"Another application on the bus is hostile."** Our D-Bus use is: `Notify`, `CloseNotification`,
`GetCapabilities`, `AddMatch`, plus listening for `ActionInvoked`/`NotificationClosed` (filtered by
sender) and `org.freedesktop.portal.Settings.Read`. Every call has a timeout (default 3 s, 5 s for
`Notify`), a reply-shape check, and no `eval` of anything that comes back. A wedged or malicious
daemon can delay or break a notification, not the application; the service then falls back to the
Electron backend, and after 3 failures a backend is temporarily disabled rather than retried hot.

**"A notification server leaks or mangles text."** Message previews are optional
(`showPreviews: false` renders "New message"), and nothing sensitive is sent beyond what WhatsApp Web
already renders in a bubble.

**Not in scope:** hardening against a user with root on the machine, against a malicious distribution
of Node/Electron (pin and verify your lockfile), and against WhatsApp itself changing its DOM — that
is a functional-reliability risk, documented in [NOTIFICATIONS.md](NOTIFICATIONS.md).

## IPC contract

Channels, roles, direction (single source of truth: `shared/constants.ts` → `IPC`).

| Channel                                                                                                            | Direction                 | Allowed sender                        | Payload                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `wa:detected`                                                                                                      | page → main (`send`)      | `whatsapp`                            | `{id,chatId,chatName,senderName?,isGroup,hasMedia,body,timestamp,source,titleUnreadCount}`    |
| `wa:session`                                                                                                       | page → main (`send`)      | `whatsapp`                            | `{state,url?,at,titleUnreadCount?,detectorInstalled?}`                                        |
| `wa:renderer-error`                                                                                                | either → main (`send`)    | any owned window                      | `{message,stack?}`                                                                            |
| `wa:get-detector`                                                                                                  | preload → main (`invoke`) | `whatsapp`                            | – → `{source,channel,kinds,enabled}`                                                          |
| `settings:get-all`                                                                                                 | settings → main           | `settings`                            | – → `{settings,status,schema}`                                                                |
| `settings:update`                                                                                                  | settings → main           | `settings`                            | `SettingsPatch` → `{applied,rejected,settings,notes}`                                         |
| `settings:reset`, `unread:clear`, `notifications:preview`, `window:show-whatsapp`, `app:quit`, `app:open-settings` | settings → main           | `settings` (`app:open-settings`: any) | –                                                                                             |
| `app:status`                                                                                                       | settings → main           | any owned window                      | – → `RuntimeStatus`                                                                           |
| `shortcuts:probe`                                                                                                  | settings → main           | `settings`                            | `string` → `{ok,error}`                                                                       |
| `settings:changed`, `app:state-changed`                                                                            | main → renderer (`send`)  | –                                     | state snapshots                                                                               |
| `wa:navigate`                                                                                                      | main → WhatsApp contents  | –                                     | `{kind:'open-chat',chatId,chatName,nonce}` — **currently a no-op hook**, see NOTIFICATIONS.md |

Rules: an inbound message from an unregistered `webContents` is dropped and logged. Handlers never
read `args[1..]`. `ipcMain.handle` wraps its result as `{ok:true,value}` / `{ok:false,error}` so an
exception cannot become an unhandled rejection in a renderer. The renderer-facing bridge has no
`send` at all for the settings window — only the nine invocations above.

## The injected detector

The one place where we touch the page's world, so its own section:

- Injected by `preload/whatsapp.ts` with `webFrame.executeJavaScript(source)`, in the **main frame
  only**, after `dom-ready`, re-attempted up to 3 times if the handshake does not arrive. No `eval`
  in the preload, no page CSP relaxation, no persistent script in the bundle.
- It is a **string** (`src/main/detection/DetectionScript.ts`), syntactically ES2019, self contained,
  containing no interpolation. `test/detector.test.ts` evaluates the shipped bytes, so it cannot
  silently rot into something that does not parse.
- It **reads**: accessibility labels, visible text, the document title. It **never writes**: no
  `click()`, no `focus()`, no attribute mutation, no scroll, no storage access, no fetch, no
  injection into other frames. It wraps `window.Notification` only to _observe_ the constructor's
  arguments and then constructs exactly what the page asked for.
- Anything it reports is treated as hostile on arrival: clamped, control-character stripped,
  deduplicated, rate limited, and capped (40 groups, 200 messages/group).
- Worst case if WhatsApp changes markup: notifications stop or become generic. The window, the
  session, the tray, the shortcut and the badge keep working.

## Data on disk

Under `~/.config/whatsapp-desktop/` (`app.getPath('userData')`; verified path, and the same
directory backs `sessionData`, which is why the partition below survives an update). Files we create
ourselves are written `0600`; the profile directory itself is created by Electron with the usual
`umask`.

```
~/.config/whatsapp-desktop/
├── Partitions/whatsapp/     # the login session
├── settings.json
├── window-state.json
├── logs/main.jsonl
├── notifications.jsonl
└── icons/
```

| Path                           | Contents                                                                                                                                                                              | Sensitivity                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Partitions/whatsapp/`         | Cookies, `localStorage`, IndexedDB (WhatsApp's keys), service worker, CacheStorage                                                                                                    | **High** — this _is_ the login. Never uploaded, never cleared by the app, never read by us. |
| `settings.json`                | Preferences only                                                                                                                                                                      | Low                                                                                         |
| `window-state.json`            | Window bounds                                                                                                                                                                         | None                                                                                        |
| `logs/main.jsonl` (+`.1`…`.3`) | Structured log. May contain chat _names_ (truncated to 60 chars) and counters; never message text of messages you have read, never cookies or tokens (redacted by key and by pattern) | Medium — mention it when sharing a bug report                                               |
| `notifications.jsonl`          | Only when the `file` backend is selected (`--demo-notifications`, CI, or Settings ▸ Advanced)                                                                                         | Medium — contains previews                                                                  |
| `icons/`                       | Generated PNGs                                                                                                                                                                        | None                                                                                        |

`~/.config/autostart/com.whatsappdesktop.app.desktop` is the only file written outside the profile,
and only when the user turns start-on-login on. `~/.local/share/WhatsApp Desktop/` may be created by
the `.desktop` entry via electron-builder.

## Reporting

Prefer an issue with the output of Settings ▸ Status ▸ **Copy diagnostics** (or
`Help ▸ Copy diagnostic information`); it is a text snapshot of `RuntimeStatus` with no message text
and no tokens. For a vulnerability, use a private channel: include `npm run smoke` output, Electron
version, distribution, desktop environment (`echo $XDG_CURRENT_DESKTOP`), and the last 50 lines of
`main.jsonl` — remembering that it can contain chat names.
