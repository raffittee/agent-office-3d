# Agent Office — guide for AI agents

> **Status: Phases 0–4 done (pending on the user's machine: a live Gemini CLI check and the frame-rate checks); Phase 5 next.** The phased plan lives in [TASKS.md](TASKS.md).
> Provider facts: [docs/providers/](docs/providers/). Decisions: [docs/adr/](docs/adr/). Spike results:
> [docs/spikes/](docs/spikes/).

## What we're building

A 3D virtual office in the browser that shows what your AI coding agents are doing, live. Each project with an
open session becomes a room. Each agent (and subagent) is a character that:

- sits and types while it works;
- raises a hand when it needs you;
- wanders to the coffee machine when it's idle;
- walks its result over to its parent when it's a subagent that has finished;
- leaves, turning off the lights, when the session ends.

Three requirements make it different from the project it's modeled on:

1. **3D.** The office is a Three.js scene with a stylized low-poly diorama look, not 2D pixel art.
2. **Model-agnostic.** Claude Code, Gemini CLI, Codex and any custom agent all report through one
   provider-neutral event protocol. Vendor-specific code lives only in `server/adapters/<provider>/` and
   `hooks/`. Everything else reads `provider` only to pick badges and capabilities.
3. **Themeable.** Data-driven *theme packs* set the look: industrial loft, traditional office, startup, modern,
   or anything else. A theme changes how things look, never how the simulation behaves.

## Reference implementation: Habblaud

[Habblaud](https://github.com/marmottajr/habblaud) (MIT, © 2026 Márcio Junior) is a 2D pixel-art version of this
idea for Claude Code and Codex. Use it as the reference for behavior, data sources, protocol shape and security.

- **Location:** `C:\Users\Rafi\Documents\Code\habblaud`, pinned at v1.0.3 (commit `faa1a01`). If it's missing, clone
  it into `reference/habblaud/` (gitignored). It is read-only: never edit it.
- **Language:** its code comments and strings are in Portuguese. Ours are in English, so translate while porting.
- **Port, don't fork.** Copy the pure, provider-neutral pieces (table below) and re-shape them. Rebuild the provider
  layer around our event protocol and the client around Three.js. Habblaud's types assume Claude Code (a missing
  `provider` means Claude; statuses come from Claude's session registry). That assumption is exactly what we
  generalize.
- **Attribution:** every ported file starts with `// Ported from habblaud <path> (MIT, © 2026 Márcio Junior)`, and
  `NOTICE.md` carries Habblaud's MIT license text.
- **Never port or contact Habblaud World.** Skip `shared/world/`, `server/world/`, `client/src/world/city/`,
  `client/src/world/visit*`, `client/src/world/sim/visitor.ts`, `client/src/world/sim/world-visit.test.ts`,
  `client/src/net/world*`, `client/src/ui/world/`, `server/test/fake-world.ts` and `docs/world/`, and strip World
  references from files you do port (see [docs/reference.md](docs/reference.md)). Habblaud World is Habblaud's hosted
  multiplayer service, with its own terms of use. This project must not talk to `habblaud.com` servers or act as a
  Habblaud client.
- **Don't use Habblaud's brand.** That covers its name, logo, screenshots and the AI-generated images in
  `client/public/assets/`.

### What to study or port

| Concept | Habblaud source | Plan |
| --- | --- | --- |
| Snapshot protocol (agents, rooms, feed, notices) | `shared/types.ts` | Re-shape: `provider` required, English, capabilities |
| Tool call → activity (kind, icon, text); secret masking; shell parsing | `shared/activity.ts` | Port `maskSecrets`, `truncate`, `describeCommand`; one tool table per provider |
| Office model: status machine, grace periods, subagents, feed, notices | `server/model/office.ts` | Rewrite as a reducer over `AgentEvent`, keeping the rules |
| Rooms per project, stable slots, display names | `server/model/rooms.ts`, `room-aliases.ts` | Port |
| Persistent agent names | `server/model/names.ts`, `shared/names.ts` | Port with a new name list |
| Source abstraction | `server/sources/source.ts` | Model for `ProviderAdapter` |
| Incremental file tailing | `server/sources/tail.ts` | Port as is |
| Claude Code: session registry, transcripts, subagents, shells, GitHub events | `server/sources/{registry,watcher,transcript,subagents,shells,github}.ts` | Port into `adapters/claude-code/` |
| Codex: locks, rollouts, hook events | `server/sources/codex/*`, `mod/habblaud-codex/hook.mjs`, `scripts/codex-install.ts` | Port in Phase 5 |
| Hook shim safety rules | `mod/habblaud-codex/hook.mjs`, `scripts/permission-hook.mjs` | Copy the rules |
| HTTP edge guard (DNS rebinding, CSRF), SSE hub | `server/http/{guard,sse,app,static}.ts` | Port |
| Approve permissions, send messages | `server/permissions/*`, `server/messages/*`, `mod/` | Phase 7 |
| Demo simulator | `shared/demo/simulator.ts` | Port; mix providers |
| Building layout, rooms, spots | `client/src/world/layout/*` | Port to `client/src/core/layout/` (the 2D grid stays) |
| A* pathfinding | `client/src/world/path/*` | Port as is |
| Simulation and behaviors | `client/src/world/sim/{sim,behavior,character,spots,steps,shell,elevator}.ts` | Port; swap art-module calls for renderer-neutral data |
| Social life (hangouts, personalities) | `client/src/world/social/*` | Phase 6 |
| Day/night | `client/src/world/render/{daylight,lighting}.ts` | Reuse the time curves; the 3D lighting is new |
| Per-room variation | `client/src/art/theme.ts` (`roomTheme(seed)`) | Idea behind `roomVariants` |
| Seasonal overlays | `client/src/world/render/seasonal.ts` | Idea behind overlay packs |
| Furniture kinds, poses, held items | `client/src/art/api.ts` | Reuse the vocabulary as the theme ↔ sim contract |
| Character appearance from a seed | `shared/appearance.ts`, `client/src/art/character/appearance.ts` | Port the seed → parts logic |
| SSE client store, reconnect, mock mode | `client/src/net/store.ts` | Port |
| UI panels (sidebar, drawer, feed, top bar, settings) | `client/src/ui/*` | Reference for UX |

## Architecture

```
 Claude Code   files: sessions/<pid>.json, projects/**/*.jsonl ──┐
 Claude Code   hooks ──────────────────────────────────────────┐ │
 Gemini CLI    hooks (settings.json) ──────────────────────────┤ │  server/adapters/<provider>/
 Codex         hooks + rollout files ──────────────────────────┤ │  normalize everything into AgentEvent
 Custom agent  POST /api/events (sdk/) ────────────────────────┘ │
                                                                 ▼
                     Office reducer (shared/model) ── OfficeSnapshot ──▶ SSE /api/stream
                                                                               │
 browser: net/store ─▶ core/ (pure: layout, nav, sim, behaviors) ─▶ render3d/ (Three.js) + ui/ (DOM)
                                              ▲
                                   theme pack (themes/<id>/)
```

| Folder | Rule |
| --- | --- |
| `shared/` | Pure TypeScript used by server and client. No Node or DOM APIs. |
| `server/` | Node ≥ 22 with **zero runtime dependencies** (`node:http`, `node:fs`, SSE). Read-only on agent folders. |
| `server/adapters/<provider>/` | The only place that knows a vendor's file formats or hook payloads. It outputs `AgentEvent`s. |
| `hooks/` | Standalone, zero-dependency Node shims that each CLI runs. They forward to `POST /api/hooks/<provider>`. |
| `client/src/core/` | Pure simulation: layout, nav grid, sim, behaviors. **Must not import `three`.** Tested without a browser. |
| `client/src/render3d/` | Three.js only. Reads sim state every frame and never mutates it. |
| `client/src/themes/`, `themes/<id>/` | Theme loader, and the packs themselves (JSON + glTF + textures). |
| `client/src/ui/` | DOM panels: sidebar, details drawer, feed, settings. |
| `sdk/` | Small emitters (TypeScript, Python) that let custom agents report `AgentEvent`s. |

## Core contracts

Finalized in P1-01. **The source of truth is [`shared/protocol.ts`](shared/protocol.ts)** (validator:
`shared/validate.ts`; JSON Schema for SDK authors: `shared/agent-event.schema.json`). From now on, only make
additive changes.

### Ingest: `AgentEvent`

```ts
export type ProviderId = 'claude-code' | 'gemini-cli' | 'codex' | `custom:${string}`;

export interface AgentEvent {
  v: 1;
  provider: ProviderId;
  account: string;          // slug: 'default' or 8 hex chars of SHA-256 of the config dir. Never a path.
  session: string;          // main agent id = `${provider}:${account}:${session}`
  agent?: string;           // subagent id inside the session; absent = the main agent
  parentAgent?: string;
  cwd?: string;             // project directory → room
  at: number;               // epoch ms at the source
  pid?: number;             // the agent process (resolved through shell wrappers)
  procStart?: string;       // process start time, to detect PID reuse
  type:
    | 'session.start' | 'session.end' | 'turn.start' | 'turn.end' | 'tool.start' | 'tool.end' | 'waiting'
    | 'subagent.start' | 'subagent.end' | 'job.start' | 'job.end' | 'tasks' | 'usage' | 'compact' | 'heartbeat';
  tool?: { id?: string; name: string; input?: unknown; ok?: boolean; error?: string; background?: boolean };
  waiting?: { reason: 'permission' | 'question' | 'input'; text?: string };
  job?: { id: string; label?: string; command?: string; ok?: boolean };
  subagent?: { role?: string; title?: string; background?: boolean; ok?: boolean };
  continues?: string;       // session.start: the session this one replaces in the same process (/clear)
  prompt?: string;          // turn.start; masked and truncated before broadcast
  title?: string;
  model?: string;
  tokens?: { in?: number; out?: number; cached?: number };
  tasks?: { id: string; title: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }[];
  gitBranch?: string;
}
```

The status machine lives in the reducer and is the same for every provider:

| Event | Resulting status |
| --- | --- |
| `session.start` | `idle` |
| `turn.start`, `tool.*` | `working` |
| `waiting` | `waiting`, until the next `tool.*` or `turn.*` |
| `turn.end` | `idle`, or `shell` if background jobs are still running |
| `job.start` / `job.end` | open / close a background job; closing the last one turns `shell` into `idle` |
| `subagent.end` | `done`: the subagent walks to its parent, then leaves |
| `session.end`, or liveness lost | `offline`: removed after a grace period (repeated `session.end` is harmless) |

### Broadcast: `OfficeSnapshot`

Habblaud's `OfficeSnapshot`, `AgentInfo`, `RoomInfo`, `FeedItem` and `Notice`, re-shaped:

- `provider: ProviderId` is required on agents, accounts, sources and feed items.
- Habblaud's `shells` is `jobs` here (fed by `job.*` events).
- `AgentStatus` (`working | waiting | idle | shell | done | offline`) and the `ActivityKind` taxonomy stay as in
  Habblaud. The sim depends on them; providers don't.
- `meta.providers: { id, label, color, capabilities }[]` lets the UI turn features on per provider.

### `ProviderAdapter`

Source of truth: [`server/adapters/adapter.ts`](server/adapters/adapter.ts) (P1-07), with `AdapterSet` running
them all.

```ts
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string; // "Gemini CLI"
  readonly color: string; // badge color
  readonly capabilities: { transcript: boolean; approve: boolean; message: boolean; usage: boolean; subagents: boolean };
  /** ctx.emit validates and masks; ctx.beginBoot/endBoot bracket the rebuild of open sessions. */
  start(ctx: AdapterContext): void | Promise<void>;
  stop(): void;
  /** One entry per watched account or endpoint (meta.sources, /api/health). */
  sources(): SourceInfo[];
  /** Raw payload from hooks/<provider>.mjs → normalized events (routed by POST /api/hooks/:provider). */
  onHook?(payload: unknown): AgentEvent[];
  /** Native tool name + input → activity (kind, icon, text, detail); usually the table in shared/tools/. */
  describeTool(name: string, input: unknown): ActivityDescription;
  /** Is this agent's process alive? undefined = fall back to the PID probe, then a 2-minute heartbeat timeout. */
  alive?(target: LivenessTarget): boolean | undefined;
}
```

### Theme packs

Source of truth: [`shared/theme.ts`](shared/theme.ts) (P4-01; types, validator, and the generator of
`themes/theme.schema.json`). Authoring guide: [docs/themes.md](docs/themes.md). `themes/<id>/theme.json` looks like:

```jsonc
{
  "id": "industrial",
  "name": "Industrial Loft",
  "schema": 1,
  "layout": { "template": "loft", "wallHeight": 3.6, "roomSize": [16, 12] }, // corridor | open-plan | loft
  "palette": { "base": "#2b2b2b", "accent": "#d97a2b" },
  "materials": {
    "floor": { "preset": "concrete", "color": "#8a8a85", "roughness": 0.9 },
    "wall": { "preset": "brick" }
  },
  "lighting": { "ambient": "#3a3530", "sun": { "color": "#ffe2b8", "intensity": 1.2 }, "practicals": "edison-bulbs" },
  "kit": { "frame": "#2b2d30", "top": "#a77b4f" }, // part-role colors for the procedural kit
  "furniture": {
    "desk": { "procedural": "trestle" },
    "plant_tall": { "model": "models/cactus.glb", "scale": 1, "yaw": 0 },
    "sofa": { "colors": { "seat": "#7a4a2e" } }
  },
  "decor": [{ "kind": "pipes", "on": "everywhere", "density": 0.4 }, { "kind": "pendant_bulbs", "on": "rooms" }],
  "roomVariants": [{ "accent": "#c0392b" }, { "accent": "#2980b9" }],
  "postfx": { "bloom": 0.25, "ao": true }
}
```

- Furniture keys are **semantic kinds**, taken from Habblaud's `FurnitureKind` vocabulary: `desk`,
  `office_chair`, `coffee_machine`, `water_cooler`, `sofa`, `toilet_stall`, `reception_desk`, `whiteboard`,
  `light_switch`, `elevator` and so on.
- The sim places spots by kind; the theme decides only how each kind looks. A missing kind falls back to the
  procedural default.
- Themes never change paths, spots or behaviors. Layout templates differ in arrangement (walls and partitions), but
  each one must produce the same spots (`client/src/core/layout/templates.test.ts`). A live theme switch calls
  `Sim.restyle()`, which keeps every agent's desk and errand.
- `postfx` is validated but not drawn in v1 (performance budget).

## Provider notes

These facts were verified on 2026-10-24. Re-check them against the installed versions in Phase 0 and keep
`docs/providers/<id>.md` current. **Never guess a format.** Capture real, sanitized samples into
`test/fixtures/<provider>/`.

### Claude Code

Source: Habblaud, tested with Claude Code 2.1.293. **Re-checked against 2.1.306–2.1.309 in P0-05**; see
[docs/providers/claude-code.md](docs/providers/claude-code.md).

- **Open sessions and status:** `<config>/sessions/<pid>.json` (busy, idle, waiting or shell). Outside Docker,
  check that the PID is alive, and that it is still the same process: compare `procStart` (Windows FILETIME of
  the process start), which 2.1.30x writes. **Never open the `<pid>.<hash>.key` files** in the same folder.
- **Transcripts also contain** `api-request*` records (full API request bodies) and `credential_org` attachments.
  Skip both without parsing. On Windows, `PowerShell` is a tool like `Bash`, including background jobs. The
  encoded project folder keeps the `cwd`'s drive-letter case (`c--…` from VS Code, `C--…` from the desktop app), so
  match paths case-insensitively.
- **Transcripts:** `<config>/projects/<encoded-cwd>/<sessionId>.jsonl`. Subagents are in
  `<sessionId>/subagents/**/agent-*.jsonl`, with a `.meta.json` next to each.
- **Accounts:** `~/.claude*` folders that contain `projects/` or `sessions/`, plus `CLAUDE_CONFIG_DIR`. From
  `.claude.json`, read only the email and organization. Never read credentials.
- **Hooks:** the `PermissionRequest` hook (2.1.287+) can approve or deny from the office. Plugins can deliver
  messages into a session.

### Gemini CLI

Source: [geminicli.com/docs/hooks/reference](https://geminicli.com/docs/hooks/reference/), **verified against the
real CLI 0.65.0 in P0-04**. [docs/providers/gemini-cli.md](docs/providers/gemini-cli.md) is the reference; the
points below summarize it.

- **Supported version:** ≥ 0.65.0 (hooks on by default). 0.15.1, the version installed globally here, has hooks
  off unless `tools.enableHooks` and `tools.enableMessageBusIntegration` are set.
- **Where hooks go:** `settings.json`, either `~/.gemini/settings.json` (user) or `.gemini/settings.json`
  (project, ignored in untrusted folders), under
  `"hooks": { "<Event>": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"<path>\"", "timeout": <ms> }] }] }`.
  `GEMINI_CLI_HOME` relocates the whole `.gemini` folder, so it identifies the account.
- **Matcher:** always `"*"`. `SessionStart`, `SessionEnd` and `PreCompress` compare the matcher to the trigger
  **by exact string equality**, so `.*` never matches them.
- **Hooks run through a shell** (Windows: PowerShell; elsewhere: `bash -c`) and Gemini **waits for each one**. On
  Windows a hook costs ~0.4 s, and the shim's `ppid` is the shell, not Gemini.
- **Events and their fields:**
  - `SessionStart` (`source`: `startup`, `resume` or `clear`) and `SessionEnd` (`reason`)
  - `BeforeAgent` (`prompt`) and `AfterAgent` (`prompt_response`)
  - `BeforeTool` (`tool_name`, `tool_input`) and `AfterTool` (adds `tool_response`)
  - `Notification` (`notification_type`, e.g. `ToolPermission`; `message`; `details`)
  - `PreCompress` (`trigger`)
  - `BeforeModel`, `AfterModel` and `BeforeToolSelection`
- **Fields on every event (stdin):** `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp`. Tool
  events carry **no tool-call id**, so starts and ends are paired by name in order. Nothing in a hook payload names
  a subagent.
- **Mapping to `AgentEvent`:**

  | Gemini CLI event | `AgentEvent` |
  | --- | --- |
  | `SessionStart` | `session.start` (`/clear` = `SessionEnd(clear)` + `SessionStart(clear)` with a **new** id, same process) |
  | `BeforeAgent` | `turn.start` |
  | `BeforeTool` | `tool.start`; `invoke_agent` → `subagent.start` (fires *before* any permission prompt) |
  | `AfterTool` | `tool.end`; `invoke_agent` → `subagent.end` (shell failures have no `error`: parse `Exit Code: N`) |
  | `Notification` with `notification_type: ToolPermission` | `waiting` (permission) |
  | chat file: tool call `cancelled` + `info "Request cancelled."` | `tool.end {ok: false}` + `turn.end` (**the only signal after a deny**) |
  | `AfterAgent` | `turn.end` |
  | chat file: `gemini` message `model` / `tokens` | `usage` (hooks carry neither) |
  | `SessionEnd` | `session.end` (fires twice on `/quit`) |

- **Events we don't register:** `BeforeModel`, `AfterModel` and `BeforeToolSelection`, which fire on every request
  or chunk and can rewrite model traffic; and `PreCompress`, which fires before **every** model request, so it can't
  signal compaction.
- **ACP mode** (`gemini --acp`, used by editors) fires no `SessionStart`, tool or `Notification` hooks. Only the
  chat file shows its activity.
- **Output contract:** stdout must contain only JSON, and exit code 2 blocks the action. Our shim always prints
  nothing (or `{}`) and exits 0.
- **Approvals:** `Notification` is observe-only, so it can't approve from the office. Whether a `BeforeTool`
  decision could do it safely is a Phase 7 spike, off by default.
- **Session files:** `~/.gemini/tmp/<project-slug>/chats/session-<YYYY-MM-DDTHH-MM>-<id8>.jsonl`. The slug comes
  from `~/.gemini/projects.json`, keyed by the lower-cased project path. Subagents are in
  `chats/<parentSessionId>/<subagentSessionId>.jsonl`. The format is append-only JSONL: messages are re-appended
  under the same `id` when they change (last write wins), plus `$set`, `$rewindTo` and `$patch` lines. Tool calls
  are written when they finish. The `transcript_path` in hook payloads points at the live file, except on
  `SessionStart(resume)`.
- **Built-in tool names (0.65.0):** `read_file`, `list_directory`, `glob`, `grep_search`, `replace`, `write_file`,
  `run_shell_command` (with `is_background`), `list_background_processes`, `read_background_output`, `web_fetch`,
  `google_web_search`, `invoke_agent`, `activate_skill`, `enter_plan_mode`, `update_topic`, and `complete_task`
  inside subagents. `search_file_content` was renamed to `grep_search`; `read_many_files`, `save_memory` and
  `write_todos` are no longer declared.
- **Privacy:** payloads contain prompts, file contents (`write_file`, `Notification.details.newContent`) and tool
  output (`tool_response.llmContent`). The shim forwards only `tool_input` (truncated), `ok`, the error type, the
  exit code and a background PID, plus the permission `title` and `command`.

### Codex

Source: **verified against the real CLI, Codex 0.164.0, in P5-01**. [docs/providers/codex.md](docs/providers/codex.md)
is the reference; the points below summarize it.

- **Open sessions:** `<CODEX_HOME>/thread-writer-locks/<threadId>.lock` (empty; check existence only, never `flock`).
  A main thread is alive while its lock exists.
- **Rollouts:** `sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl`, `history_mode: paginated`: turns from
  `task_started`/`task_complete` (`turn_id`), prompts from `item_completed` `UserMessage`, tools from `response_item`
  `function_call`/`custom_tool_call` (`call_id`), tokens and plan `rate_limits` from `token_count`. A subagent has its
  own rollout whose `session_meta.source.subagent.thread_spawn.parent_thread_id` names the parent.
- **Background commands:** `exec_command` output `Process running with session ID N`; the job ends when that
  `CommandExecution` item completes.
- **Hooks:** in `<CODEX_HOME>/hooks.json`: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`, `PermissionRequest`. A subagent's hooks carry the parent's
  `session_id` plus its `agent_id`; `tool_use_id` = the rollout's `call_id`; a shell call is `Bash` in hooks and
  `exec_command` in rollouts. The user trusts each hook in `/hooks` (a hash of the command, options and position), so
  the command has no flags and our groups go at the end.
- **Off limits:** never read `auth.json` or `config.toml`.
- **Messages:** sent with `codex queue` (Phase 7).

### Custom agents

Anything built on the Gemini API, OpenAI, Ollama, LangGraph and so on posts `AgentEvent`s to `POST /api/events`
through the small emitters in `sdk/`.

## Hook shim rules (all providers)

These rules come from Habblaud's `mod/habblaud-codex/hook.mjs`.

- Plain Node ≥ 22, `node:*` imports only, no dependencies. One file per provider in `hooks/`.
- Never break or slow the agent. Every error means exit 0 with nothing on stdout. Keep timeouts short: posting an
  event takes at most 1.5 s.
- Observe-only events never write to stdout, because some CLIs feed stdout to the model.
- Talk only to `127.0.0.1:<port>`. Read the port from `~/.agent-office/hooks.json`, then from `AGENT_OFFICE_PORT`.
- Truncate before sending: at most 8 KB per string and 200 KB per body. Drop content the office doesn't need
  (tool output, file contents) in the shim, before it leaves the agent's process tree.
- Send the agent's PID as `pid`. That is `process.ppid`, unless the parent is a shell wrapper (`pwsh`,
  `powershell`, `cmd`, `bash`, `sh`), in which case use the shell's parent. Gemini CLI runs every hook through a
  shell. Resolve it once, on session start: on Windows the lookup costs ~1 s (`wmic`) to 3 s (PowerShell CIM).
- Register as few events as possible. Each hook is a blocking process spawn (~0.4 s on Windows through PowerShell).
- Installers merge into the CLI's config idempotently, back the file up first, and offer `uninstall` and `status`.

## Security and privacy (non-negotiable)

- **Local bind.** Bind to `127.0.0.1` by default.
- **Edge guard on every request:**
  - `Host` must be localhost, an IP or an allow-listed name, which blocks DNS rebinding.
  - `POST` needs `Content-Type: application/json` and a same-origin or local `Origin`, which blocks CSRF.
  - No CORS, `nosniff` on responses, no framing.
- **Read-only access.** Agent folders are read-only. Never read credentials or tokens (`.credentials*`,
  `auth.json`, `oauth_creds.json`, env files).
- **Masking.** Mask secrets (`maskSecrets`) and truncate text before it reaches the browser, the logs or the disk.
- **Session-touching features.** Approving, messaging and the terminal view need a local bind and a local `Host`.
  They are off by default, and their risks are documented.
- **No telemetry.** The only outbound call allowed is an optional update check that can be turned off.
- **Logs** never contain conversation content.

## Conventions

- TypeScript strict, ESM, Node ≥ 22.12. Vite for the client, Vitest for tests, `playwright-core` for screenshots and
  smoke tests.
- **Pure first.** Anything with logic is pure and unit-tested with fixtures: the reducer, the adapters' parsers,
  `describeTool`, layout, nav, sim and theme validation. Three.js and DOM code stays thin.
- After Phase 1, protocol changes are additive only.
- Source strings are in English. Wrap UI text in `t()` so translation can come later.
- **Dependencies.** Pin exact versions on the client (`three`, `vite`, …). The server has no runtime dependencies.
- **Assets.** Only CC0 or similarly permissive licenses, and every asset is listed in `ASSETS.md` (source URL,
  author, license). Compress glTF (meshopt or Draco) and textures (KTX2). Keep each theme pack at 15 MB or less.
- **Performance budget.** 60 fps at 1080p on an integrated GPU with 30 agents and 15 rooms, under 300 draw calls.
  Pause rendering when the tab is hidden.
- **Configuration.** Environment variables use the prefix `AGENT_OFFICE_` (rename it in P0-01 if the final name
  changes):

  | Variable | Default | Notes |
  | --- | --- | --- |
  | `AGENT_OFFICE_PORT` | `4848` | Not 4747, so Habblaud can run alongside. |
  | `AGENT_OFFICE_HOST` | `127.0.0.1` | |
  | `AGENT_OFFICE_DATA_DIR` | `~/.agent-office` | |
  | `AGENT_OFFICE_DEMO` | off | `1` turns on simulated agents. |
  | `AGENT_OFFICE_CLAUDE_DIRS` | discovered | Comma-separated Claude config folders to watch, replacing discovery. |
  | `AGENT_OFFICE_CODEX_DIRS` | discovered | Comma-separated Codex homes to watch (else `CODEX_HOME` and `~/.codex*`). |
  | `AGENT_OFFICE_IN_DOCKER` | auto | `1` skips PID checks (the agents' PIDs belong to the host). |
  | `AGENT_OFFICE_THEME` | `modern` | Default theme pack id for browsers that haven't picked one. |

## Commands

Update this table as commands land. *(planned)* marks the ones that don't exist yet.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Server and Vite at http://127.0.0.1:4848 (`AGENT_OFFICE_PORT` overrides the port) |
| `npm test` · `npm run typecheck` · `npm run build` | Checks to run before a task is done |
| `npm start` | Runs the built server (`dist/server/index.js`) |
| `node spikes/renderer/measure.mjs` · `node spikes/assets/measure.mjs <dir>` | Re-run the Phase 0 measurements |
| `npm run demo` | Dev mode with simulated agents from several providers (`AGENT_OFFICE_DEMO=1` or `--demo` on any run) |
| `npm run hooks:install -- --provider gemini-cli` · `--provider codex` | Install a provider's hooks (Gemini: `--profile light` or `full`; also `hooks:status`, `hooks:uninstall`) |
| `npm run assets:fetch` · `npm run assets:build` | Download pinned asset sources into `assets-src/`, then build the committed GLBs and profiles |
| `npm run shot` | After `npm run build`: screenshot the demo office in Chrome (`--sessions 30`, `--out <dir>`); CI runs it |
| `npm run theme:check` · `npm run theme:new -- <id>` | Validate theme packs (`-- --write-schema` regenerates the schema) and scaffold a new one |
| `/preview.html?theme=<id>` | Every furniture kind of a theme side by side (hot-reloads under `npm run dev`) |
| `npm run shot -- --themes` · `-- --thumbs` | Screenshot every theme (CI) · rewrite the theme picker thumbnails |

## How to work in this repo

- `TASKS.md` is the plan and the source of truth. Work one phase at a time and one task at a time. When a task is
  done, tick its box and add a one-line note saying what changed and where. Don't start a phase before the previous
  phase's exit criteria are met, unless a task says it can run in parallel.
- Before porting from Habblaud, read the whole source file and its tests, and port the tests too.
- Before marking a task done, run `npm run typecheck && npm test`, and also `npm run build` once it exists.
- Record decisions as short ADRs in `docs/adr/NNNN-title.md` (context, decision, consequences), and update the
  list below.
- A spike produces a note in `docs/` with measurements, not production code.

## Decisions

**Made during planning (2026-10-24):**

- **D1:** New repository that ports selected Habblaud modules with attribution. Not a fork.
- **D2:** One provider-neutral `AgentEvent` protocol. Vendor-specific code lives only in adapters and hook shims.
- **D3:** Three.js (WebGL2), a vanilla TypeScript UI, and Vite. Stylized low-poly look.
- **D4:** The simulation stays on a 2D tile grid (ported from Habblaud's layout, A* and sim). 3D is presentation
  only.
- **D5:** Themes are data: theme packs map semantic furniture kinds to visuals. Built-in themes: modern,
  industrial, traditional, startup.
- **D6:** Version 1 supports Claude Code and Gemini CLI. Codex and the generic SDK follow in Phase 5.

**Settled in Phase 0 (2026-10-24; the user answered the open questions, the spikes supplied the evidence):**

- **D7:** The final name is **Agent Office**. The env prefix stays `AGENT_OFFICE_`.
- **D8:** The default camera is **orthographic isometric**, with perspective only as an optional follow-cam. The
  cutaway cuts camera-facing walls to ~0.4 m. See [ADR 0003](docs/adr/0003-renderer-and-camera.md).
- **D9:** Characters come from **Quaternius** (Universal Base Characters + Universal Animation Library, CC0).
  Furniture comes from the **Kenney Furniture Kit** (CC0), with a meshopt pipeline. See
  [ADR 0004](docs/adr/0004-assets.md).
- **D10:** The UI ships in **English only** for v1. Every string still goes through `t()`.
- **D11:** **One npm package**, no workspaces. Folder rules are enforced by tsconfigs and
  `test/boundaries.test.ts`. See [ADR 0001](docs/adr/0001-stack.md).
- **D12:** Codex verification and fixtures move to P5-01, because Codex isn't installed on the development machine.
  Done in P5-01 with Codex 0.164.0 from npm, driven offline against a stub model.
- **D13:** The event protocol gains `job.start`/`job.end`, `session.start.continues`, `tool.error` and slugged
  account ids. See [ADR 0002](docs/adr/0002-event-protocol.md) (accepted in P1-01).
- **D14:** Gemini CLI ≥ 0.65.0 is supported, with `light` (default on Windows) and `full` hook profiles. Tailing the
  chat file is mandatory. See [docs/providers/gemini-cli.md](docs/providers/gemini-cli.md).

**Settled in Phase 3 (2026-10-25):**

- **D15:** Until the ADR 0004 human pack can be built, the default character is Quaternius's RobotExpressive (CC0),
  driven by a model-agnostic rig profile. See [ADR 0005](docs/adr/0005-interim-character.md).

ADRs are listed in [docs/adr/README.md](docs/adr/README.md).
