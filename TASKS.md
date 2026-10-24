# TASKS: Agent Office

The plan, phase by phase. [CLAUDE.md](CLAUDE.md) has the design, contracts and rules behind it.

## How to use this file

- Work the phases in order. Inside a phase, go top to bottom unless a task says it can run in parallel.
- Mark a finished task `[x]` and add a note: `— done: <what changed, where>`. Task IDs never change.
- **Size** is for one developer working with Claude: **S** is half a day or less, **M** is 1–2 days, **L** is 3–5
  days.
- **Ref** points at files in Habblaud (`C:\Users\Rafi\Documents\Code\habblaud`) to read before starting.
- **Done when** is the acceptance check. A task isn't done until `npm run typecheck && npm test` passes.

## Overview

| Phase | Goal | Exit criteria |
| --- | --- | --- |
| 0. Foundation & spikes | Repo, tooling, verified provider data, renderer and asset decisions | ADRs written, fixtures captured, open decisions closed |
| 1. Model-agnostic core | `AgentEvent` protocol, office reducer, server, Claude Code + Gemini CLI adapters | Real Claude and Gemini sessions appear live in a debug page |
| 2. 3D world MVP | Pure sim + Three.js scene with placeholder art and the main UI panels | The full agent lifecycle plays out in 3D at ≥ 50 fps |
| 3. Characters & art | Rigged characters, appearance, monitors, performance pass | ≥ 10 animated poses; performance budget met |
| 4. Theme system | Theme packs, layout templates, 4 built-in themes, authoring kit | Themes switch live; a new theme needs no code |
| 5. More providers | Codex, SDK for custom agents, usage, OTLP spike | Codex and a custom agent show up next to Claude and Gemini |
| 6. Life & atmosphere | Social life, day/night, effects, sounds, notifications | The office feels alive (subjective review) |
| 7. Interact | Approve, answer, message, read-only conversation view | Local-only actions work, with tests |
| 8. Release | Security, accessibility, docs, packaging | v0.1.0 tagged |

**Dependencies:**

- Phase 2 needs Phase 1.
- Phase 3 can start once P2-07 is done, and runs alongside Phase 4.
- Phase 5 can start once Phase 1 is done.
- Phases 6 and 7 need Phase 2.

---

## Phase 0: Foundation & spikes

- [x] **P0-01 Name & repo** (S) — done: name stays "Agent Office" (prefix `AGENT_OFFICE_` unchanged); repo was
  cloned from GitHub (`origin`), work on branch `phase-0`; added `LICENSE`, `NOTICE.md`, `README.md`, `.gitignore`.
  - Choose the final name with the user.
  - Run `git init`.
  - Add the MIT `LICENSE`, a `NOTICE.md` with Habblaud's MIT notice, a `README.md` stub, and a `.gitignore`
    (`node_modules/`, `dist/`, `reference/`, `.env`).
  - If the name changes, rename the `AGENT_OFFICE_` env prefix in `CLAUDE.md`.
  - **Done when:** the first commit exists.
- [x] **P0-02 Tooling scaffold** (M) — done: `package.json` (no runtime deps, exact pins), `tsconfig.json` +
  `server/tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `scripts/build-server.mjs`, skeleton `server/` and
  `client/`, `test/boundaries.test.ts`, `.github/workflows/ci.yml` (Ubuntu + Windows).
  - Write `package.json` (`"type": "module"`, `engines.node >= 22.12`, exact versions pinned).
  - Write `tsconfig.json` with separate server and client configs.
  - Add a Vite config (dev middleware or proxy to the server), a Vitest config, and the scripts `dev`, `test`,
    `typecheck` and `build`.
  - Add a CI workflow that runs typecheck, test and build.
  - **Ref:** `package.json`, `tsconfig.json`, `server/tsconfig.json`, `vite.config.ts`, `vitest.config.ts`,
    `.github/workflows/ci.yml`, `scripts/build-server.mjs`.
  - **Done when:** all three checks pass in CI on the empty skeleton.
- [x] **P0-03 Reference access** (S) — done: `docs/reference.md` records the local path and commit, a porting
  checklist, and the World code that leaks into ported files (`sim/visitor.ts`, `net/world*.ts`, `types.ts`, …).
  - Confirm Habblaud is at the path above. If it isn't, clone it read-only into `reference/habblaud` at commit
    `faa1a01` (v1.0.3).
  - Write down which path is in use in `docs/reference.md`.
- [x] **P0-04 Spike: Gemini CLI data** (M) — done: `docs/providers/gemini-cli.md` (real CLI 0.65.0 driven
  offline against a stub model: headless, TUI and ACP), 10 sanitized fixtures in `test/fixtures/gemini-cli/`, probe
  tools in `docs/spikes/gemini-probe/`; CLAUDE.md's Gemini notes and hook shim rules corrected (matcher `"*"`,
  no `PreCompress`, deny only visible in the chat file, `ppid` is a shell, ~0.4 s per hook on Windows).
  - Record the installed `gemini --version`.
  - Write a throwaway logging shim that appends each raw hook's stdin to a scratch file, and register it for every
    event except `BeforeModel`, `AfterModel` and `BeforeToolSelection`.
  - Run a session that reads, edits, runs a shell command, hits a permission prompt (allow once, deny once), uses
    `/clear`, resumes, and exits.
  - Answer these in `docs/providers/gemini-cli.md`:
    - the exact payload of each event, and the order the events arrive in;
    - which event ends a "waiting" state after an allow or a deny;
    - whether `session_id` stays stable across resume and `/clear`;
    - whether there are subagents, and how they appear;
    - the format of the `chats/` files and of `transcript_path` (JSON or JSONL; where tokens and the model live);
    - the real built-in tool names;
    - whether hooks need an enable flag.
  - Commit sanitized fixtures to `test/fixtures/gemini-cli/`.
  - **Done when:** the mapping table in `CLAUDE.md` is confirmed or corrected.
- [x] **P0-05 Spike: Claude Code & Codex check** (S) — done: `docs/providers/claude-code.md` (2.1.306–2.1.309:
  registry `procStart`/`.key` files, `api-request*` records, `credential_org`, `PowerShell` tool, permission
  decisions, drive-letter case), 8 redacted fixtures in `test/fixtures/claude-code/`; `docs/providers/codex.md`
  records the deferral. No subagent transcript exists on this machine: captured in P1-09 instead.
  - Check Habblaud's notes (in `CLAUDE.md` › Provider notes) against the installed versions.
  - Capture sanitized fixtures:
    - Claude Code: a session registry JSON, transcript slices with tool calls, and a subagent with its `.meta.json`;
    - Codex: a lock file and a rollout slice. *(Moved to P5-01: Codex isn't installed here.)*
  - Write `docs/providers/claude-code.md` and `docs/providers/codex.md`.
  - **Ref:** `server/README.md`, `server/test/fixtures.ts`, `server/test/codex-fixtures.ts`.
- [x] **P0-06 Spike: 3D renderer** (M) — done: `spikes/renderer/` (page + Playwright harness) measured 17
  configurations on the Intel UHD iGPU at 1080p; `docs/spikes/renderer.md` (CPU ~1 ms, GPU fill-bound 11–14 ms,
  MSAA ~5 ms, 10–195 draw calls) and ADR 0003 (orthographic isometric, cutaway `cut`, ≤ 2 draw calls per
  character, quality tiers).
  - Build a throwaway Three.js page with:
    - 15 rooms of merged or instanced boxes;
    - walls you can cut away;
    - 30 capsule characters walking a grid with A* (copied from Habblaud);
    - name labels drawn with `CSS2DRenderer`.
  - Measure fps, draw calls and memory on this machine.
  - Compare an orthographic isometric camera with a perspective one.
  - Try three cutaway approaches: hide the walls facing the camera, cut walls to a fixed height, and fade them.
  - **Ref:** `client/src/world/path/*`, `client/src/world/camera.ts`.
  - **Done when:** `docs/spikes/renderer.md` holds the numbers, and an ADR records the camera and cutaway choice.
- [x] **P0-07 Spike: assets** (M) — done: Quaternius Universal Animation Library + Base Characters and the Kenney
  Furniture Kit (all CC0, licenses verified in the downloads); meshopt via gltf-transform 4.5.1 (character + 45
  clips 305 KB gzipped, furniture kit 193 KB); 30 animated characters ≈ 13 ms GPU, 60 over budget;
  `docs/spikes/assets.md`, ADR 0004, `ASSETS.md` started. Missing poses (type, wave, sleep, raise hand) become
  procedural pose layers. Base Characters need a manual itch.io download.
  - Pick a character source: a rigged glTF with idle, walk, run, sit, type, wave, talk, cheer and sleep, or clips
    that can be retargeted.
  - Pick furniture kits that cover the four themes.
  - Check each license (CC0 preferred) and start `ASSETS.md`.
  - Compress with `gltf-transform` and measure size and load time.
  - Phase 2 doesn't depend on this, because it uses procedural placeholders.
  - **Done when:** an ADR names the sources and the pipeline.
- [x] **P0-08 ADRs & open decisions** (S) — done: ADRs 0001 (stack), 0002 (event protocol, proposed), 0003
  (renderer and camera), 0004 (assets) plus `docs/adr/README.md`; the user's answers and the spike findings are
  recorded as D7–D14 in CLAUDE.md › Decisions; CLAUDE.md status and command table updated.
  - Write ADRs: 0001 stack, 0002 event protocol, 0003 renderer and camera, 0004 assets.
  - Ask the user to settle the open decisions listed in `CLAUDE.md`, then update its Decisions section.

**Exit:** the ADRs are merged; fixtures exist for Claude Code and Gemini CLI (Codex fixtures moved to P5-01 on
2026-10-24 because Codex isn't installed); the spike numbers are recorded; no open decisions remain.

---

## Phase 1: Model-agnostic core (server only, no 3D)

- [x] **P1-01 Protocol** (M) — done: `shared/protocol.ts` (AgentEvent with ADR 0002's job/continues/error,
  snapshot types with required `provider`), `shared/validate.ts` + `shared/agent-event.schema.json`, 10 tests;
  CLAUDE.md contract updated, ADR 0002 accepted.
  - In `shared/protocol.ts`, define: `AgentEvent`, `ProviderId`, capabilities, `OfficeSnapshot`, `AgentInfo`,
    `RoomInfo`, `FeedItem`, `Notice`, `AgentDetail`, `AgentStatus` and `ActivityKind`.
  - Add a JSON Schema and a hand-written validator for `AgentEvent` (no dependencies).
  - Include ADR 0002's changes: `job.start`/`job.end`, `session.start.continues`, `tool.error`, and slugged
    `account` ids. Then update the sketch in CLAUDE.md and mark ADR 0002 accepted.
  - **Ref:** `shared/types.ts`.
  - **Done when:** tests cover valid and invalid events.
- [x] **P1-02 Activity layer** (M) — done: `shared/activity.ts` (masking, truncate, shell parsing with a
  PowerShell mode, `describeCommand`, jobs, specials; English via `shared/i18n.ts`), tool tables in
  `shared/tools/` (claude-code incl. PowerShell, gemini-cli from P0-04, generic for custom agents); Habblaud's
  masking tests ported; every tool in both providers' fixtures maps to its expected kind.
  - In `shared/activity.ts`, port `maskSecrets`, `truncate`, `basename`, `shellWords`, `splitShell` and
    `describeCommand`.
  - Add one tool table per provider: `claude-code` from Habblaud's `describeTool`; `gemini-cli` from P0-04.
  - **Ref:** `shared/activity.ts`, `shared/activity.test.ts`.
  - **Done when:** the ported masking tests pass, and each provider's fixture tools map to the expected kinds.
- [ ] **P1-03 Office reducer** (L)
  - `server/model/office.ts`: `apply(event)` updates the agent and room records.
  - Implement the status machine from `CLAUDE.md`, including the offline and done grace periods, plus `shell`
    while `job.*` events leave a background job open (ADR 0002). Duplicate `session.end` events must be harmless.
  - Tie subagents to their parent.
  - Keep activity history: the last 8 in the snapshot, the last 200 in the detail.
  - Produce the feed and notices ("needs you", "finished").
  - Add `rev` and `commit()`.
  - **Ref:** `server/model/office.ts`, `server/model/model.test.ts`.
  - **Done when:** there's a test for every status transition.
- [x] **P1-04 Rooms & names** (M) — done (before P1-03, which needs it): `server/model/rooms.ts` (slots,
  display names, case-insensitive Windows keys), `room-aliases.ts`, `names.ts` (persisted per session),
  `shared/names.ts` (120 international names), `shared/hash.ts`, `server/log.ts`; ported tests.
  - Key rooms by normalized `cwd`, with stable slots and a cooldown before a slot is reused.
  - Disambiguate display names, and support room aliases.
  - Give agents names from an international list, persisted in the data dir.
  - **Ref:** `server/model/rooms.ts`, `room-aliases.ts`, `names.ts`, `shared/names.ts`.
- [ ] **P1-05 HTTP + SSE** (M)
  - A `node:http` app with the edge guard.
  - An SSE hub: a snapshot on connect, then `feed` and `notice` events, with a ping every 15 s.
  - Routes: `GET /api/snapshot`, `/api/agents/:id`, `/api/health`.
  - Static files with cache rules; configuration from env.
  - **Ref:** `server/http/{guard,sse,app,static}.ts`, `server/config.ts`, `server/index.ts`,
    `server/http/http.test.ts`.
  - **Done when:** the guard tests (Host, Origin, Content-Type) are ported and pass.
- [ ] **P1-06 Ingest endpoints** (M)
  - `POST /api/events` for custom agents and `POST /api/hooks/:provider` for the shims.
  - Both are local-only, JSON-only, capped at 256 KB per body, rate-limited per source, validated, and masked on
    entry.
  - **Done when:** tests reject a bad Host, a bad Origin, a bad schema and an oversized body.
- [ ] **P1-07 Adapter framework & liveness** (M)
  - Write the `ProviderAdapter` interface and an `AdapterSet` (start, stop, sources, health).
  - Liveness: check the PID with `process.kill(pid, 0)`, and fall back to a heartbeat timeout.
  - Wrap each adapter's boot in `beginBoot` / `endBoot` pairs.
  - **Ref:** `server/sources/source.ts`.
- [ ] **P1-08 Hook shim kit & installer** (M)
  - Shared shim logic in `hooks/`: read stdin with a timeout and a size cap, look up the config, truncate, POST with
    a timeout, and always exit 0.
  - Resolve the agent PID: `process.ppid`, or its parent when the parent is a shell wrapper (see CLAUDE.md › Hook
    shim rules). Only on session start; cache nothing on disk.
  - `scripts/hooks-install.ts` with `--provider` and `install` / `uninstall` / `status`: back up first, merge
    idempotently.
  - **Ref:** `mod/habblaud-codex/hook.mjs`, `scripts/hooks-install.ts`, `scripts/codex-install.ts`,
    `server/test/hooks-install.test.ts`, `server/test/codex-hook.test.ts`.
  - **Done when:** tests run the shim as a real process against a test server, and the installer against a fake
    HOME.
- [ ] **P1-09 Claude Code adapter** (L)
  - Port the session registry, watcher, tail, transcript parser, subagents and shells into
    `server/adapters/claude-code/`, emitting `AgentEvent`s.
  - Keep Habblaud's boot behavior: read the last ~1 MB of each transcript, then the rest in the background.
  - Apply P0-05: liveness by (pid, `procStart`); skip `api-request*` records and `credential_org`; map
    `PowerShell` like `Bash`; read `permissionDecision`; match `cwd` case-insensitively on Windows.
  - Before porting `subagents.ts`, capture a real subagent transcript and its `.meta.json` into
    `test/fixtures/claude-code/` (none existed in P0-05).
  - **Ref:** `server/sources/{registry,watcher,tail,transcript,subagents,shells}.ts` and their tests.
  - **Done when:** the fixture tests pass, and a real session appears.
- [ ] **P1-10 Gemini CLI adapter** (L)
  - Write `hooks/gemini-cli.mjs` and an installer that targets `~/.gemini/settings.json` (or
    `$GEMINI_CLI_HOME/.gemini/settings.json`), using matcher `"*"` for every event. The installer checks
    `gemini --version` ≥ 0.65.0 and warns otherwise.
  - Two hook profiles (`--profile`): `full` (`SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`,
    `Notification`, `BeforeTool`, `AfterTool`) and `light` (without the two tool events; tool activity comes from the
    chat file). Default `light` on Windows, `full` elsewhere. Never register `PreCompress`.
  - The shim strips `tool_response` down to `ok`, error type, exit code and background PID, and
    `Notification.details` down to `type`, `title`, `fileName` and `command`.
  - Implement the event mapping from `CLAUDE.md`, as corrected by P0-04.
  - **Tail `transcript_path` (required):** denials and cancels (the only signal after a deny), model and tokens, and
    subagent files.
  - Liveness comes from the `pid` (the agent, resolved by the shim through the shell wrapper).
  - **Done when:** P0-04's fixtures replay into the expected status sequence (including allow, deny, cancel,
    `/clear` and resume), and a real Gemini session appears.
- [ ] **P1-11 Demo simulator** (M)
  - Port `shared/demo/simulator.ts`, mixing providers (`claude-code`, `gemini-cli`, `codex`, `custom:demo`).
  - The same seed always produces the same office.
  - Turned on with `AGENT_OFFICE_DEMO=1` on the server, or `?mock=1` in the browser.
- [ ] **P1-12 Debug page** (S)
  - A temporary page listing rooms → agents, each with a provider badge, status and current activity, live over
    SSE.
  - It's deleted in P2-10.

**Exit:** a real Claude Code session and a real Gemini CLI session on this machine both show up in the debug page;
their status changes (working, waiting, idle, offline) appear within 2 s; the demo runs; all tests pass.

---

## Phase 2: 3D world MVP (placeholder art)

- [ ] **P2-01 Client shell & store** (M)
  - Port the SSE store: reconnect with backoff, plus a mock mode backed by the demo simulator.
  - Lay out the app: canvas plus panels.
  - **Ref:** `client/src/net/store.ts`, `client/src/app.ts`, `client/src/main.ts`.
- [ ] **P2-02 Layout core** (L)
  - `client/src/core/layout/`: a building with core areas (entrance/reception, kitchen, lounge, restrooms) plus one
    project room per slot.
  - Output: areas, walls with doorways, furniture placements by semantic kind, and spots (desk, stool, nook,
    coffee, water, sofa, toilet, …).
  - Pure code, with tests.
  - **Ref:** `client/src/world/layout/*`, `client/src/world/constants.ts`.
- [ ] **P2-03 Navigation** (S)
  - Port the grid and A*, with their tests.
  - **Ref:** `client/src/world/path/*`.
- [ ] **P2-04 Simulation core** (L)
  - Port the sim, behavior, character, spots, steps and elevator modules.
  - Reconcile incoming snapshots with the characters on screen.
  - Modes: work, wait, idle, shell, deliver, leave. Idle activities are picked by weight.
  - Run step queues, and the room lifecycle (build, lights on, lights off, dismantle, compaction).
  - Characters expose only neutral data (position, direction, pose, held item) instead of calling an art module.
  - **Ref:** `client/src/world/sim/*` and its tests.
  - **Done when:** the ported sim tests pass with no `three` import.
- [ ] **P2-05 Scene & camera** (M)
  - `render3d/scene.ts`: the renderer, color management, resizing, and a capped device pixel ratio.
  - A camera rig as decided in the ADR: follow an agent, frame the whole office, rotate, zoom, pan.
  - Input: drag, mouse wheel, keyboard.
  - Suspend rendering while the tab is hidden.
  - **Ref:** `client/src/world/camera.ts`, `client/src/world/input.ts`.
- [ ] **P2-06 Building meshes** (L)
  - Floors, walls with doorways, cutaway mode, doors.
  - Procedural placeholder furniture (beveled boxes) for each semantic kind, merged or instanced per room.
  - Room build and dismantle animations; lights on and off per room.
- [ ] **P2-07 Placeholder characters** (M)
  - Procedural "capsule people": body and head colored by the agent's seed, plus a provider badge.
  - Procedural animation for each pose (walk bob, sit, typing arms, raised hand).
  - Smooth path following and turning.
- [ ] **P2-08 Labels & bubbles** (M)
  - A DOM overlay with names, activity bubbles (icon and text), the "needs you" alert, and a shell timer.
  - Occlusion, culling and level of detail.
  - Options: names on or off; bubbles all, important only, or none.
  - **Ref:** `client/src/world/render/overlay.ts`, `client/src/world/api.ts` (`WorldOptions`).
- [ ] **P2-09 Selection & details drawer** (M)
  - Raycast picking and a hover tooltip.
  - A details drawer with the current activity, tasks, subagents, timeline, stats, model and provider.
  - **Ref:** `client/src/ui/drawer.ts`, `client/src/ui/hovertip.ts`.
- [ ] **P2-10 Panels** (M)
  - Sidebar: rooms → agents, search, provider filter.
  - Top bar counters, activity feed, toasts, a settings skeleton, keyboard shortcuts, help.
  - Delete the P1-12 debug page.
  - **Ref:** `client/src/ui/{sidebar,topbar,feed,toasts,settings,help}.ts`.
- [ ] **P2-11 Screenshot smoke test** (S)
  - A Playwright script that captures the demo scene and uploads it as a CI artifact.
  - **Ref:** `scripts/shot.mjs`.

**Exit:** demo mode plays the whole lifecycle in 3D at ≥ 50 fps with 30 agents: arrive, work, wait with a raised
hand, wander when idle, deliver as a subagent, leave, turn out the lights, dismantle the room. Real Claude and
Gemini sessions appear, and clicking an agent opens its drawer.

---

## Phase 3: Characters & art pipeline

- [ ] **P3-01 Asset pipeline** (M)
  - `scripts/assets/`: `gltf-transform` compression, KTX2 textures, and budget checks (triangles, texture sizes).
  - Check that every file is listed in `ASSETS.md`.
- [ ] **P3-02 Rigged characters** (L)
  - One shared rigged glTF, with a map from pose to animation clip (Quaternius, ADR 0004).
  - Procedural pose layers for the poses the free clips lack: type, wave, sleep, raise hand.
  - Character budget from ADR 0004: one material, no finger bones, a 25% LOD.
  - An `AnimationMixer` manager with crossfades, and sitting offsets for each seat type.
  - **Ref:** the `Pose` list in `client/src/art/api.ts`.
- [ ] **P3-03 Appearance** (M)
  - Seed → skin, hair, outfit and accessories, using material slots and swappable meshes.
  - Subagents wear a lanyard; the provider badge color matches the provider.
  - **Ref:** `shared/appearance.ts`, `client/src/art/character/appearance.ts`.
- [ ] **P3-04 Held items** (S)
  - Attach items to bone sockets: coffee, laptop, papers, phone, controller, paddle, popcorn.
- [ ] **P3-05 Live monitors** (M)
  - Desk screens show a screen mode (code, terminal, browser, docs, chat, alert) from small shared canvas
    textures, and go dark with the room.
  - **Ref:** `screenModeFor` in `client/src/world/sim/behavior.ts`, `client/src/art/dynamic.ts`.
- [ ] **P3-06 Performance pass** (M)
  - Instancing, static geometry merging, frustum culling, a texture atlas.
  - Skip animation updates for characters that are off-screen.
  - Record the results against the budget in `docs/perf.md`.

**Exit:** rigged characters with at least 10 poses, and the performance budget in `CLAUDE.md` is met.

---

## Phase 4: Theme system

- [ ] **P4-01 ThemePack schema** (M)
  - TypeScript types, `themes/theme.schema.json`, a validator, and `npm run theme:check` (also run in CI).
  - Define the list of required semantic kinds and their procedural defaults.
- [ ] **P4-02 Theme runtime** (L)
  - The loader: a glTF cache, material presets, and procedural kinds.
  - The lighting rig and post-processing come from the theme.
  - Switching themes live keeps the simulation state. `theme.json` hot-reloads in dev.
- [ ] **P4-03 Layout templates** (L)
  - `corridor`: rooms along a corridor, like Habblaud.
  - `open-plan`: zones marked by rugs and partitions.
  - `loft`: one tall hall with zones.
  - **Done when:** a test shows that every template produces all required spot kinds for 1 to 20 rooms.
- [ ] **P4-04 Theme: Modern (default)** (M)
  - A bright, clean office, the closest to Habblaud's look.
- [ ] **P4-05 Theme: Industrial loft** (M)
  - Exposed brick, concrete floor, steel beams, ducts, Edison bulbs, factory windows, metal-and-wood furniture,
    pallet tables.
- [ ] **P4-06 Theme: Traditional office** (M)
  - Carpet tiles, cubicles, a drop ceiling with fluorescent panels, wooden desks, filing cabinets, a water cooler,
    framed certificates.
- [ ] **P4-07 Theme: Startup** (M)
  - Open plan, standing desks, bean bags, ping-pong, neon signs, plant walls, whiteboard walls, a snack bar.
- [ ] **P4-08 Per-room variation** (S)
  - Pick room variants by seed from `roomVariants`, so neighboring rooms differ.
  - **Ref:** `client/src/art/theme.ts`.
- [ ] **P4-09 Theme picker** (S)
  - In settings: thumbnails of each theme. The choice is saved in `localStorage`; `AGENT_OFFICE_THEME` sets the
    server default.
- [ ] **P4-10 Authoring kit** (M)
  - `npm run theme:new -- <id>` scaffolds a pack.
  - `docs/themes.md`: a step-by-step guide.
  - An example custom theme, and a preview page that shows every kind side by side.
  - **Ref:** `client/art-preview.html`, `client/src/art/preview.ts`.

**Exit:** the four built-in themes switch live, and a fifth theme can be built by following `docs/themes.md`
without touching code.

---

## Phase 5: More providers & generic ingest

- [ ] **P5-01 Codex adapter** (L)
  - First, the check moved here from P0-05: install Codex, run a session, capture a sanitized lock file and rollout
    slice into `test/fixtures/codex/`, and rewrite `docs/providers/codex.md` from the real files.
  - Port the locks, rollouts, hook shim and installer into `server/adapters/codex/` and `hooks/codex.mjs`.
  - **Ref:** `server/sources/codex/*`, `mod/habblaud-codex/hook.mjs`, `scripts/codex-install.ts` and their tests.
- [ ] **P5-02 SDK emitters** (M)
  - `sdk/ts`, a zero-dependency `fetch` helper, and `sdk/python`, using only the standard library (`urllib`).
  - Helpers for session, turn, tool and waiting events, with an automatic heartbeat.
  - Examples: a minimal agent loop on the Gemini API, and one on an OpenAI-compatible or Ollama endpoint, both
    reporting events.
- [ ] **P5-03 "Add a provider" guide** (S)
  - A checklist in `docs/providers/adding-a-provider.md`: fixtures, tool table, liveness, capabilities, shim rules,
    tests.
- [ ] **P5-04 Accounts & usage** (M)
  - Detect accounts per provider, and show plan usage where the tool exposes it:
    - Claude: `rate_limits` from the statusline, or the mod;
    - Codex: `token_count.rate_limits`;
    - Gemini: only if P0-04 found a source.
  - **Ref:** `server/accounts/*`, `client/src/ui/usage.ts`.
- [ ] **P5-05 Spike: OTLP receiver** (M)
  - Accept OTLP/HTTP JSON logs at `/v1/logs` (local only) as another generic path.
  - Map the telemetry events from Claude Code, Gemini CLI and Codex to `AgentEvent`s.
  - Decide whether to keep it, and record the decision in an ADR.

**Exit:** Codex sessions and an SDK-reporting custom agent appear alongside Claude Code and Gemini CLI.

---

## Phase 6: Life & atmosphere

- [ ] **P6-01 Idle life & social** (L)
  - Port the hangouts (TV, games, ping-pong, kitchen chats), the personalities, and gatherings onto 3D spots.
  - **Ref:** `client/src/world/social/*`.
- [ ] **P6-02 Day/night** (M)
  - Sun, sky and exposure follow local time; light through the windows; practical lights at night.
  - A setting: automatic, always day, or always night.
  - **Ref:** `client/src/world/render/{daylight,lighting}.ts`.
- [ ] **P6-03 Shell-wait gags** (S)
  - Hourglass, popcorn, crossed arms, cobwebs, dozing off. Celebrate when the command succeeds; a rain cloud when
    it fails.
  - **Ref:** `client/src/world/sim/shell.ts`.
- [ ] **P6-04 Room effects** (M)
  - GitHub party and alarm events (PR merged, CI red), generalized into a provider-neutral `RoomEffect`.
  - **Ref:** `server/sources/github.ts`, `shared/github.ts`, `client/src/world/render/github-fx.ts`.
- [ ] **P6-05 Sounds** (M)
  - Synthesized WebAudio cues: keys, the elevator ding, a bell when someone needs you, a click for a finished task.
  - Per-category volumes; off by default.
  - **Ref:** `client/src/audio/*`, `client/src/ui/sound.ts`.
- [ ] **P6-06 Notifications** (S)
  - A browser notification and a toast when an agent needs you.
  - **Ref:** `client/src/ui/notify.ts`.
- [ ] **P6-07 Seasonal overlays** (S)
  - Halloween and holiday overlay packs that can be applied on top of any theme.
  - **Ref:** `client/src/world/render/seasonal.ts`.

---

## Phase 7: Interact from the office (local-only)

- [ ] **P7-01 Approve permissions: Claude Code** (L)
  - The `PermissionRequest` hook, a registry, long-polling, and request cards in the UI.
  - **Ref:** `server/permissions/*`, `mod/habblaud-permissoes/*`, `scripts/permission-hook.mjs`.
- [ ] **P7-02 Answer questions** (M)
  - Answer `AskUserQuestion` prompts through the same flow.
  - **Ref:** `shared/answers.ts`.
- [ ] **P7-03 Spike: Gemini approvals** (M)
  - Can a `BeforeTool` decision safely mirror the CLI's own confirmation?
  - Document the answer. Implement it only if it's safe, and only as an opt-in.
- [ ] **P7-04 Send messages** (M)
  - Claude through a plugin inbox, Codex through `codex queue`, and custom agents through an SDK inbox.
  - **Ref:** `server/messages/*`, `mod/habblaud-mensagens/*`.
- [ ] **P7-05 Read-only conversation view** (L)
  - Turn each provider's transcript into terminal entries: port the Claude and Codex parsers; build Gemini's from
    the `chats/` format.
  - Mask everything, and add a session history.
  - **Ref:** `server/sources/terminal.ts`, `server/http/terminal.ts`, `server/sources/history.ts`.
- [ ] **P7-06 Interactive route tests** (S)
  - Every action route requires a local bind, a local `Host`, JSON and a local `Origin`. Add negative tests for
    each.

---

## Phase 8: Hardening & release

- [ ] **P8-01 Security review** (M)
  - Write a threat model in `docs/security.md`, fuzz the event validator, and review the shims and installers.
- [ ] **P8-02 Soak & performance** (M)
  - Run the demo for 8 hours and check memory and the frame-time budget. Add a performance check to CI.
- [ ] **P8-03 Accessibility** (M)
  - Keyboard navigation for the panels, reduced motion, provider badges told apart by shape as well as color, and
    screen-reader text for the agent list.
- [ ] **P8-04 Docs** (M)
  - `README.md` (what and why, screenshots from demo mode), install and uninstall per provider, privacy,
    troubleshooting, `CONTRIBUTING.md`.
- [ ] **P8-05 Packaging & release** (M)
  - `npm start` serves the production build.
  - An optional Docker image with read-only mounts.
  - `CHANGELOG.md`; tag v0.1.0.
  - **Ref:** `Dockerfile`, `docker-compose.yml`, `scripts/docker-up.ts`, `scripts/release.ts`.

---

## Backlog (unscheduled)

- Day timelapse (**Ref:** `server/history/timeline.ts`, `shared/timeline.ts`, `client/src/ui/timelapse.ts`).
- "My day" stats (**Ref:** `shared/daystats.ts`, `server/history/daystats.ts`).
- Character editor (**Ref:** `client/src/ui/character-editor.ts`).
- Phone access with a login (**Ref:** `server/remote/*`).
- Multi-floor buildings, with elevators between floors.
- A WebXR / VR walk-through.
- AI theme generator: describe a space, any LLM drafts a `theme.json`, the schema validates it, and you preview it.
- More adapters: Aider, OpenCode, Cursor CLI, Copilot CLI.
- Translations (i18n).
