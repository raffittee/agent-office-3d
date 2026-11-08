# Changelog

Release notes for people who use Agent Office. The day-by-day development log is in [CHANGES.md](CHANGES.md).

## 0.1.0 — 2026-10-25

The first release: a 3D office in your browser that shows what your AI coding agents are doing, live.

### Watch your agents

- **Claude Code, Gemini CLI (≥ 0.65) and Codex** are supported, plus your own agents through the TypeScript and
  Python SDKs (or `POST /api/events`).
- **Rooms and characters:**
  - each project with an open session becomes a room, and each agent and subagent is a character;
  - agents type while working, raise a hand when they need you, and wait at their desk for a background command;
  - subagents carry their result to their parent, and characters leave when the session ends.
- **Panels:**
  - a sidebar with search;
  - details for each agent: current activity, tasks, subagents, timeline and stats;
  - a live activity feed and toasts;
  - plan-usage bars for Claude Code and Codex.

### Life and looks

- **Idle life:** idle agents hang out (TV, ping-pong, arcade, coffee, chats). Each has a personality, and some are
  friends or rivals.
- **Day and night** follow your local time.
- **Room effects:** rooms throw a party when a PR is opened or merged or a release is published, and sound an alarm
  on red CI.
- **Themes:** five built-in themes (modern, industrial loft, traditional, startup, cozy cabin), Halloween and holiday
  decorations, and your own theme packs ([docs/themes.md](docs/themes.md)).
- **Optional:** sounds, browser notifications, and a "(n) Agent Office" tab title when agents need you.

### Act from the office (off by default, local only)

Turn these on with `AGENT_OFFICE_INTERACTIVE=1`:

- approve or deny Claude Code's permission requests, and answer its questions;
- message Claude Code (with the `agent-office-messages` plugin), Codex and SDK agents;
- read any agent's conversation and browse recent sessions.

Read [docs/interactive.md](docs/interactive.md) for setup and risks.

### Run it

- **Windows desktop app:** `Agent-Office-Setup-<version>.exe` installs for your user (no administrator prompt, no
  Node.js needed). It has a full window, a small always-on-top **widget**, a tray icon that shows when an agent needs
  you, notifications, and a dialog to install the Gemini CLI, Codex and Claude Code hooks. Windows may warn about an
  unknown publisher: the installer isn't signed yet. See [docs/desktop.md](docs/desktop.md).
- **Install a release (command line):** download the `.zip` (Windows) or `.tar.gz` (Linux, macOS), unpack it, and run `install.ps1` or
  `install.sh`. It sets up an `agent-office` command and, on Windows, a Start Menu shortcut. Details are in the package's
  README.
- **From source:**
  - `npm ci && npm run build && npm start`;
  - `npm run demo` shows simulated agents.
- **In Docker:** `npm run docker:up`. It mounts only what the office reads, read-only, and publishes on 127.0.0.1
  only.
- **Hooks:** `npm run hooks:install -- --provider gemini-cli | codex | claude-code`, with backups and `uninstall`.

### Privacy and security

- **Local and read-only:** binds to 127.0.0.1, reads agent folders read-only, and never opens credential files.
- **No leaks:** masks secrets, and sends no telemetry.
- **Hardened page:** a strict Content-Security-Policy, CSRF and DNS-rebinding guards, and local-only interactive
  routes.
- **Threat model:** [docs/security.md](docs/security.md).

### Accessibility

- **Keyboard:** the panels work from the keyboard (arrow keys in the agent list).
- **Shapes as well as colors:** provider badges have shapes (●, ◆, ■, ▲).
- **Screen readers:** agent rows read as one sentence, and alerts are announced.
- **Motion:** reduced motion follows your system or a setting.

### Known limits

- Gemini CLI tool calls can't be approved from the office: its hooks can't approve
  ([docs/spikes/gemini-approvals.md](docs/spikes/gemini-approvals.md)).
- The 60 fps budget was checked in software rendering only; check `?stats=1` on your GPU
  ([docs/perf.md](docs/perf.md)).
- In Docker on Windows, the host paths don't exist in the Linux container; use `npm start` there.
