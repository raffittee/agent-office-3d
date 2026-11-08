# Plan: Agent Office as a desktop app and widget (Phase 9)

Status: **plan, awaiting approval**. Nothing here is built yet. Written 2026-11-08.

## Goal

Install Agent Office like a normal Windows program and keep it on the desktop as a small widget:

- a **Setup `.exe`** that installs per user (no admin rights, no Node.js needed), with a Start Menu entry;
- a normal **window mode** (the full office) and a **widget mode** (small, frameless, optionally always on top,
  compact UI);
- a **tray icon** that shows when an agent needs you, so you don't have to keep the window in view;
- the same release pipeline as today: pushing to `release` also builds, tests and publishes the installer.

Windows first. macOS (`.dmg`) and Linux (AppImage) use the same code and are a later, small step.

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | **Electron** | It bundles Node and Chromium, so the existing server and the WebGL page run unchanged, and users need nothing installed. Tauri would need Rust plus a bundled Node sidecar for little gain. |
| 2 | The server runs as a **child process** of the app (Electron's own Node, `ELECTRON_RUN_AS_NODE=1`), not inside the app process | `server/index.ts` starts on import and calls `process.exit`. A child keeps it isolated and untouched, and the app can kill it on quit. |
| 3 | **Adopt a running server.** If `/api/health` already answers on the port (for example `agent-office start` in a terminal), the app uses it and does not start another | Two servers on one port is the most likely first-run failure. |
| 4 | The app **reuses the release package**: `npm run package` output goes into the installer as `resources/package/` | One build for both distribution forms, and the hook shims and installers stay real files that an external `node` can run (files inside `app.asar` can't be). |
| 5 | **Separate `desktop/` package** with its own `package.json` and lockfile (Electron and electron-builder are devDependencies there only) | Keeps `npm ci` at the repo root and in normal CI free of a ~100 MB Electron download. This amends D11 ("one npm package"); it gets ADR 0007. |
| 6 | Installer: **NSIS, per user** (electron-builder), x64 | No admin prompt, easy uninstall, standard. MSI and the Store are not needed. |
| 7 | **Hardened by default:** `contextIsolation`, `sandbox`, no `nodeIntegration`, the window can load only `http://127.0.0.1:<port>`, new windows and navigation blocked, external links open in the default browser (http/https only), every permission denied except notifications | The page is local and trusted, but the app must not become a way to load anything else. Same rules as `docs/security.md`. |
| 8 | The app adds **no network calls** and no telemetry. Updates are a **manual download** in v1 | Keeps the "no outbound calls" promise. Opt-in auto-update is a possible later step (open question 2). |

## How it fits together

```
 Agent Office.exe (Electron main process)
   |- finds a free port, or adopts a running server -------------> server (child: dist/server/index.js)
   |- BrowserWindow -> http://127.0.0.1:<port>/?shell=desktop   (the same page as the browser)
   |    '- preload (contextBridge): setMode, setPinned, minimize, close  -- the only door to the main process
   |- Tray: menu + attention badge   <-- reads /api/stream (SSE) from the server
   '- Notifications, start at login, window position and size (saved in the app's own folder)
```

- The page learns it is in the app from `?shell=desktop&mode=window|widget`. It adds a CSS class, nothing else
  changes in `client/src/core/`. Widget mode hides the sidebar, feed and top bar, shows a thin drag bar (pin, switch
  mode, close), and keeps the camera fitted to the whole office on resize.
- The tray reads the same event stream as the page, so it needs no new server route. It counts agents whose status is
  `waiting` (they need you).
- The simulation, protocol and server do not change. Only a small flag in the client and CSS.

## Tasks

Each task is one commit with tests where there is logic. Pure logic (port choice, window-state maths, URL allow-list,
tray counting) lives in plain TypeScript and is unit-tested without Electron.

- [ ] **P9-02 Scaffold** — ADR 0007; `desktop/` (package.json, tsconfig, esbuild build to `desktop/dist/`); `npm run
  desktop:dev` (builds the package, starts Electron); boundary test so `desktop/` imports nothing from `server/` or
  `client/` but `shared/` types.
- [ ] **P9-03 Server host** — pick a port (4848, else the next free one, saved), adopt a healthy server or spawn one,
  wait for health, restart once if it dies, stop it on quit, logs to the app folder (never conversation content),
  single-instance lock (a second launch focuses the first).
- [ ] **P9-04 Window and hardening** — `BrowserWindow`, preload, navigation and permission locks, external links,
  remembered size and position (kept on screen if a monitor goes away), dev tools off in release builds.
- [ ] **P9-05 Widget mode** — client `shell=desktop` class and compact CSS; frameless window, always on top, opacity,
  click-through with a global hotkey, size and position remembered per mode, auto-fit camera, lighter rendering when
  small (DPR 1, 30 fps when not focused). Settings stay in the page's existing Settings dialog.
- [ ] **P9-06 Tray and attention** — tray menu (Show, Widget, Always on top, Start at login, Quit); close button hides to
  the tray (setting); taskbar overlay dot and tooltip when agents wait; native notifications reuse the alert
  preferences; taskbar flash on a new alert.
- [ ] **P9-07 Integrations** — a small dialog to install and remove the Gemini CLI, Codex and Claude Code hooks (runs the
  bundled installers) and a clear message when `node` isn't on the PATH. See risk 1.
- [ ] **P9-08 Packaging** — electron-builder NSIS config, app icon, version from the root `package.json`,
  `extraResources` = the release package, `npm run desktop:build`. Uninstall also removes hooks (same as
  `install.ps1 -Uninstall`).
- [ ] **P9-09 Pipeline** — CI: build the unpacked app and smoke-test it on Windows with Playwright's Electron driver
  (window opens, `/api/health` answers, widget toggle works, screenshot, quits cleanly). `release.yml`: new `desktop`
  job builds the installer, smoke-tests a silent install and uninstall, and the publish job attaches
  `Agent-Office-Setup-<version>.exe` and its checksum.
- [ ] **P9-10 Docs and close** — `docs/desktop.md` (install, widget, tray, SmartScreen note, uninstall), README,
  `docs/releasing.md`, CHANGES, TASKS; PR `phase-9` -> `main`.
- [ ] **P9-11 (later) macOS and Linux** — `.dmg` and AppImage from the same config, added to the same pipeline.

## Verification

| What | Where |
| --- | --- |
| Pure logic, window-state maths, URL allow-list, tray counts | Vitest, in the cloud and in CI |
| The page in widget mode (layout, drag bar) | Playwright screenshot in CI, like `npm run shot` |
| The real app: launch, server up, tray, widget toggle, quit | Playwright Electron on the Windows runner |
| Installer: silent install, launch, uninstall | Windows runner in the release workflow |
| Look and feel, always on top, click-through, tray on your taskbar, DPI scaling | **Your machine** (I can't see a desktop from here) |

The cloud session may not be able to download the Electron binary; if so, the real-app checks run only in CI.

## Risks

1. **Hooks need `node` on the PATH.** Gemini CLI and Codex run our hook shims with `node`. Electron's bundled Node
   isn't on the PATH, and starting the whole app per hook would slow the agent. So hooks (and only hooks) still need
   Node.js installed. Claude Code needs nothing, because the office reads its folders. P9-07 detects and explains it.
   A tiny dedicated hook runner could remove this later.
2. **Transparent windows plus WebGL** can glitch on some GPUs and drivers. Widget mode ships opaque by default; a
   transparent background is an opt-in setting.
3. **Unsigned installer.** Windows SmartScreen shows "unknown publisher" until the app is signed and has reputation
   (open question 1).
4. **Electron's bundled Node must be 22.12 or newer** (the server needs it). I check `process.versions.node` in the
   smoke test and pin the exact Electron version.
5. **Port clash or stale server.** Covered by adopting a healthy server and by the saved port; the health response
   includes the version, and the app warns if it adopted an older one.
6. **Installer size** is about 80-100 MB (Chromium). Normal for Electron.
7. **I can't test the look and feel** from the cloud. I'll ship builds early so you can try them, and treat your
   feedback on widget mode as part of the exit criteria.

## Exit criteria

- Download `Agent-Office-Setup-<version>.exe`, install without admin rights, and the office appears with your
  running agents.
- Widget mode: small, stays on top when asked, remembers where you put it, and shows nothing but the office.
- Closing to the tray keeps it running, and the tray shows when an agent waits for you.
- Uninstall removes the app and the hooks, and keeps `~/.agent-office`.
- The release pipeline publishes the installer next to the existing `.zip` and `.tar.gz`, only after its tests pass.

## Open questions for you

1. **Code signing.** Unsigned (free; SmartScreen warns on first run) or signed (needs a certificate, or Azure Artifact
   Signing at roughly $10 a month)? Recommended: unsigned for now; it can be added later without redoing anything.
2. **Updates.** Manual download (matches "no outbound calls") or an opt-in "check for updates" that contacts GitHub
   Releases? Recommended: manual in v1.
