# Development

- [Setup](#setup)
- [Commands](#commands)
- [How the build works](#build)
- [Testing strategy](#testing)
- [The smoke harness](#smoke)
- [Recipes](#recipes)
- [Conventions](#conventions)
- [Release checklist](#release)

---

## Setup <a name="setup"></a>

```bash
node --version    # >= 22.12 (Electron 44's own tooling requires it)
npm ci            # installs electron + dbus-next (optional dep); may need network
npm run build
npm run dev
```

For the smoke test only, a desktop stack is needed. On Debian/Ubuntu:

```bash
sudo apt-get install -y xvfb dbus-x11 dunst xdotool libnotify-bin \
  libgtk-3-0 libnss3 libasound2t64 libgbm1 libxkbcommon0
```

macOS/Windows developers can run everything except `npm run smoke` (which needs Xvfb and
`dbus-run-session`; it skips with exit code 2 and a list of what is missing).

## Commands <a name="commands"></a>

| Command                                   | What it does                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm run build:main`                      | `tsc -p tsconfig.json` → `out/` (main + shared + tools), native ESM, one file per module                       |
| `npm run build:web`                       | esbuild → `out/preload/*.cjs` (sandboxed preloads) and `out/renderer/settings/settings.js` (+ copies html/css) |
| `npm run build:icons`                     | generates `build/icons/*.png` and `build/icon.png` from `src/main/icons/`                                      |
| `npm run build` / `build:prod`            | all three / the same with minification and no source maps                                                      |
| `npm run typecheck`                       | three programs: `tsconfig.json`, `tsconfig.web.json` (DOM lib), `tsconfig.test.json`                           |
| `npm run watch`                           | `tsc --watch` for the main process (preloads are rebuilt by `npm run build:web`)                               |
| `npm test`, `test:watch`, `test:coverage` | vitest; coverage has a 60 % floor for `src/shared` + `src/main`                                                |
| `npm run lint`, `format`, `format:check`  | ESLint with type-aware rules (one `tsconfig.eslint.json` covering src+test), Prettier                          |
| `npm start` / `dev` / `demo`              | run the built app                                                                                              |
| `npm run smoke`                           | headless end-to-end test (below)                                                                               |
| `npm run dist:linux`, `dist:dir`          | package with electron-builder                                                                                  |

## How the build works <a name="build"></a>

Three output formats, one TypeScript program each, because the _runtimes_ differ:

| Target            | Tool    | Format                               | Why                                                                             |
| ----------------- | ------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| main process      | `tsc`   | ESM (`.js`, `"type": "module"`)      | best stack traces, `--inspect`, and `tsc --noEmit` == the real build            |
| preloads          | esbuild | CJS single file, `electron` external | a sandboxed preload must be one file and `require('electron')` must stay        |
| settings renderer | esbuild | IIFE single file, no Node            | CSP `script-src 'self'`, zero runtime dependencies, and it inlines `src/shared` |

`src/shared` is compiled into all three. `incremental` is off on purpose: a stale `.tsbuildinfo`
silently skips files, and a build that does not match its sources is the one failure mode a wrapper
like this must not have. `build:main` also emits `out/tools/buildIcons.js`, which
`scripts/build-icons.mjs` bundles and runs — the runtime icon renderer and the packaging-time icon
generator are the same code, so a generated badge and a packaged icon cannot drift.

## Testing strategy <a name="testing"></a>

226 tests, no display, no sleeps, no Electron. That is a design requirement, not luck: the modules
under test (`NotificationManager`, `SettingsService`, `DNDService`, `UnreadManager`,
`NotificationService`, `UrlPolicy`, IPC validators, PNG encoder, the detector string) import nothing
from Electron, take their timers/clock as dependencies, and read configuration through interfaces.

| File                           | Covers                                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notification-manager.test.ts` | grouping, per-chat and per-sender keys, dedupe, retention, DND and focus suppression, rate limiting, group caps, backend failure + retry, activation clearing, presentation, hostile payloads |
| `notification-service.test.ts` | backend selection, capability reporting, fall-through on throw, temporary disabling, preference aliases, click routing                                                                        |
| `settings-service.test.ts`     | persistence round trip, atomic write, corrupt-file quarantine, invalid persisted values, side-effect isolation, read-only store, reset/toggle                                                 |
| `settings-schema.test.ts`      | schema/default consistency, validation rules, accelerator grammar (34 cases)                                                                                                                  |
| `url-policy.test.ts`           | the navigation boundary: 26 cases incl. suffix tricks, `blob:`/`data:`/`file:`/`chrome:`, http downgrade, loopback refusal                                                                    |
| `ipc-schemas.test.ts`          | clamping, control-character stripping, id derivation, timestamp sanity, tri-state flags                                                                                                       |
| `unread-manager.test.ts`       | clamping, per-chat math, event semantics, sources                                                                                                                                             |
| `dnd-service.test.ts`          | user/system/snooze combination, persistence, clamping, describe()                                                                                                                             |
| `formatter.test.ts`            | the user-visible strings, including markup-injection attempts                                                                                                                                 |
| `detector.test.ts`             | evaluates the _shipped_ detector string against a fake DOM                                                                                                                                    |
| `autostart.test.ts`            | desktop-entry quoting/parsing, stale `Exec` detection, Hidden handling, platform refusal                                                                                                      |
| `icons.test.ts`                | PNG validity (signature, IHDR, CRC32, IEND), antialiasing, badge, determinism                                                                                                                 |

Fixtures worth knowing: `test/helpers/fakeTimers.ts` (a clock you advance),
`test/helpers/harness.ts` (the real object graph, wired with fake timers and the mock backend),
`test/helpers/fakeDom.ts` (just enough DOM to run the detector).

When you change behaviour, add the case to the _harness-based_ test rather than re-implementing the
logic in the test file — that is how the four bugs in the manager (rate-limit ordering, DND-off flush,
missing retry after failure, anti-flicker applying to ungrouped mode) were found.

## The smoke harness <a name="smoke"></a>

`npm run smoke` = `scripts/smoke.mjs` (environment) + `--smoke` (`src/main/lifecycle/SmokeHarness.ts`,
assertions) and it is the part of the suite that proves the _Electron_ half:

- Environment: Xvfb, `dbus-run-session`, `dunst` as a real notification server, and
  `scripts/fake-sni-watcher.mjs` owning `org.kde.StatusNotifierWatcher` so the tray has a host. The
  app runs with its own `--user-data-dir` in a temp profile, `--no-sandbox` (containers may lack user
  namespaces; the app logs a warning about it, which is the right amount of noise for a test).
- 21 checks, each emitted as `smoke: pass <name> {detail}` / `smoke: FAIL <name> {detail}` in the
  app's own JSONL log, then `smoke: summary`. The runner polls that file, prints a table and exits
  non-zero on any failure — so CI gates on real behaviour, not on a green unit suite.
- Useful flags: `--keep` (leave the temp profile), `SMOKE_VERBOSE=1` (stream stderr),
  `SMOKE_TIMEOUT_MS`, `--allow-no-tray` (skip the tray requirement on a machine without a host),
  `DISPLAY=:0 DBUS_SESSION_BUS_ADDRESS=…` to run it against your real session.

Two implementation notes that exist because of this harness: `app.getPath()`/`session` cannot be
touched before `app.whenReady()` (the composition root is ordered accordingly), and the lifecycle
flushes the log writer before `app.exit(0)` — otherwise the last lines, including the summary, are
lost and the runner times out.

## Recipes <a name="recipes"></a>

**Add a setting.** One entry in `SETTING_FIELDS` and a default in `DEFAULT_SETTINGS`
(`src/shared/settings.ts`) — validation, persistence, the settings UI control, and the tray/menu
behaviour all follow from that. Then register a side effect in `main.ts` if something must react:

```ts
settings.onKey("mySetting", async (next) => myService.apply(next.mySetting));
```

**Add a notification backend / change selection order.** See
[NOTIFICATIONS.md § Adding a backend](NOTIFICATIONS.md#adding-a-backend).

**Support a new desktop's DND.** Implement `DndSource` (`read` + `subscribe`) and pass it to
`DNDService`; `syncSystemDnd` in Settings then works with no other change.

**Change the tray badge.** `renderIcon({ size, badge, style })` in `src/main/icons/IconRenderer.ts`.
It is deterministic and covered by `test/icons.test.ts`.

**Test the D-Bus payload by hand.**

```bash
node -e '
const {sessionBus,Message}=require("dbus-next");
const b=sessionBus();
b.on("connect",async()=>{
  const r=await b.call(new Message({destination:"org.freedesktop.Notifications",
    path:"/org/freedesktop/Notifications",interface:"org.freedesktop.Notifications",
    member:"Notify",signature:"susssasa{sv}i",
    body:["WhatsApp",0,"","Alice","3 new messages",[],{},5000]}));
  console.log("id",r.body[0]);process.exit(0);
});'
```

**Debug the packaging.** `npm run dist:dir`, then
`npx @electron/asar list release/linux-unpacked/resources/app.asar | head`, and run
`release/linux-unpacked/whatsapp-desktop --dev` to launch without installing.

## Conventions <a name="conventions"></a>

- TypeScript strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature`. Conditional spreads (`...(x ? {a:x} : {})`) instead of
  passing `undefined` to optional props.
- `unknown` at every boundary, narrowed by a named function; no `any`, no non-null `!` (both are
  lint errors). `catch (error: unknown)` and `serializeError` for logs.
- Untrusted text is always run through `collapseWhitespace`/`truncate`/`sanitizeName` before it
  reaches a title, a badge or a log line.
- One `EventEmitter` per module, typed via `TypedEmitter<Events>`; listeners are isolated so one
  throwing subscriber cannot break the others.
- No `BrowserWindow`/`Tray`/`Notification` outside their owning module — enforced by convention and
  by the import rules in ESLint (`no-restricted-imports` for `node:fs`/`child_process` in
  `src/preload` and `src/renderer`).
- Comments say _why_ (a constraint, an API limitation, a rejected alternative), never what the next
  line obviously does. Platform quirks get a link to the spec or the changelog.
- `as any` is never used to silence a type error; the escape hatch is `unknown` plus a narrowing
  function, so the check is real.

## Release checklist <a name="release"></a>

```bash
git status --porcelain            # clean tree
rm -rf out release && npm ci
npm run typecheck && npm run lint && npm run format:check
npm test
npm run build:prod
npm run smoke                     # 21 checks, must end with smoke: PASSED
npx electron-builder --linux AppImage deb --publish never
# verify the artefacts on a real session:
./release/*-x86_64.AppImage --dev                # tray, notifications, badge, shortcut, DND
ls ~/.config/autostart/com.whatsappdesktop.app.desktop
# upgrade test: launch the *previous* version, log in, then launch this one and confirm you are
# still logged in (this is the one regression that must never ship)
sha256sum release/*.AppImage release/*.deb > release/SHA256SUMS
```

Then tag `vX.Y.Z`, attach the AppImage/deb plus `SHA256SUMS` and this file's `docs/` notes about
brand assets, and mention Electron/Chromium versions (the `appVersion` line in `Copy diagnostics`
already contains them).
