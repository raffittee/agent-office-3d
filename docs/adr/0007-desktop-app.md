# ADR 0007: The desktop app is an Electron shell in its own package

Status: accepted (2026-11-08). Amends [ADR 0001](0001-stack.md) (one npm package, no workspaces).

## Context

Users want to install Agent Office like a normal program and keep it on the desktop as a small widget, with a tray
icon that shows when an agent needs them. The server is Node with no runtime dependencies and the client is a WebGL
page, so both can run unchanged inside Chromium plus Node. Windows comes first.

## Decision

- **Electron**, not Tauri. It bundles Node and Chromium, so the existing server and page run unchanged and the user
  needs nothing installed. Tauri would need Rust plus a Node sidecar for little gain.
- The server runs as a **child process** (the app's own executable as Node, `ELECTRON_RUN_AS_NODE=1`), not inside the
  app process: `server/index.ts` starts on import and exits the process. A server already running on the port is
  adopted instead of starting a second one. A clean shutdown is requested over an IPC message, because signals can't
  do it on Windows.
- The installer bundles **the release package** (`npm run package`) as `resources/package/`, so there is one build for
  both forms, and the hook shims and installers stay real files that an external `node` can run (files inside
  `app.asar` can't be).
- The shell lives in **`desktop/`, with its own `package.json` and lockfile.** Electron and electron-builder are
  installed only by the jobs that need them, so `npm ci` at the root (and normal CI) stays free of a ~150 MB
  download. This amends ADR 0001: the app is still one package; the desktop shell is a second, separate one that
  depends on nothing in the first at runtime.
- `desktop/src/lib/` holds the logic (ports, server hosting, security rules, window and settings maths, tray
  counting, the live-stream reader). It imports only `node:*`, `shared/` types and relative paths, is unit-tested by
  the root `vitest`, and is type-checked by the root `npm run typecheck`. Only `desktop/src/*.ts` imports `electron`.
- Hardened by default: `contextIsolation`, `sandbox`, no `nodeIntegration`; the window loads only the app's own
  `http://127.0.0.1:<port>` origin; new windows and other navigation are blocked and http(s) links open in the
  browser; only notifications are granted as a permission; IPC accepts messages only from the app's own page.
- No network calls of its own and no telemetry. Updates are a manual download. The installer is unsigned for now.

## Consequences

- Two lockfiles to keep current; `desktop/package.json` pins exact versions like the client does.
- Gemini CLI and Codex hooks still run our shims with `node` from the PATH, so they need Node.js installed even with
  the desktop app (Claude Code needs nothing). The app detects and explains this.
- The installer is about 80-100 MB (Chromium). Windows SmartScreen warns about an unknown publisher until the app is
  signed.
- Electron's bundled Node must be 22.12 or newer; the exact Electron version is pinned and checked in the smoke test.
