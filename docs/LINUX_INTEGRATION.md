# Linux desktop integration

Everything an experienced Linux user will ask about, including what is _not_ possible and why. Each
row names the Electron API or D-Bus interface involved, so you can check it against your own session
rather than trusting this document.

- [How each feature is implemented](#how)
- [Per-desktop matrix](#matrix)
- [Notifications over D-Bus](#notifications)
- [Badges](#badges)
- [Tray](#tray)
- [Global shortcuts](#shortcuts)
- [Start on login](#autostart)
- [Do Not Disturb and the desktop](#dnd)
- [Wayland](#wayland)
- [Flatpak / sandboxing](#sandbox)
- [Debugging commands](#debugging)
- [Packaging](#packaging)

---

## How each feature is implemented <a name="how"></a>

| Feature          | Mechanism                                                                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window           | `BrowserWindow` with `name: 'whatsapp-desktop'` → `WM_CLASS`; `setIcon`/`icon` for the taskbar icon                                                                                                                                             |
| Desktop identity | `app.setDesktopName('com.whatsappdesktop.app')` (exists in Electron 44) + the `desktop-entry` hint on every notification                                                                                                                        |
| Tray             | Electron's Linux `Tray` = a StatusNotifierItem client on the session bus (libayatana-appindicator if the build links it). Menu via `setContextMenu` (D-BusMenu).                                                                                |
| Notifications    | `org.freedesktop.Notifications.Notify` through `dbus-next`, with `replaces_id`, `urgency`, `suppress-sound`, `desktop-entry`, `category=im.received`, `x-canonical-private-synchronous`, optional `actions`. Fallback: Electron `Notification`. |
| Click activation | `ActionInvoked` signal (matched by sender+interface+member), mapped back to our group id.                                                                                                                                                       |
| Badge            | Redrawn tray icon + `Tray.setTitle` + tooltip + `app.setBadgeCount()`                                                                                                                                                                           |
| Shortcut         | `globalShortcut` (X11: XGrabKey; Wayland: portal if the Electron build uses one, otherwise the compositor decides)                                                                                                                              |
| Start on login   | `$XDG_CONFIG_HOME/autostart/com.whatsappdesktop.app.desktop`                                                                                                                                                                                    |
| System DND       | `org.freedesktop.portal.Settings.Read` (+ `SettingChanged`, polled every 15 s)                                                                                                                                                                  |
| Theme            | `nativeTheme` is _not_ used; the settings window follows `prefers-color-scheme`, and the tray icon can be rendered symbolic                                                                                                                     |

## Per-desktop matrix <a name="matrix"></a>

| Desktop                                         | Tray                                                                                   | Notifications                                                                     | Click → focus                                                                                                                                               | Badge text                              | Notes                                                                                                                                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KDE Plasma 5/6**                              | ✔                                                                                      | ✔                                                                                 | ✔                                                                                                                                                           | ✔ (`setTitle` is rendered by the panel) | Best-supported target: Plasma's system tray implements the StatusNotifier host side itself.                                                                                                  |
| **GNOME 40+ (stock)**                           | ✘ — no SNI host                                                                        | ✔ (gnome-shell is the notification server; it suppresses per-app via its own DND) | usually ✘ — GNOME's notification stack does not deliver activations for `org.freedesktop.Notifications` clients; use `org.gtk.Notification`/portal for that | n/a                                     | Install "AppIndicator and KStatusNotifierItem Support" (packaged as `gnome-shell-extension-appindicator`) for the tray. The app detects the missing host and makes ✕ quit instead of hiding. |
| **Ubuntu GNOME**                                | ✔ (ships the extension)                                                                | ✔                                                                                 | partial                                                                                                                                                     | ✔                                       |                                                                                                                                                                                              |
| **Cinnamon / MATE / Xfce**                      | ✔                                                                                      | ✔ (xfce4-notifyd, mintstick)                                                      | ✔                                                                                                                                                           | ✔                                       |                                                                                                                                                                                              |
| **LXQt**                                        | ✔ (lxqt-opensession… SNI host)                                                         | ✔                                                                                 | ✔                                                                                                                                                           | ✔                                       |                                                                                                                                                                                              |
| **deepin**                                      | ✔ (own DDE tray)                                                                       | ✔                                                                                 | ✔                                                                                                                                                           | ✔                                       |                                                                                                                                                                                              |
| **Sway / Hyprland / wlroots**                   | only with a tray host: waybar's `tray` module, `stalonetray`, or a standalone SNI host | ✔ if a notification daemon runs (`mako`, `fnott`, `swaync`)                       | `swaync` ✔; `mako` depends on its `on-notify`/action config                                                                                                 | `setTitle` is rendered by waybar        | Start the app, then check `Settings ▸ Status`.                                                                                                                                               |
| **Enlightenment, i3 (+`i3blocks`/`py3status`)** | i3 needs a tray helper (`trayer`, `stalonetray`…)                                      | ✔ with `dunst`/`mako`                                                             | ✔ with dunst (actions)                                                                                                                                      | –                                       |                                                                                                                                                                                              |
| **Headless / CI / Xvfb**                        | only with a fake watcher (`scripts/fake-sni-watcher.mjs`)                              | only with a daemon (`dunst`)                                                      | –                                                                                                                                                           | –                                       | This is exactly what `npm run smoke` does.                                                                                                                                                   |

If a whole column is ✘ for your desktop, that is the desktop's policy, not a bug in the wrapper —
`Settings ▸ Status` reports what it could detect, and every feature degrades independently.

## Notifications over D-Bus <a name="notifications"></a>

`LinuxDBusBackend` performs, on `org.freedesktop.Notifications` at `/org/freedesktop/Notifications`:

1. `GetCapabilities()` → `as` — we look for `actions`, `body-markup`, `body-hyperlinks`,
   `persistence`, `inhibitor` (the last one is reported in diagnostics; we do not inhibit at the
   server, because our own DND gate is where the decision belongs).
2. `Notify(app_name, replaces_id, app_icon, summary, body, actions, hints, expire_timeout)` with
   signature `susssasa{sv}i`. `replaces_id` is how a group's counter updates **in place** instead of
   stacking — the single most useful thing the raw bus gives us over Electron's wrapper.
3. `CloseNotification(id)`.
4. `AddMatch` for `ActionInvoked` (`(us)`) and `NotificationClosed` (`(uu)`), filtered by
   `sender=org.freedesktop.Notifications`; the close reason maps to
   `expired | dismissed-by-user | program`.

Why this is a _fallback-friendly_ design: if `dbus-next` is not installed, if there is no session bus
(ssh, some CI), if the daemon does not answer within the timeout, or if `Notify` returns id 0 — the
capability probe reports `available: false` with a reason, `NotificationService` selects the Electron
backend, and the user sees one line in `Settings ▸ Status` instead of a broken app.

Electron's `Notification` on Linux, for comparison: it uses the same bus but exposes no
`replaces_id`, no `desktop-entry` hint, and `click` support depends on the server; `actions` is
macOS/Windows only in Electron 44, and `groupId`/`id` likewise. That is why the D-Bus path exists and
why grouping is implemented by us rather than delegated to the notification centre.

## Badges <a name="badges"></a>

There is **no** portable "badge count" API on Linux.

| Candidate                                                                                   | Status                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `UnityLauncherEntry.SetProperty('count-visible'/'count')`                                   | Unity only; not implemented by GNOME/KDE                                                                                                         |
| `com.canonical.Unity.LauncherEntry` badge hint                                              | dead outside Ubuntu's old launcher                                                                                                               |
| `Tray.setTitle` (SNI `Title`)                                                               | Works on KDE and in waybar/most panels; GNOME with the appindicator extension usually ignores it                                                 |
| `Tray.setToolTip`                                                                           | Widely shown                                                                                                                                     |
| Drawing into the icon                                                                       | Works everywhere a tray icon works at all — so we do it: `src/main/icons/IconRenderer.ts` renders the bubble + a red count disc, capped at `99+` |
| `app.setBadgeCount()` (libunity/`_NET_WM_ICON`… on Linux it is a no-op on most compositors) | called anyway: it costs nothing and works on some                                                                                                |
| Window title                                                                                | `WhatsApp (5)` — the most reliable "badge" on Linux, and always available                                                                        |

## Tray <a name="tray"></a>

Availability is **probed**, because Electron 44 has no `Tray.isSupported()` and platform capability
was never the interesting question anyway:

```ts
const watcher = await dbus.hasService("org.kde.StatusNotifierWatcher");
// true  -> a host exists, create the tray
// false -> no host: report unavailable, and make close-to-tray fall back to quit
// null  -> no session bus at all: optimistic, try to create it (some hosts start late)
```

Then `new Tray(nativeImage)` inside `try/catch`, `setContextMenu`, `setImage`/`setTitle` on state
changes, and `destroy()` on shutdown. Two behaviours worth knowing:

- **Click vs double-click.** `click` toggles visibility (per the requirement); `double-click` shows
  and focuses. Some hosts emit both for one gesture; the net effect is "visible", which is the safer
  direction for a wrapper. (`Tray.setIgnoreDoubleClickEvents(true)` is the alternative if you prefer
  strict toggling — one line in `TrayManager`.)
- **Left-click menus.** libappindicator-based hosts can show _only_ the context menu on any click.
  The menu therefore contains the same Show/Hide/Toggle entries as the click handler.

## Global shortcuts <a name="shortcuts"></a>

`globalShortcut.register(accelerator, handler)` returns `false` when the combination is taken (no
error object exists), which `ShortcutManager` turns into a persisted, visible note in
`Settings ▸ Shortcuts` plus a "Test" button that registers-and-releases a candidate. The default is
`Ctrl+Shift+W`. `Ctrl+Alt+W`/`Super+…` are usually free; plain `Alt+Tab`-adjacent combinations often
are not, because the window manager grabs them first — a grab the application cannot detect, so the
only honest answer is "registration failed, pick another".

`dispose()` calls `unregister(accelerator)` for our own binding only (never `unregisterAll()`, which
would tear down bindings other code in the process may own) and is on the shutdown path, so quitting
never leaves your keyboard grab hanging. On Wayland, if the compositor refuses the grab entirely,
the same failure path applies — and the tray/global-menu route still works.

## Start on login <a name="autostart"></a>

`app.setLoginItemSettings()` is `@platform darwin,win32` in Electron 44, so on Linux the
platform-specific route is the freedesktop autostart entry (`src/main/autostart/`):

```ini
[Desktop Entry]
Type=Application
Name=WhatsApp Desktop
Exec="/path/to/WhatsApp Desktop-1.0.0-x86_64.AppImage" "--hidden"
Icon=com.whatsappdesktop.app
Terminal=false
Categories=Network;InstantMessaging;
StartupWMClass=whatsapp-desktop
X-GNOME-Autostart-enabled=true
X-KDE-autostart-after=panel
NoDisplay=false
```

Rules we follow, because autostart is where desktop apps annoy people:

- The file name is the desktop id, so the DE's own "Autostart" panel manages it and the user can
  delete it by hand.
- `Exec` for an AppImage is `$APPIMAGE` (the real file), not the FUSE mount point, so replacing the
  AppImage does not break the login item.
- On every start the entry is _read_ and reconciled: missing → write, stale `Exec` → rewrite (and
  say so in Settings), `Hidden=true` → treated as disabled without overwriting the user's choice.
- Turning it off deletes the file rather than hiding it.
- Sandbox note: inside Flatpak the profile is per-app, so the portal
  (`org.freedesktop.portal.Background.RequestBackground`) is the correct mechanism;
  `createAutostartBackend(logger, { sandboxed: true })` selects the Electron path and the portal
  implementation belongs in that one file.

## Do Not Disturb and the desktop <a name="dnd"></a>

`DNDService` ORs three inputs and the rest of the app only asks `isEnabled()`. `XdgPortalDndSource`
reads `org.freedesktop.portal.Settings` for `org.freedesktop.appearance/notify-snooze`,
`org.gnome.desktop.notifications/show-banners` (inverted) and `org.xfce.notifyd/notifications-disabled`,
subscribes to `SettingChanged` and polls every 15 s (several portal implementations never emit that
signal for proxied keys). It is opt-in (`syncSystemDnd`), because a desktop that reports "DND" for an
unrelated reason should not silently mute you. `powerMonitor`'s `lock-screen` deliberately does _not_
flush the queue — a badge is supposed to still be there when you unlock.

## Wayland <a name="wayland"></a>

- Notifications, the tray and the shortcut mechanism are session-bus features: they work on Wayland
  exactly as on X11 (the tray needs an SNI host; KDE/GNOME-extension/waybar all qualify).
- Window raising after a notification click is subject to the compositor's focus policy: an
  unfocused client cannot steal focus. `WindowManager.focus()` therefore does `restore → show →
moveTop → focus` and `flashFrame` as a hint, and never pretends to force it. On GNOME this can mean
  "the window is mapped and the taskbar entry demands attention" instead of an instant raise.
- `--ozone-platform-hint=auto` (or `--ozone-platform=wayland`) makes Electron run natively on
  Wayland, which is what you want for fractional scaling and correct input; `xwayland` mode also
  works. Add it in your launcher (`Exec=… --ozone-platform-hint=auto`) rather than in code: the
  preferred platform is a session decision, and some tray hosts behave differently under each.
- Global shortcuts on pure Wayland depend on the compositor; if a portal grab is unavailable the app
  reports the failure instead of silently doing nothing.

## Flatpak / Snap <a name="sandbox"></a>

Nothing in the application requires host access, so a Flatpak build is mostly packaging work
(Flathub's Electron runtime, or the Flatpak maker from `@electron/packager`). Constraints to respect:

- `~/.config/autostart` inside the sandbox is not the host's → use the Background portal (above).
- `--no-sandbox` must never be needed. If Chromium's sandbox complains inside Flatpak, the
  `--socket`/`--share=ipc` portion of the manifest is wrong, not the application.
- The D-Bus session bus is filtered by `bus-name` ownership: `org.freedesktop.Notifications` is
  allowed, `org.kde.StatusNotifierWatcher` requires the `--talk-name=org.kde.StatusNotifierWatcher`
  plus (for the item itself) `--own-name=org.kde.StatusNotifierItem-*`. The app tolerates their
  absence.
- Prefer the XDG Notification **portal** in a Flatpak build: the same `INotificationBackend` interface
  is where that belongs (`notifications/backends/XdgPortalNotificationBackend.ts`), and
  `NotificationService` needs one extra constructor entry.

## Debugging commands <a name="debugging"></a>

```bash
echo "$XDG_CURRENT_DESKTOP / $XDG_SESSION_TYPE"
busctl --user list | grep -Ei 'notifications|StatusNotifier|portal'
gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
  --method org.freedesktop.DBus.ListNames | tr ',' '\n' | grep -i notifier
notify-send -a "WhatsApp Desktop" "Test" "hello"          # does the daemon work at all?
journalctl --user -b | grep -i -E 'appindicator|notifier' # host-side complaints
xprop WM_CLASS                                            # then click the window -> "whatsapp-desktop","WhatsApp Desktop"
strace -f -e trace=connect -p "$(pgrep -f whatsapp-desktop | head -1)" 2>&1 | grep -i dbus
tail -f ~/.config/whatsapp-desktop/logs/main.jsonl | jq -c 'select(.scope|test("tray|notification"))'
WA_DESKTOP_LOG_LEVEL=debug npx electron . --dev --no-tray   # rule the tray out
npx electron . --dev --debug-crash                          # error boundary behaviour
tail -f ~/.config/whatsapp-desktop/logs/main.jsonl | jq -r '[.ts,.scope,.msg]|join(" ")'
npm run smoke -- --keep                                                # full desktop + kept profile
```

## Packaging <a name="packaging"></a>

`electron-builder.yml` documents each choice. Summary of the Linux-relevant ones:

- `executableName: whatsapp-desktop` (which _is_ the `.desktop` base name: electron-builder uses
  `getDesktopFileName() === executableName` unless `linux.syncDesktopName` is set), `icon: build/icons`
  (16/22/24/32/48/64/128/256/512, generated, not committed), `linux.desktop.StartupWMClass`, and the
  same string in the generated autostart entry — `DESKTOP_FILE_NAME` in `src/shared/constants.ts` must
  agree with all of them or notifications and window grouping decouple from the icon.
- `libayatana-appindicator3-1` in `deb.recommends`, not `depends`.
- `asarUnpack: out/**` so the ESM entry point is a plain file for every distro's layout.
- AppImage: no `after-install` script, no root, and `$APPIMAGE` used for autostart.
- `deb` runtime deps listed explicitly (`libgtk-3-0`, `libnss3`, `libasound2`/`t64`, `libgbm1`, …) —
  if your target is a minimal image, that list is where to look first.
