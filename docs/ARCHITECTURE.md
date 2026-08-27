# Architecture

The design goal is not "as many abstractions as possible" but _testability and blast radius_: each
piece can be reasoned about (and unit tested) without a display, and a failure in one Linux
integration cannot take the WhatsApp window down.

- [Shape](#shape)
- [Boot order and why it is that order](#boot-order)
- [Event flows](#event-flows)
- [Dependency rules](#dependency-rules)
- [Component notes](#component-notes)
- [Decisions, and what was rejected](#decisions)

---

## Shape

```
                     ┌────────────────────────────────────────────────┐
                     │ src/shared  (types, constants, settings schema,│
                     │ util)  — imported by every target, imports     │
                     │ nothing outside itself                          │
                     └────────────────────────────────────────────────┘
                                        ▲
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
┌───────┴────────┐            ┌─────────┴────────┐            ┌─────────┴────────┐
│ src/preload    │            │ src/renderer     │            │ src/main         │
│ whatsapp.ts    │            │ settings/        │            │ main.ts (root)   │
│ settings.ts    │            │ (no framework)   │            │ 16 modules below │
│ sandboxed      │            │ sandboxed        │            │                  │
└───────┬────────┘            └─────────┬────────┘            └─────────┬────────┘
        │ postMessage → send/invoke     │ contextBridge: 9 invocations  │
        └───────────────────────────────┴───────────────────────────────┤
                                                                        │
   ┌────────────────────────────────────────────────────────────────────┤
   │                                                                    ▼
   │   ipc/ipcHandlers ──▶ ipc/schemas (validate) ──▶ notifications/NotificationManager
   │                                                        │        │
   │                                                        │        ├─▶ dnd/DNDService
   │                                                        │        └─▶ unread/UnreadManager
   │                                                        ▼                 │
   │                                   notifications/NotificationService      │
   │                                          │  (selects + routes)            │
   │              ┌─────────────────┬──────────┴────────┬──────────────┐       │
   │              ▼                 ▼                   ▼              ▼       │
   │      LinuxDBusBackend  ElectronNotification   FileNotification  Mock   │  │
   │      (Notify/Close +   Backend (Notification  Backend (JSONL)  Backend │  │
   │       ActionInvoked)    API + Linux fallback)  for CI/dev      tests   │  │
   │                                                                        │  │
   │   window/WindowManager ── owns ──▶ BrowserWindow(webContents, session) │  │
   │        ▲  show/hide/toggle/focus/quit, title badge, bounds, retries     │  │
   │        │                                                                 │  │
   │   tray/TrayManager ──── owns ──▶ Tray + Menu      menu/MenuBuilder      │  │
   │   shortcuts/ShortcutManager ─▶ globalShortcut                            │  │
   │   autostart/AutostartService ─▶ XDG .desktop entry                       │  │
   │   dbus/DBusConnection  (one session-bus socket for 3 features)           │  │
   │   security/{UrlPolicy,WindowSecurity,RoleRegistry}                       │  │
   │   settings/{SettingsService,SettingsStore}                               │  │
   │   status/StatusProvider  lib/{logger,typedEmitter,errors,late,fsx}       │  │
   │   lifecycle/{AppLifecycle,SmokeHarness}                                  │  │
   └──────────────────────────────────────────────────────────────────────────┘
```

## Boot order

`src/main/main.ts` is the composition root and contains no behaviour: it constructs implementations
and connects them. The order is deliberate, and `AppLifecycle.onReady` repeats the _startup_ half of
it in comments because it matters:

| #   | Step                                                                         | Why here                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `configureIdentity()` (`app.setName`, `setDesktopName`, `setAppUserModelId`) | Before the first `app.getPath()`: userData is derived from the name, and getting it wrong loses the persistent session — indistinguishable from "the app logs me out".                                  |
| 2   | `requestSingleInstanceLock()`                                                | Before anything writes to the profile. Two processes on one `persist:whatsapp` partition would fight over IndexedDB/LevelDB.                                                                            |
| 3   | Logger                                                                       | Everything after this must be observable.                                                                                                                                                               |
| 4   | `session.fromPartition` + `applySessionSecurity`                             | Electron objects are unavailable before `app.whenReady()` (asserted by the smoke test after a real crash in development). Permission handlers are per-session, so they go on before any contents exist. |
| 5   | `SettingsService` + `load()`                                                 | Every other module reads configuration; nothing may start with defaults if a stored value exists.                                                                                                       |
| 6   | `UnreadManager`, `DNDService`, `DBusConnection`, `AutostartService`          | Pure state or lazy I/O: cheap, cannot fail the app.                                                                                                                                                     |
| 7   | Notification backends + `NotificationService.initialize()`                   | Capability probing (D-Bus round trips) happens here, off the critical path of showing a window.                                                                                                         |
| 8   | `WindowManager` (+ `Late<T>` bindings for lifecycle/tray)                    | The window is what the user asked for; it must not wait on a tray or a notification daemon.                                                                                                             |
| 9   | `NotificationManager.start()`                                                | Needs both the service and the window (for the focus policy), so it comes after both.                                                                                                                   |
| 10  | `TrayManager.initialize()`                                                   | Probes the StatusNotifier host, then creates the icon + menu.                                                                                                                                           |
| 11  | `ShortcutManager.start()/apply()`                                            | A convenience feature; registered last-but-before-ready so a failure cannot block anything.                                                                                                             |
| 12  | `registerIpcHandlers`, `attachApplicationMenu`                               | Registered after every target they can reach exists, so a handler never sees a half-built object graph.                                                                                                 |
| 13  | `lifecycle.install()` then `onReady()`                                       | Installs process boundaries, then runs the ordered startup and the settings side effects.                                                                                                               |

Shutdown is the reverse for anything holding an external resource:
`ShortcutManager.dispose()` (unregister the OS-wide grab) → detach IPC/menu → `NotificationManager`
→ `NotificationService` → D-Bus → `TrayManager` (before windows, so a tray teardown cannot trigger
"no windows left") → windows → `flushLogs()` → `app.exit(0)`. Bounded by a timeout so a wedged
D-Bus daemon cannot make the process unkillable.

## Event flows

Only three cross-module signals exist; everything else is a method call.

**Notifications**

```
WhatsApp Web DOM / page Notification
   │  (detector string, main world, read only)
   ▼ postMessage {channel:'wa-desktop-detector', kind, payload}
preload/whatsapp.ts   (top frame only, rate limited 40 burst / 20 per s, clamped)
   │  ipcRenderer.send('wa:detected', payload)
   ▼
ipc/ipcHandlers.ts    (sender must be the registered 'whatsapp' contents)
   │  parseDetectedMessage() -> DetectedMessage
   ▼
NotificationManager.ingest()
   ├─ dedupe (BoundedSet, keyed on the detector-supplied id)
   ├─ group by chat (fallback: sender)  ── schedule flush(groupingIntervalMs)
   ├─ UnreadManager.increment(chatId)         ──▶ 'changed' ──▶ TrayManager + window title + broadcast
   ├─ policy gate: notificationsEnabled | DND | window-focused quiet period | rate limit
   └─ NotificationFormatter.present() ──▶ AppNotification
                                             │
                              NotificationService.show() (active backend, then fallbacks)
                                             │
                     click/activation signals travel back:
              backend 'click' ─▶ service ─▶ manager: onActivate(payload) + clear group + markChatRead
                                             │
                                        WindowManager.focus() + navigateToChat(opaque id)
```

**State**

```
NotificationManager ──▶ UnreadManager ──'changed'──┬─▶ TrayManager (badge icon redraw, setTitle, tooltip, app.setBadgeCount)
                                                   ├─▶ WindowManager.setTitleState()  → "WhatsApp (5)"
DNDService ─────────────'changed'──────────────────┤
SettingsService ────────'changed'───────────────────┘
                                                   └─▶ main.ts publish() → broadcast 'app:state-changed' to both windows
```

`SettingsService` never imports any of the modules it affects: they register a _side effect_ per key
(`settings.onKey('globalShortcut', …)`) and may return notes, which are surfaced verbatim in the
settings UI. That one indirection removes every cycle between settings and behaviour.

## Dependency rules

Enforced by code structure (and, where it can be, by `no-restricted-imports` in ESLint):

1. `src/shared` imports nothing but `src/shared`. It is compiled into three different targets
   (Node ESM, sandboxed preload, browser IIFE) so a single `import { app } from 'electron'` there
   would break two of them.
2. Only `window/WindowManager` imports `BrowserWindow`. Only `tray/TrayManager` imports `Tray`. Only
   `backends/*` import `Notification`. `Menu` construction is in `menu/`, application-menu _visibility_
   in `menu/ApplicationMenu.ts`.
3. `notifications/*`, `unread/*`, `settings/*`, `dnd/*`, `autostart/AutostartBackends`,
   `security/UrlPolicy`, `detection/*`, `icons/*`, `lib/*`, `ipc/schemas` do **not** import Electron.
   That is what makes 226 unit tests possible without a display, and it is why the notification stack
   can be exercised with fake timers.
4. No module reaches into another module's state: managers expose events and small method surfaces;
   the two genuine cycles (window↔lifecycle, tray↔status) are resolved with `lib/late.ts`, which
   makes "not bound yet" a checked condition rather than a `null` you have to remember about.
5. The page never imports anything. The detector is a string in `detection/DetectionScript.ts`, and
   `test/detector.test.ts` evaluates exactly that string.

## Component notes

**`WindowManager`** — creation (webPreferences + security), show/hide/toggle/focus/restore, the
close-to-tray decision, window title as a badge surface, geometry persistence (bounded, sanitized,
off-screen-safe), a load watchdog with exponential backoff (2^n ms to 8 attempts, `Ctrl+R` resets),
crash recreation, zoom, devtools gating. `canHideToTray()` is a _callback into the tray_, because
"hide" is only correct if something can bring the window back.

**`NotificationManager`** — the queue: per-group state (`count`, `preview`, `firstAt/lastAt`,
`status`, `deliveredCount`, `renderedId`, two timers, `retries`) plus a sliding dedupe window, a
group cap (40) and a per-window rate limit for _new_ groups (8 per 10 s). Anti-flicker spacing
(1 s) applies only when replacing a visible group notification, so "grouping off" really is
immediate. Suppression never means data loss: DND/focus/rate-limit leave the group in the queue,
and turning DND off flushes what is pending.

**`NotificationService`** — probes all backends once, picks the first usable one, honours the user's
preference (with the `dbus` → `linux-dbus` alias mapping so a setting cannot silently do nothing),
falls through on failure, temporarily disables a backend after 3 failures, and re-emits click/dismiss
events with _our_ ids so the manager never learns what a freedesktop notification id is.

**`UnreadManager`** — total plus per-chat counts, `increment/decrement/clear/set/getCount`, and a
single `changed` event. It does not care whether the badge is visible.

**`DNDService`** — `user | system | snooze` OR-ed; `isEnabled/enable/disable/toggle/snooze/refresh`,
the user switch persisted through settings, the system state behind a `DndSource` interface (XDG
portal implementation + `NullDndSource`), snooze timers `unref()`'d so quitting is never delayed.

**`TrayManager`** — availability is a _probe_, not an assumption: it connects to the session bus and
checks for `org.kde.StatusNotifierWatcher` (Electron 44 has no `Tray.isSupported()`; and even when it
existed it answered "is the platform capable", not "will a user see this"). Badge = redrawn icon +
`setTitle` text + tooltip + `app.setBadgeCount`, because no single one of those works everywhere.

**`settings/SettingsStore` vs `SettingsService`** — the store is `{read, write, location}`; the file
implementation adds atomic writes, corruption quarantine and a versioned envelope. The service adds
validation, side effects, events. Swapping in `gsettings` or SQLite is one constructor argument in
`main.ts`.

**`icons/`** — a hand-written PNG encoder (RGBA, filter 0, `zlib.deflateSync`, CRC32) and a
`Raster` with analytic disc coverage. Deterministic output means `build/icons/` can be regenerated
instead of committed, and the runtime can draw a badge for a count that didn't exist at build time.

## Decisions

Chosen, and why:

| Decision                                                                               | Reason                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript `module: NodeNext`, **native ESM** in main, no bundler for the main process | Electron 44 ships Node ≥ 22. One output file per source file keeps stack traces, `--inspect`, and source maps honest. `tsc --noEmit` and `tsc` emit are the same program, so the typecheck and the build cannot disagree.                                                                                 |
| esbuild for preloads + settings UI only                                                | Those targets need different _formats_ (`cjs` for sandboxed preloads, `iife` for the CSP-restricted renderer) and must inline `src/shared` into one file. Bundling the main process would trade real debuggability for nothing.                                                                           |
| `additionalArguments` + a `RoleRegistry` for sender authentication                     | A renderer cannot forge which window it belongs to, because the main process decides from `event.sender.id`.                                                                                                                                                                                              |
| Detector injected with `webFrame.executeJavaScript` from the preload                   | `executeJavaScript` from the _main_ side would need a webContents handle inside a notification class (coupling) and would race the initial load. `webFrame` is a documented renderer API (works with `sandbox: true`), runs at `dom-ready`, survives reloads naturally, and needs no `eval` in a preload. |
| `ipcMain.on` for the notification path, `ipcMain.handle` for everything else           | A detection burst must not await a round trip; request/response is right for settings, status and the detector script.                                                                                                                                                                                    |
| `optionalDependencies: { "dbus-next" }`                                                | The D-Bus backend is a genuine improvement (in-place `replaces_id`, `ActionInvoked`, `desktop-entry` hint) but must never be required. The dynamic `import()` is wrapped; absence becomes `available: false` with a reason in Settings.                                                                   |
| Own structured logger                                                                  | Log format is a product surface (users paste it into bug reports, the smoke test parses it) and must never throw. ~250 lines with redaction, rotation and a JSONL transport, versus a dependency plus a wrapper for the same.                                                                             |
| `Late<T>` instead of `setDependencies()` or an IoC container                           | Two cycles total. A 30-line holder with a checked `get()` documents them; a container would obscure the boot order the table above is the point of.                                                                                                                                                       |

Rejected, with reasons (so the next reader does not try them):

- **Reading `window.Store` / the privacy-public API** for perfect chat names, unread counts, avatars,
  and `openChatWithGroup`. It is undocumented, minified, version-unpinned, breaks on every rollout,
  and is the kind of access WhatsApp's ToS is written against. The wrapper's job ends at the window.
- **DOM automation** (synthetic clicks on chat rows, `focus()` juggling) to implement "open the
  conversation" and "mark as read". Fragile, invisible-to-user side effects inside someone else's app,
  and it is exactly the "interact directly with WhatsApp" the brief forbids.
- **`webRequest` interception / response header rewriting** (e.g. injecting a stricter CSP into
  `web.whatsapp.com` responses). High breakage risk (service workers, media, reporting endpoints)
  for no isolation gain: the boundaries that matter are process- and navigation-level.
  **Not** rejected: the _request_ User-Agent is overridden by default
  (`security/UserAgent.ts`), because WhatsApp Web refuses to start when it sees `Electron/` in it
  ("WhatsApp works with Google Chrome 100+") - verified empirically, and the settings UI exposes
  `userAgentMode: default | chrome | custom` so it is a switch, not a hard-coded lie.
- **A custom `ipcRenderer.sendToFrame` channel for the page** to drive. Any channel the page can use
  to trigger main-process action is a privilege boundary we would have to defend forever.
- **Ad-hoc "keep the socket warm" timers or reloading the page on a schedule** to keep the session
  live: replaced by the supported `backgroundThrottling: false`, which is the documented way and costs only a bit of CPU
  while hidden (documented tradeoff: an always-on notification pipeline needs live timers).
- **`app.setLoginItemSettings` on Linux** — it is `@platform darwin,win32` in Electron 44; the XDG
  autostart entry is the supported mechanism (and is what the DE's own tools manage).
- **`Notification.removeGroup` / `groupId`** for grouping — `@platform darwin,win32`, so it does
  nothing on Linux. Our own manager + `replaces_id` is what actually groups here.
- **Tray badge via `com.canonical.Unity.LauncherEntry`** — a Unity-era extension, effectively dead;
  drawing the badge into the icon is what every current tray implementation renders.
- **Framework in the settings renderer** — a schema-driven form does not need React; zero runtime
  dependencies make its CSP trivially auditable (`script-src 'self'`, verified by the smoke test).
- **Electron's `Tray.isSupported()`** — does not exist in Electron 44; the availability probe replaced it.
