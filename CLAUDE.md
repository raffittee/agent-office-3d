# Agent Office — guide for AI agents

> **Status: planning, no code yet.** The phased plan lives in [TASKS.md](TASKS.md). Start at Phase 0.

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
  `client/src/world/visit*`, `client/src/ui/world/` and `docs/world/`. Habblaud World is Habblaud's hosted
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
                     Office reducer (server/model) ── OfficeSnapshot ──▶ SSE /api/stream
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

These are sketches. Finalize them in Phase 1; after that, only make additive changes.

### Ingest: `AgentEvent`

```ts
export type ProviderId = 'claude-code' | 'gemini-cli' | 'codex' | `custom:${string}`;

export interface AgentEvent {
  v: 1;
  provider: ProviderId;
  /** Account / config dir the session belongs to ('default' when the tool has only one). */
  account: string;
  /** Provider session id. Main agent id = `${provider}:${account}:${session}`. */
  session: string;
  /** Subagent id inside the session; absent = the main agent. */
  agent?: string;
  parentAgent?: string;
  /** Project directory → room. */
  cwd?: string;
  /** Epoch ms at the source. */
  at: number;
  /** PID of the agent process (hook shims send process.ppid), for liveness checks. */
  pid?: number;
  type:
    | 'session.start' | 'session.end'
    | 'turn.start' | 'turn.end'
    | 'tool.start' | 'tool.end'
    | 'waiting'
    | 'subagent.start' | 'subagent.end'
    | 'tasks' | 'usage' | 'compact' | 'heartbeat';
  tool?: { id?: string; name: string; input?: unknown; ok?: boolean; background?: boolean };
  waiting?: { reason: 'permission' | 'question' | 'input'; text?: string };
  /** turn.start: the user's prompt (masked and truncated before it is broadcast). */
  prompt?: string;
  model?: string;
  tokens?: { in?: number; out?: number; cached?: number };
  tasks?: { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }[];
}
```

The status machine lives in the reducer and is the same for every provider:

| Event | Resulting status |
| --- | --- |
| `session.start` | `idle` |
| `turn.start`, `tool.*` | `working` |
| `waiting` | `waiting`, until the next `tool.*` or `turn.*` |
| `turn.end` | `idle`, or `shell` if background jobs are still running |
| `subagent.end` | `done`: the subagent walks to its parent, then leaves |
| `session.end`, or liveness lost | `offline`: removed after a grace period |

### Broadcast: `OfficeSnapshot`

Habblaud's `OfficeSnapshot`, `AgentInfo`, `RoomInfo`, `FeedItem` and `Notice`, re-shaped:

- `provider: ProviderId` is required on agents and accounts.
- `AgentStatus` (`working | waiting | idle | shell | done | offline`) and the `ActivityKind` taxonomy stay as in
  Habblaud. The sim depends on them; providers don't.
- `meta.providers: { id, label, color, capabilities }[]` lets the UI turn features on per provider.

### `ProviderAdapter`

```ts
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string; // "Gemini CLI"
  readonly color: string; // badge color
  readonly capabilities: { transcript: boolean; approve: boolean; message: boolean; usage: boolean; subagents: boolean };
  start(emit: (e: AgentEvent) => void): void | Promise<void>;
  stop(): void;
  /** Raw payload from hooks/<provider>.mjs → normalized events. */
  onHook?(payload: unknown): AgentEvent[];
  /** Native tool name + input → activity (kind, icon, text, detail). */
  describeTool(name: string, input: unknown): ActivityDescription;
  /** Is this agent's process still alive? (pid, lock file or heartbeat; undefined = unknown) */
  alive?(agentId: string): boolean | undefined;
}
```

### Theme packs

`themes/<id>/theme.json` is validated against `themes/theme.schema.json`:

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
  "furniture": {
    "desk": { "model": "models/steel-desk.glb", "variants": ["a", "b"] },
    "office_chair": { "procedural": "stool", "params": { "metal": true } },
    "coffee_machine": { "model": "models/espresso.glb" }
  },
  "decor": [{ "kind": "pipes", "on": "ceiling", "density": 0.4 }, { "kind": "plant_tall", "on": "corners" }],
  "roomVariants": [{ "accent": "#c0392b" }, { "accent": "#2980b9" }],
  "postfx": { "bloom": 0.25, "ao": true }
}
```

- Furniture keys are **semantic kinds**, taken from Habblaud's `FurnitureKind` vocabulary: `desk`,
  `office_chair`, `coffee_machine`, `water_cooler`, `sofa`, `toilet_stall`, `reception_desk`, `whiteboard`,
  `light_switch`, `elevator` and so on.
- The sim places spots by kind; the theme decides only how each kind looks. A missing kind falls back to the
  procedural default.
- Themes never change paths, spots or behaviors. Layout templates differ in arrangement, but each one must produce
  the same spot kinds.

## Provider notes

These facts were verified on 2026-10-24. Re-check them against the installed versions in Phase 0 and keep
`docs/providers/<id>.md` current. **Never guess a format.** Capture real, sanitized samples into
`test/fixtures/<provider>/`.

### Claude Code

Source: Habblaud, tested with Claude Code 2.1.293.

- **Open sessions and status:** `<config>/sessions/<pid>.json` (busy, idle, waiting or shell). Outside Docker,
  check that the PID is alive.
- **Transcripts:** `<config>/projects/<encoded-cwd>/<sessionId>.jsonl`. Subagents are in
  `<sessionId>/subagents/**/agent-*.jsonl`, with a `.meta.json` next to each.
- **Accounts:** `~/.claude*` folders that contain `projects/` or `sessions/`, plus `CLAUDE_CONFIG_DIR`. From
  `.claude.json`, read only the email and organization. Never read credentials.
- **Hooks:** the `PermissionRequest` hook (2.1.287+) can approve or deny from the office. Plugins can deliver
  messages into a session.

### Gemini CLI

Source: [geminicli.com/docs/hooks/reference](https://geminicli.com/docs/hooks/reference/).

- **Where hooks go:** `settings.json`, either `~/.gemini/settings.json` (user) or `.gemini/settings.json`
  (project), under
  `"hooks": { "<Event>": [{ "matcher": "<regex>", "hooks": [{ "type": "command", "command": "…", "timeout": <ms> }] }] }`.
- **Events and their fields:**
  - `SessionStart` (`source`: `startup`, `resume` or `clear`) and `SessionEnd` (`reason`)
  - `BeforeAgent` (`prompt`) and `AfterAgent` (`prompt_response`)
  - `BeforeTool` (`tool_name`, `tool_input`) and `AfterTool` (adds `tool_response`)
  - `Notification` (`notification_type`, e.g. `ToolPermission`; `message`; `details`)
  - `PreCompress` (`trigger`)
  - `BeforeModel`, `AfterModel` and `BeforeToolSelection`
- **Fields on every event (stdin):** `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp`.
- **Mapping to `AgentEvent`:**

  | Gemini CLI event | `AgentEvent` |
  | --- | --- |
  | `SessionStart` | `session.start` |
  | `BeforeAgent` | `turn.start` |
  | `BeforeTool` | `tool.start` |
  | `AfterTool` | `tool.end` |
  | `Notification` with `notification_type: ToolPermission` | `waiting` (permission) |
  | `AfterAgent` | `turn.end` |
  | `PreCompress` | `compact` |
  | `SessionEnd` | `session.end` |

- **Events we don't register:** `BeforeModel`, `AfterModel` and `BeforeToolSelection`. They fire on every request
  or chunk, and they can rewrite model traffic.
- **Output contract:** stdout must contain only JSON, and exit code 2 blocks the action. Our shim always prints
  nothing (or `{}`) and exits 0.
- **Approvals:** `Notification` is observe-only, so it can't approve from the office. Whether a `BeforeTool`
  decision could do it safely is a Phase 7 spike, off by default.
- **Session files:** saved under `~/.gemini/tmp/<project_hash>/chats/`, with prompts, responses, tool calls and
  token usage. The file format is **not documented**, so inspect real files in Phase 0. The `transcript_path` in
  each hook payload points at the live file.
- **Built-in tool names to map** (verify against the installed version): `read_file`, `read_many_files`,
  `write_file`, `replace`, `run_shell_command`, `glob`, `search_file_content`, `list_directory`, `web_fetch`,
  `google_web_search`, `save_memory`, `write_todos`.

### Codex

Source: Habblaud.

- **Open sessions:** `<CODEX_HOME>/thread-writer-locks/<threadId>.lock`.
- **Rollouts:** `sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`.
- **Hooks:** in `<CODEX_HOME>/hooks.json`: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`, `PermissionRequest`. The user trusts each hook in
  `/hooks`. Trust is a hash of the command, so the command must carry no flags.
- **Off limits:** never read `auth.json` or `config.toml`.
- **Messages:** sent with `codex queue --thread=<id> --message=<text>`.

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
- Truncate before sending: at most 8 KB per string and 200 KB per body. Send `process.ppid` as `pid`.
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

## Commands

These are planned. Update this table as they land.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Server and Vite at http://127.0.0.1:4848 |
| `npm run demo` | Dev mode with simulated agents from several providers |
| `npm test` · `npm run typecheck` · `npm run build` | Checks to run before a task is done |
| `npm run hooks:install -- --provider gemini-cli` | Install a provider's hook shim (also `status`, `uninstall`) |
| `npm run theme:check` · `npm run theme:new -- <id>` | Validate theme packs and scaffold a new one |

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

**Open (resolve in P0-08 by asking the user):**

- the final project name;
- the default camera: orthographic isometric diorama or perspective;
- where the character assets come from;
- which UI languages to support;
- one package or npm workspaces.
