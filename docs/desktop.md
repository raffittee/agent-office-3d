# Desktop app and widget

Agent Office as a normal Windows program: a Setup `.exe` that needs no Node.js, a full window, a small widget that
can stay on top of your other windows, and a tray icon that tells you when an agent needs you.

It is the same office as in the browser: the app starts the Agent Office server for you and shows the page in its own
window. Everything in [README.md](../README.md) about providers, hooks and privacy applies unchanged.

## Install

1. Download `Agent-Office-Setup-<version>.exe` from the [Releases page](../../releases).
2. Run it. It installs **for your user only** (no administrator prompt) under
   `%LOCALAPPDATA%\Programs\Agent Office` and starts the app.
3. Windows may say **"Windows protected your PC"** or "unknown publisher". The installer isn't signed yet. Choose
   *More info*, then *Run anyway*. The checksum is on the release page (`SHA256SUMS`) if you want to verify the file:
   `Get-FileHash Agent-Office-Setup-<version>.exe`.

Upgrade by running a newer installer. Uninstall from *Settings > Apps*: this also removes the hooks Agent Office added
to Gemini CLI, Codex and Claude Code, and keeps your data (`%USERPROFILE%\.agent-office`).

## Using it

| | |
| --- | --- |
| **Window mode** | The full office, with the sidebar, feed and details. The `▣` button in the top bar switches to the widget. |
| **Widget mode** | A small frameless window with one slim bar: how many agents need you or work, and the buttons `📌` keep on top, `⤢` frame the office, `▢` open the full window, `–` minimize, `✕` close. Drag the bar to move it, drag the edges to resize. The camera keeps the whole office in view. |
| **Close button** | Hides the app to the tray (it keeps running). Turn that off in the tray menu to make it quit. |
| **Tray icon** | Click to show or hide. The icon gets a red dot, the taskbar button an overlay dot and the tooltip says who needs you ("2 need you · 3 working"). Right-click for the menu. |
| **Notifications** | A Windows notification when an agent starts waiting for you (only when the window isn't in front). It names the agent and its project, never what it asked. |
| **Hotkeys** | `Ctrl+Alt+O` show or hide the app. `Ctrl+Alt+C` click-through for the widget: the mouse passes through it, so it can sit over your work. Press again (or use the tray menu) to get the mouse back. |

The tray menu also has: widget on top, widget opacity (100 to 40%), notifications, start with Windows, *Open in
browser* and *Hooks and integrations*.

## Hooks and integrations

Claude Code needs nothing: the office reads its folders. For live activity from **Gemini CLI** and **Codex**, and for
the Claude Code plan-usage bars, open *Hooks and integrations* (the `🔌` button in the top bar, or the tray menu) and
press *Install*. It does what `agent-office hooks install` does in the command-line package, and shows what it did.

**These hooks need Node.js on your PATH.** Gemini CLI and Codex run Agent Office's hook scripts with `node`, and the
app's own copy of Node is not on the PATH. The dialog says so when Node.js 22.12 or newer is missing
([nodejs.org](https://nodejs.org)). Claude Code is unaffected.

Approving permission requests and sending messages from the office are off by default. To use them, set the
environment variable `AGENT_OFFICE_INTERACTIVE=1` (Windows: *Edit environment variables for your account*), restart
the app, and read [interactive.md](interactive.md) first.

## Where things are

| | |
| --- | --- |
| App settings (mode, bounds, tray options) | `%APPDATA%\Agent Office\settings.json` |
| App log (starting and stopping the server; never conversation content) | `%APPDATA%\Agent Office\logs\desktop.log` |
| Agent Office's data (names, rooms, hook port), shared with the browser and the command line | `%USERPROFILE%\.agent-office` |

**Port.** The app uses port 4848, or the next free one, and remembers it. If Agent Office is already running (for
example `agent-office start` in a terminal), the app uses that server instead of starting a second one. Set
`AGENT_OFFICE_PORT` to force a port. The hooks post to the port saved in `~/.agent-office/hooks.json`; *Install*
refreshes it.

## Security

The window can load only the app's own `http://127.0.0.1:<port>` page. Other navigation is blocked, and `http(s)` links
open in your browser. The page has no Node access (`contextIsolation`, `sandbox`, no `nodeIntegration`) and talks to the
app through a handful of validated messages (`desktop/src/lib/ipc.ts`). Only notifications are granted as a permission. The app makes no network calls of
its own and sends no telemetry; updates are a manual download. See [security.md](security.md).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| "Agent Office could not start" | The message names the cause (often a port problem). The log above has the server's last lines. Try `AGENT_OFFICE_PORT=4900`. |
| The window is blank or shows a retry loop | The server is still starting; wait a few seconds. If it persists, open the log. |
| No tray icon | Windows may hide it: drag it from the "^" overflow area to the taskbar. |
| The widget is stuck and ignores the mouse | Click-through is on: press `Ctrl+Alt+C` or use the tray menu. |
| Gemini CLI or Codex never appear | Install the hooks (above), make sure Node.js is on the PATH, restart open sessions. |
| Windows blocks the installer | See "unknown publisher" above. |

## Building it yourself

```bash
npm ci
npm run desktop:install      # Electron and electron-builder, in desktop/ (about 150 MB)
npm run desktop:dev          # build the web app and the package, then start the app (AGENT_OFFICE_DEMO=1 for demo agents)
npm run desktop:build        # the Windows installer: desktop/out/Agent-Office-Setup-<version>.exe (on Windows)
node desktop/tools/pack.mjs --dir    # just the unpacked app, which the smoke test runs
```

If a download fails with `504 Gateway Time-out` (GitHub's release downloads do that now and then), run the command again: the
downloads are cached, so it picks up where it stopped. `node desktop/tools/retry.mjs 4 30 -- npm run desktop:build` does
that for you; CI uses it too.

How it is built and why: [ADR 0007](adr/0007-desktop-app.md). The release pipeline builds and tests the installer too
([releasing.md](releasing.md)).

## Known limits

- Windows only for now (x64). The same code builds for macOS and Linux; they are not published yet.
- The installer is unsigned.
- Hooks for Gemini CLI and Codex need Node.js installed.
- The widget is opaque (no transparent background): transparency and WebGL don't mix reliably across GPUs.
- The tray, hotkeys and notifications are checked by hand, not by the automated tests.
