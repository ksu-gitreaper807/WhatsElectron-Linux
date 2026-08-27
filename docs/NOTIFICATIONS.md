# Notifications

How a wrapper can produce native notifications without touching the protocol, what that guarantees,
and what it does not.

- [Why this is the hard part](#why)
- [Detection](#detection)
- [Grouping](#grouping)
- [Policy: what is suppressed and why](#policy)
- [Click activation and conversation focus](#click)
- [Unread counting](#unread)
- [Backends](#backends)
- [Reliability and failure modes](#reliability)
- [Adding a backend](#adding-a-backend)

---

## Why this is the hard part <a name="why"></a>

A browser tab cannot show a desktop notification _on your behalf_ in a way your desktop attributes to
a desktop application, cannot be grouped by a third party, and cannot be clicked back into your
window. The Electron wrapper can — but it has no supported way to be _told_ that a message arrived:
WhatsApp Web's real data path is an encrypted socket inside the page.

So the design accepts one constraint: **observe what the page already shows**, and be robust when the
page changes. Anything else (private API access, protocol parsing, DOM automation) is out of scope by
the brief and by judgement — see [ARCHITECTURE.md § Decisions](ARCHITECTURE.md#decisions).

## Detection <a name="detection"></a>

`src/main/detection/DetectionScript.ts` holds the injected source. It runs in the **main world** of the
WhatsApp frame (injected by our sandboxed preload through `webFrame.executeJavaScript`), reports via
`window.postMessage`, and does exactly four read-only things:

1. **Unread count** — `document.title` parsed for the `(N)` prefix that WhatsApp itself puts there.
2. **Session state** — URL and the presence of a chat list: `loading | logged-in | logged-out | error`.
   Used only for the window title warning and to decide when to look at all.
3. **Messages** — a `MutationObserver` on `#app`, debounced 150 ms, plus a 4 s safety poll. On each
   scan it looks for the notification/chat-list surface (`[data-testid="notify-container"]`,
   `[aria-label="New notifications"]`, `[aria-label="unread chats"]`, `[role="complementary"]`, tried
   in order) and reads each row: chat name from the row's own `aria-label` (the string assistive
   technology already gets, e.g. `"Alice, 2 messages, 9:41 PM, unread"`) or its `title`/name element,
   and the preview as the last text element of the row. A first scan only _baselines_ the rows already
   on screen, so an app restart never replays old chats.
4. **Page notifications** — if WhatsApp Web constructs a `Notification`, the constructor arguments are
   observed (`window.Notification` is wrapped, the real object is still created unchanged) and become
   a higher-fidelity event. This is a bonus path, not the only one.

What the detector never does: click, focus, scroll, mutate, read storage, call internals
(`window.Store`, `require`, WebSocket, IndexedDB), or send anything into the page. The 201-test suite
includes `test/detector.test.ts`, which evaluates the _shipped string_ against a fake DOM: baseline,
one-report-per-row, media classification, title parsing, clamping, idempotent installation.

`Settings ▸ Status ▸ Notification detector` reports whether the handshake arrived, which is the single
most useful diagnostic when notifications stop.

## Grouping <a name="grouping"></a>

`NotificationManager` owns a queue of _groups_, keyed by chat (`chat:<hash>`), falling back to sender
(`sender:<hash>`) when no chat id is available — the requirement's "group by conversation, and by
sender where appropriate".

```
ingest(message)
  ├─ dedupe: id-based (BoundedSet, 512 entries)
  ├─ group.count += 1, preview = newest, hasMedia |= …
  ├─ UnreadManager.increment()            ← always, even if suppressed later
  └─ groupingEnabled ? schedule(groupingIntervalMs) : flush now
flush(group)
  ├─ pending? (grew since last render, or last attempt was suppressed/failed)
  ├─ anti-flicker: a visible group notification is re-rendered at most once/second
  ├─ policy gate
  ├─ NotificationFormatter.present()
  └─ service.show({ id: 'wa:<groupKey>', title, body, … })   ← the id is what makes replacement work
```

Rendered text (`present()`), with the requirement's example as the test case:

| Situation                                         | Title         | Body                                |
| ------------------------------------------------- | ------------- | ----------------------------------- |
| one message, direct chat, previews on             | `Alice`       | `see you at 8`                      |
| three messages, direct chat                       | `Alice`       | `3 new messages` ⏎ `the newest one` |
| three messages, previews off                      | `Alice`       | `3 new messages`                    |
| one message in a group                            | `Flatmates`   | `Bob: who bought milk`              |
| five messages in a group, previews off            | `Flatmates`   | `5 new messages`                    |
| unread across several chats (single-summary mode) | `2 new chats` | `7 new messages in 2 chats`         |

Because the D-Bus backend passes `replaces_id`, a burst does not stack: the visible notification's
counter changes. On the Electron backend, which cannot, the previous instance is closed and re-shown
(`inPlaceGrouping: false` in its capabilities is exactly this fact, and the manager reads it).

Retention: a group leaves the queue `expireAfterMs` after its last activity, and the rendered
notification is closed at that point. **Retention never changes the unread badge** — an expired popup is
still an unread message.

Spam resistance, in order of bluntness: grouping window → focus quiet period (`focusQuietMs`) →
`8 new groups per 10 s` rate limit (updates to an already-visible group are exempt, so one busy chat
can never starve) → 40-group cap → per-group message cap. `Settings ▸ Status ▸ Queue counters` exposes
`delivered / suppressed / failed` (and the manager's `stats` accessor adds `merged`, `duplicates` and
`rateLimited` for diagnostics) so you can see which one bit.

## Policy <a name="policy"></a>

| Condition                                           | Result                                                                   | Where                        |
| --------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------- |
| `notificationsEnabled: false`                       | tracked, not delivered                                                   | `#suppressionReason`         |
| DND active (user, system, or snooze)                | tracked, not delivered                                                   | `DNDService.isEnabled()`     |
| Our window is focused, or was within `focusQuietMs` | tracked, not delivered — you are looking at the chat list                | `WindowManager.isQuietNow()` |
| Burst of new chats                                  | extra groups suppressed, group still counted                             | rate limiter                 |
| Backend unavailable                                 | falls back; after 3 failures a backend is disabled for `retryIntervalMs` | `NotificationService`        |
| `playSound: false` or DND                           | `silent: true` → `suppress-sound` hint                                   | formatter/backend            |

Disabling DND flushes what is still pending, so "silent while driving, one summary when I unlock"
works without a timer race.

## Click activation and conversation focus <a name="click"></a>

```
D-Bus ActionInvoked(id, 'default'|'open')      Electron Notification 'click'
        └──────────────┬───────────────────────────────┘
                       ▼  backend maps its own id back to our group id
              NotificationService  ──'click'──▶ NotificationManager
                       │
        ├─ onActivate(payload)  ──▶ WindowManager.focus('notification-click')
        │                            (restore → show → moveTop → focus → flashFrame)
        ├─ WindowManager.navigateToChat(chatId, chatName)   ← best effort hook
        └─ drop the group + UnreadManager.markChatRead(chatId)
```

The guarantee is **"opening a notification brings WhatsApp to the foreground"**. The best-effort part
is _which chat_: WhatsApp Web publishes no documented deep link for "open conversation X", so
`navigateToChat` sends an opaque token to our own preload (`wa:navigate`), which — deliberately — has
no code that mutates the page. Should a supported mechanism ever exist, it is a few lines in
`preload/whatsapp.ts`; the main-process side already carries a bounded, validated identity
), and logs what it tried.

Two further honest caveats:

- Some notification servers do not report activations at all (stock GNOME is the usual case). Nothing
  breaks: the group simply ages out by retention, and the badge stays until you focus the window.
- On Wayland a compositor may refuse to let an unfocused client raise itself; `flashFrame` is then the
  visible signal. `Settings ▸ Status` distinguishes "hidden" from "visible" so you can tell what the
  app asked for.

## Unread counting <a name="unread"></a>

Two counters exist and must not be confused:

| Counter                 | Owner                 | Meaning                                       | Cleared by                                                                                                          |
| ----------------------- | --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Queue count (per group) | `NotificationManager` | how many messages are behind one notification | delivery + retention/activation                                                                                     |
| Badge count             | `UnreadManager`       | how many things you have not looked at        | focus (if `clearUnreadOnFocus`), activating a notification, tray ▸ Clear, or the page's own `(N)` title via `set()` |

`UnreadManager` broadcasts a `changed` event; `main.ts` fans it out to the tray, the window title,
`app.setBadgeCount` and the settings window. Nothing queries WhatsApp's real unread state, because
there is no supported way to.

## Backends <a name="backends"></a>

```
INotificationBackend (backends/INotificationBackend.ts)
  initialize() | isAvailable() | capabilities()
  show(AppNotification) -> { ok, backend, nativeId, error }
  close(ourId) | closeAll() | dispose()
  events: click { id, actionId }, dismiss { id, reason }
```

| Backend                       | Wins when                                   | Notable                                                                           |
| ----------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| `LinuxDBusBackend`            | Linux + session bus + `dbus-next` installed | `replaces_id`, hints, `ActionInvoked`                                             |
| `ElectronNotificationBackend` | everything else, incl. macOS/Windows        | `Notification` API; `click` support is the server's choice                        |
| `FileNotificationBackend`     | `--demo-notifications`, CI, debugging       | one JSON line per notification into `notifications.jsonl`, self-disabling at 2 MB |
| `MockNotificationBackend`     | unit tests                                  | records deliveries, `simulateClick()`, `failNext()`                               |

`NotificationService` owns selection: probe all, prefer `settings.notificationBackend`
(`auto | dbus | electron | file | mock`), fall through on failure, disable a broken backend for a
minute, and publish per-backend capabilities to `Settings ▸ Status`.

## Reliability and failure modes <a name="reliability"></a>

| Change in WhatsApp Web                                     | Effect                                    | Design response                                                                                                              |
| ---------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Notification region renamed / `aria-label` wording changed | previews become generic or stop           | selector _lists_ tried in order; degradation is silent and functional; `detector` field in Status tells you which half broke |
| Title no longer carries `(N)`                              | badge stops updating from the page        | notification-driven counting still works (it is the primary source)                                                          |
| No `#app` root any more                                    | detector gives up after ~5 min of waiting | logs `app-root-not-found`, keeps the window working                                                                          |
| Virtualised list settles without a mutation                | a missed event                            | 4 s safety poll + rescan on `visibilitychange`/`focus`                                                                       |
| They add a documented deep link                            | —                                         | the click path already carries a chat identity to the preload                                                                |
| `dbus-next` is missing                                     | the D-Bus backend reports unavailable     | Electron fallback keeps notifications working                                                                                |

Deliberate non-goals: no retry storms against the page, no synthetic events, no reliance on a
specific class name, and nothing that would break if the page re-renders under us.

## Adding a backend <a name="adding-a-backend"></a>

1. `src/main/notifications/backends/XyzNotificationBackend.ts`, extending
   `NotificationBackendBase`: implement `isAvailable()`, `probe()`, `show()`, `close()`, `closeAll()`;
   emit `click`/`dismiss` with **our** `AppNotification.id`.
2. Add it to the `backends` array in `compose()` in `src/main/main.ts` (order = fallback order) and a name
   in `NOTIFICATION_BACKENDS` + the `labelForOption`/alias maps.
3. Add it to `test/notification-service.test.ts` (selection/fallback) and, if it does I/O, keep the
   parsing in a pure function so it can be unit tested like `LinuxDBusBackend`'s signal mapping.

That is the whole change: no manager, window, tray or settings file needs to know it exists.
