# Security and threat model

Agent Office reads what your AI coding agents do and, if you turn it on, lets you act on their sessions. This page
covers:

- what it protects;
- who it protects against;
- the trust boundaries, and how each threat is handled;
- what the P8-01 review checked and changed;
- the risks that remain by design.

The rules themselves are in [CLAUDE.md › Security and privacy](../CLAUDE.md#security-and-privacy-non-negotiable). The
session-touching features are described in [interactive.md](interactive.md).

## What is worth protecting

| Asset | Where it is | Why it matters |
| --- | --- | --- |
| Credentials and tokens | `~/.claude*/.credentials*`, Codex `auth.json`, Gemini `oauth_creds.json`, env files, `<pid>.<hash>.key` files | Account takeover. **Never opened** by any code here. |
| Conversations and tool output | transcripts, rollouts, chat files | Code, secrets the agent read, private prompts. |
| Control of a session | the permission hook, the messages plugin, `codex queue` | Approving a command or sending a prompt is acting as you. |
| The agents' processes | the CLIs the hooks run in | A hook that hangs or prints the wrong thing breaks your agent. |
| The local machine | files the installers write | Settings files of Claude Code, Gemini CLI and Codex. |

## Actors

1. **You:** the browser on this computer.
2. **A web page you visit** in the same browser. It can make your browser send requests to `127.0.0.1`, through
   CSRF or DNS rebinding.
3. **Another device on your network.** It only matters if the server listens beyond loopback.
4. **Another local process or user.** Anything that can open a socket to `127.0.0.1:<port>`.
5. **The agents' own output.** Prompts, file contents and tool output are untrusted text that ends up on screen.
6. **Custom agents** posting to `/api/events`.

## Trust boundaries and mitigations

| Boundary | Threats | Mitigations | Tests |
| --- | --- | --- | --- |
| Browser → server | CSRF from another site; DNS rebinding; clickjacking; script injection from agent text | **Host:** must be loopback, an IP or an allow-listed name. **POST:** needs `Content-Type: application/json` and a same-origin or local `Origin`, and an `Origin: null` is refused. **No CORS.** **Headers:** `nosniff`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, and a strict CSP (P8-01): own scripts only, no inline scripts, `wasm-unsafe-eval` for the meshopt decoder. **Rendering:** agent text is always set with `textContent`, never parsed as HTML. | `server/http/http.test.ts`, `test/interactive-routes.test.ts` |
| Network → server | Someone on the LAN reads the office or acts on sessions | Binds `127.0.0.1` by default. **Interactive features** turn on only when asked (`AGENT_OFFICE_INTERACTIVE`) *and* the bind is loopback. Their routes also need a loopback `Host`, even when a LAN name is allow-listed for viewing. | `test/interactive-routes.test.ts` (45 cases) |
| Agent folders → server | Reading credentials; a huge or hostile transcript | Read-only access. Credential files are never opened. `api-request*` and `credential_org` records are dropped *before* parsing. Transcripts are read incrementally, and the conversation view reads only the last 4 MB. Parsers never throw. | `server/test/fuzz.test.ts`, adapter tests |
| Custom agents → `/api/events` | Impersonating a built-in provider; malformed or huge events; prototype pollution | Only `custom:*` providers are accepted. A hand-written validator caps sizes and checks every field. Unknown fields are dropped. Text is masked and cut before it reaches the browser, logs or disk. Bodies are limited to 256 KB. | `shared/validate.test.ts`, `server/test/fuzz.test.ts` |
| Hook shims ↔ CLIs | A hook that breaks, slows or misleads the agent | Plain Node with `node:*` imports only. Every error means exit 0 with nothing on stdout. Posts time out after 1.5 s. Talks to `127.0.0.1` only. Strings are cut to 8 KB and bodies to 200 KB before leaving the process. Only the Claude permission hook ever prints, and only a decision you made. | `server/test/shim.test.ts`, `server/permissions/permissions.test.ts` |
| Installers → config files | Corrupting a CLI's settings; losing other hooks | Merges idempotently. Backs up first. Writes atomically and keeps the file's mode. Aborts if the file changed meanwhile. Never touches unknown shapes. Uninstall removes only our entries. | `server/test/hooks-install.test.ts` |
| Office → sessions (P7) | Approving or messaging as you | Off by default and local only (see above). The office never invents an "always allow" rule: it returns the *position* of a rule the CLI offered, and the hook applies the original. Messages are never echoed back or logged. `codex queue` runs without a shell, with a deadline, and with the text passed as `--message=<text>`, so it can't become an option. | `test/interactive-routes.test.ts`, `server/messages/messages.test.ts`, plugin tests under `claude plugin test` |
| Server → outside | Telemetry; leaking data | No outbound calls. No telemetry. No update check yet. |  |

## P8-01 review: what changed

- **Content-Security-Policy on the pages**
  (`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`).
  It's a second line behind `textContent` rendering. Checked in Chromium on the built app: every theme, rigged
  models, seasonal decorations, no violations. Inline styles stay allowed: the overlay injects its stylesheet.
- **At most 64 open streams.** A runaway local script opening `/api/stream` in a loop gets `503` instead of
  exhausting the server.
- **Fuzzing** (`server/test/fuzz.test.ts`, seeded, no dependencies):
  - 6,000 random and mutated events through the validator, masking and the reducer;
  - 3,000 random hook bodies and decisions;
  - 4,000 hostile transcript lines through all three parsers.

  Result: nothing throws, accepted events keep the protocol's invariants, and `__proto__` payloads don't pollute
  prototypes.
- **Shim and installer review.** Nothing to fix. Checked:
  - stdin size caps (8 MB);
  - timeouts;
  - loopback-only targets;
  - exit 0 on every path;
  - only `node:*` imports (`test/boundaries.test.ts`);
  - backups, atomic writes and mode preservation.

## Risks that remain (by design)

- **Local processes are trusted.** Anything running as you, or as another user on a shared machine, can reach
  `127.0.0.1`. With the interactive features on, it can approve a pending request, send a message, poll a session's
  inbox, or read conversations. That's why those features are off by default; keep them off on shared machines.
- **Masking is best effort.** `maskSecrets` recognizes common token shapes, not every secret. Conversations can show
  anything the agent read.
- **"Always allow" writes to the CLI's settings**, exactly as choosing it in the terminal would.
- **Hooks run with your privileges.** They're short, dependency-free and readable on purpose. Read
  `hooks/*.mjs` before installing.

## Reporting a problem

Open an issue without exploit details and ask for a private channel. Please don't include transcripts or tokens.

## The desktop app

The Electron shell ([desktop.md](desktop.md), [ADR 0007](adr/0007-desktop-app.md)) adds one process and one trust
boundary, handled like this:

- The window loads only `http://127.0.0.1:<port>`. Other navigation is cancelled; `http(s)` links open in the user's
  browser; `file:`, `javascript:` and custom protocols never do. Pop-up windows are denied.
- The page runs with `contextIsolation`, `sandbox` and no `nodeIntegration`. The preload exposes nine functions, and
  the main process re-checks every message: the sender must be the app's own page, and each value is validated
  against a fixed list (modes, integration names, actions).
- Only the notifications permission is granted; camera, microphone, location and the rest are refused.
- The server is a child of the app bound to `127.0.0.1`, started with the same environment rules as `npm start`. An
  already-running server is adopted only if `/api/health` identifies it as Agent Office.
- The app logs its own lifecycle to `%APPDATA%\Agent Office\logs\desktop.log`: never conversation content.
- No network calls of its own, no telemetry, no auto-update. The installer is unsigned for now.

