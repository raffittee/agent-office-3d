# Changes log (overnight Phase 0 run)

A running log of what was done while you were away, what was decided on your behalf, and what needs your eyes.
Newest task at the bottom. Branch: `phase-0` (pushed to `origin`; `main` is untouched).

## Start here

**Phase 0 is complete: all 8 tasks are ticked in TASKS.md, each with its own commit, all pushed.** I stopped
before Phase 1, as you asked, so you can review first.

**Your to-do list (about 15 minutes):**

1. **Check CI**: GitHub → Actions → the `phase-0` runs (Ubuntu + Windows). The repo is private and `gh` isn't
   installed, so I couldn't see the result. Locally, typecheck, test (14 tests) and build all pass.
2. **Review the plan changes** the spikes forced (under P0-04, P0-05 and P0-07 below). The big ones:
   - Gemini hooks cost ~0.4 s each on Windows, so there's a `light` hook profile;
   - a denied Gemini permission fires no hook, so we must read Gemini's chat files;
   - the protocol gains background-job events (ADR 0002, still "proposed").
3. **Merge `phase-0` into `main`** when you're happy, or tell me to.
4. **Before Phase 1 ends:** upgrade and sign in to Gemini CLI (`npm i -g @google/gemini-cli@latest`, then run
   `gemini` once). Your global install is 0.15.1, which has hooks off.
5. **Before Phase 3:** download Quaternius "Universal Base Characters [Standard]" from itch.io ($0). It needs a
   browser.
6. Optional: put your name in `LICENSE`'s copyright line.

**Exit criteria check:**

- ADRs written: ✅ 0001–0004 (0002 is "proposed" until P1-01 finalizes the types).
- Fixtures for Claude Code and Gemini CLI: ✅. Codex moved to P5-01 by your decision.
- Spike numbers recorded: ✅ `docs/spikes/`.
- No open decisions remain: ✅ D7–D14 in CLAUDE.md.

**Nothing irreversible was done:**

- No global installs; the Gemini 0.65 test ran from a scratch folder.
- Your `~/.gemini` and `~/.claude` were only read. I never opened `*.key` files, credentials, or the
  `credential_org` contents.
- No assets are committed.
- Nothing contacted Habblaud World.

## Decisions you made before signing off

| Open decision | Answer |
| --- | --- |
| Final name | **Agent Office** (env prefix `AGENT_OFFICE_` unchanged) |
| Default camera | **Orthographic isometric**, perspective as a setting (P0-06 confirms with numbers) |
| Character assets | **Quaternius CC0** (P0-07 verifies clips and licenses) |
| UI languages | **English only** for v1, all strings through `t()` |
| Packaging | **Single npm package**, folder rules enforced by `test/boundaries.test.ts` |
| Codex fixtures | **Deferred to P5-01** (Codex isn't installed on this machine) |

## Decisions I made on your behalf

- **Work on a branch.** All Phase 0 commits are on `phase-0`, pushed to `origin`. Merge it into `main` when you're
  happy (or tell me to).
- **Copyright line** in `LICENSE` reads "the Agent Office contributors". Change it to your name if you prefer.
- **README.** Your GitHub "Initial commit" README ("My virtual space for my agents") was replaced by a fuller stub.
  The old text is still in commit `8b74886`.
- **CI runs on every push** (not only `main`), on Ubuntu and Windows, Node 22.12, so the branch gets checked.

## Task log

### P0-01 Name & repo — done

- Added `LICENSE` (MIT), `NOTICE.md` (Habblaud's MIT notice, non-affiliation statement), `README.md`, `.gitignore`.
- `.claude/settings.local.json` (your local Claude permissions) is git-ignored.

### P0-02 Tooling scaffold — done

- `package.json`: `"type": "module"`, `engines.node >= 22.12`, **no runtime dependencies**, dev tools pinned exactly
  (TypeScript 7.0.2, Vite 8.3.5, Vitest 5.0.5, esbuild 0.28.2, tsx 4.23.15, `@types/node` 22.20.5 so typecheck
  catches APIs newer than our Node floor).
- `tsconfig.json` (client + shared, DOM) and `server/tsconfig.json` (Node side, no DOM).
- `npm run dev`: one server on `127.0.0.1:4848` with Vite in middleware mode (HMR). `npm run build`: Vite client +
  esbuild server bundle. `npm start` runs the bundle.
- Skeleton server: `/api/health` only (the rest is P1-05). Smoke-tested both dev and built servers; both bind to
  `127.0.0.1` only.
- `test/boundaries.test.ts` enforces CLAUDE.md's folder rules: no runtime deps, exact pins, server imports only
  `node:*`/relative, `shared/` and `client/src/core/` never import `three`, hook shims import only `node:*`.
- `.gitattributes` forces LF (shims and fixtures must be byte-identical across OSes).
- Checks: `npm run typecheck`, `npm test` (9 tests), `npm run build` all pass locally on Windows / Node 26.7.
- **Needs you:** the repo is private and `gh` isn't installed, so I couldn't read the CI result. Check the Actions
  tab for the `phase-0` run (Ubuntu + Windows).

### P0-03 Reference access — done

- `docs/reference.md`: Habblaud path and full commit hash, a porting checklist, and a table of **Habblaud World code
  that leaks into files we do port** (`client/src/world/sim/visitor.ts` is imported by `sim.ts`;
  `client/src/net/world*.ts`; World fields in `shared/types.ts`, `server/model/office.ts`, `server/http/app.ts`).
- CLAUDE.md's exclusion list now names those files explicitly.

### P0-04 Spike: Gemini CLI data — done, with plan changes

**How:** you have no Gemini login on this machine, and the global Gemini is 0.15.1 (hooks off by default). I ran
the **real, latest Gemini CLI 0.65.0** from a scratch install against a **local stub of the Gemini API**, using
`GOOGLE_GEMINI_BASE_URL` and an isolated `GEMINI_CLI_HOME`. Hook payloads and chat files are genuine CLI output;
only the model's replies are scripted. I drove headless mode, the interactive TUI (through a pseudo-terminal) and
ACP mode. Your real `~/.gemini` and your global install were **not touched**. Nothing was sent to Google.

**Results:** `docs/providers/gemini-cli.md` answers every question in the task. There are 10 sanitized fixtures in
`test/fixtures/gemini-cli/` and reusable probe tools in `docs/spikes/gemini-probe/`.

**The spike contradicted the plan in these places. I applied the edits to CLAUDE.md and TASKS.md; please review:**

1. **Matcher `.*` breaks session hooks.** `SessionStart`, `SessionEnd` and `PreCompress` compare the matcher by
   exact string, so `.*` never fires them. Use `"*"` everywhere.
2. **`PreCompress` fires before every model request**, so it can't mean "compacted". It's dropped from the mapping
   and won't be registered.
3. **A denied (or Esc-cancelled) permission fires no hook at all**: no `AfterTool`, no `AfterAgent`. Only the chat
   file records it (`status: "cancelled"`, `"Request cancelled."`). Tailing `transcript_path` is now **required**
   in P1-10, not optional.
4. **Model and tokens never appear in hooks.** They come from the chat file only.
5. **`process.ppid` is a PowerShell process, not Gemini.** Gemini runs every hook through a shell, so liveness by
   `ppid` would mark agents offline right away. The hook shim rule now resolves the agent PID through the shell
   wrapper.
6. **Hooks are slow on Windows:** ~0.4 s each (PowerShell startup), and Gemini waits for them. A scripted session
   went from ~6 s to ~19 s with all hooks on. P1-10 now has a `light` profile (no per-tool hooks; tool activity
   from the chat file), the default on Windows, and a `full` profile.
7. **Subagents exist** (`invoke_agent`), but their tool hooks carry the parent's `session_id`, so they're
   attributed by nesting. Each subagent also has its own chat file.
8. **`/clear` gives a new `session_id`** in the same process. Resume keeps the id.
9. **Tool names changed:** `search_file_content` → `grep_search`; `read_many_files`, `save_memory` and
   `write_todos` are gone; `invoke_agent`, background-shell tools and others are new.
10. **ACP mode (editor integrations) fires almost no hooks.**
11. Minimum supported Gemini version set to **0.65.0**.

The protocol didn't need to change. Denials map to `tool.end {ok:false}` + `turn.end`, and tokens map to `usage`.

**Needs you (before P1-10's exit check):** upgrade Gemini (`npm i -g @google/gemini-cli@latest`) and sign in once
(`gemini`), so a real session can be tested in Phase 1. The spike didn't need it.

### P0-05 Spike: Claude Code & Codex check — done

- Checked Habblaud's Claude Code notes (written for 2.1.293) against your real files (2.1.306 and 2.1.309, VS Code
  extension). The core still matches: the session registry, transcripts, background shells, compaction.
  `docs/providers/claude-code.md` lists what's new:
  - `procStart` in the registry → liveness can't be fooled by PID reuse;
  - **`<pid>.<hash>.key` files in `sessions/`**, never to be read;
  - transcripts now embed full **API request bodies** (`api-request*` records) and a **`credential_org`**
    attachment, both to be skipped;
  - a **`PowerShell`** tool on Windows;
  - permission accept/reject decisions recorded in the transcript;
  - VS Code writes `c:\` and the desktop app `C:\` for the same folder, so paths must match case-insensitively.
- 8 fixtures in `test/fixtures/claude-code/`, **redacted to structure**: ids, types, tool names and decisions are
  kept; all conversation text is `<redacted:N>`; tool inputs are synthetic; API request bodies and the
  `credential_org` attachment are dropped. A test enforces this.
- **Not captured:** a subagent transcript. None exists on this machine, and I didn't start a subagent or a
  separate `claude` run just to make one (that would use your quota, and needs your OK). It's now the first step
  of P1-09.
- Codex: deferred as you decided. `docs/providers/codex.md` says so, and P5-01 now starts with the capture. The
  Phase 0 exit criteria were edited to match.

### P0-06 Spike: 3D renderer — done

- Built a throwaway Three.js office: 15 rooms, 810 wall segments, 90 desks, 30 characters walking with Habblaud's
  A*, and name labels. A Playwright harness measured 17 configurations on **your Intel UHD Graphics at 1080p**,
  which is exactly the hardware class in our performance budget.
- **Result: the budget is achievable.** CPU ~1 ms per frame. The GPU is limited by pixel fill, not draw calls:
  11–14 ms per frame with antialiasing (MSAA ~5 ms of that) and shadows. So 60 fps holds, but there's **little room
  for post-effects** (bloom, ambient occlusion) on integrated GPUs. They become an optional "high" quality tier.
- **Camera:** orthographic isometric by default (as you chose), confirmed by the screenshots: far rooms stay
  readable. Perspective becomes an optional "follow agent" camera.
- **Cutaway:** walls facing the camera are **cut down to ~0.4 m** (better than hiding them, which loses room
  outlines, or fading them, which looks striped). See the screenshots in `docs/spikes/renderer/`.
- Implications recorded in **ADR 0003**: the default view frames 4–6 rooms (at a full 15-room view characters are
  ~10 px tall); at most 2 draw calls per character in Phase 3; blob shadows for characters; labels need
  decluttering (they collide at overview zoom).
- Note: headless Chrome caps animation at ~55 fps even on an empty page, so budgets are measured as GPU-synced
  frame cost instead.
- Added dev dependencies `three` 0.186.1, `@types/three` 0.186.0 and `playwright-core` 1.64.1 (pinned).

### P0-07 Spike: assets — done

- **Characters:** Quaternius, as you chose. The free **Universal Animation Library** (45 clips, CC0, confirmed in
  the bundled license file) covers idle, walk, run, sit and talk. It's **missing typing, waving, sleeping and a
  raised hand**. Plan: build those four as small procedural bone overrides on top of the sitting and idle clips (no
  new art needed); author real clips only if they look bad.
- **Furniture:** the **Kenney Furniture Kit** (CC0, 140 low-poly models). Untextured models with materials named
  "wood", "metal", "carpet"… are ideal for themes, which can recolor them by name. A few office kinds are missing
  (water cooler, whiteboard, cubicles, ping-pong); they start as simple procedural shapes.
- **Compression:** with meshopt, a character plus all 45 animations is **~0.3 MB** over the network, and the whole
  furniture kit **~0.2 MB**. Loading takes under 0.1 s.
- **Performance:** 30 animated characters run in ~13 ms per frame on your iGPU, which is within budget. 60 don't
  fit, because the cost is per character (bones, materials) rather than polygons. ADR 0004 sets a character budget
  for Phase 3: one material, no finger bones, a low-detail version for zoomed-out views.
- `ASSETS.md` started. **No asset files are committed yet.**
- **Needs you (before Phase 3):** download "Universal Base Characters [Standard]" from
  https://quaternius.itch.io/universal-base-characters (pick $0 or tip). itch.io requires a browser, so I couldn't
  fetch it.
- Not tested: KTX2 texture compression (needs KTX-Software's `toktx`, not installed; nothing textured yet). It
  moves to P3-01.

### P0-08 ADRs & open decisions — done

- `docs/adr/`:
  - 0001 stack;
  - 0002 event protocol (proposed);
  - 0003 renderer and camera;
  - 0004 assets;
  - plus an index.
- ADR 0002 proposes protocol additions from the spikes:
  - `job.start` / `job.end` (otherwise the "waiting on a background shell" state could never end);
  - `continues` on `session.start` (so `/clear` keeps the same character instead of one leaving and one arriving);
  - a short `tool.error` kind;
  - account ids as short hashes instead of folder paths.
- CLAUDE.md:
  - your answers and the spike results are recorded as decisions D7–D14;
  - the status line now says Phase 0 is done;
  - the command table separates what exists from what's planned.
- TASKS.md: P1-01 and P1-03 now include the ADR 0002 changes.

---

# Phase 1 run (2026-10-25)

Branch `phase-1`. One commit per task, each pushed. At the end of the phase there's a PR, merged once CI is green.

### P1-01 Protocol — done

- `shared/protocol.ts` is now the source of truth for the event and snapshot types. CLAUDE.md shows the final
  shape, and ADR 0002 is accepted.
- `shared/validate.ts` is a dependency-free validator. It accepts unknown fields, so newer emitters keep working,
  but returns only the known ones. `shared/agent-event.schema.json` is the schema for SDK authors. Tests keep the
  schema and the constants in sync.
- Renamed Habblaud's `shells` to `jobs` in `AgentInfo`.

### P1-02 Activity layer — done

- Ported Habblaud's activity text generator, translated to English. That's what turns "`npm test`" into the
  "Running tests" bubble. Secrets are masked before anything is shown.
- Tool tables per provider: Claude Code (Habblaud's list, plus the Windows `PowerShell` tool), Gemini CLI (from the
  tool names captured in P0-04), and a generic one for custom agents that guesses from tool names.
- PowerShell commands are now understood too (`Get-Content x`, Windows paths with `\`).
- All of Habblaud's secret-masking tests pass in English, and every tool seen in the real fixtures maps to the
  right kind of activity.

### P1-04 Rooms & names — done (ahead of P1-03)

- Done before P1-03 because the office model needs it.
- Rooms are keyed by project folder. On Windows the key ignores case and slash direction, so a session started
  from VS Code (`c:\…`) and one from the desktop app (`C:\…`) share a room. Folders with the same name get their
  parent folder added ("company/app" vs "other/app"). Rooms can be renamed, and the names persist.
- Agents get names from a new list of 120 international names. Each session keeps its name across restarts.
- Habblaud's "pick your character per project" editor isn't ported yet; it's in the backlog.

### P1-03 Office reducer — done

- The heart of the server: every event from any provider goes through one function that decides each agent's
  state (working, waiting, idle, waiting-for-shell, done, offline), its bubble text, the activity feed and the
  pop-up notices. It's Habblaud's model rewritten around our event protocol, keeping its rules: grace periods
  before agents leave, "Done in 30s" bubbles, "Needs you" bubbles, no duplicate alerts within 10 s, and no
  notifications while the server catches up at startup.
- New: `/clear` keeps the same character (the session links to the old one); denied permissions don't show
  "Done"; background shells keep the agent in "waiting for the shell" until the last one ends.
- 22 tests, one per state transition plus these flows.

### P1-05 HTTP + SSE — done

- The web server: `/api/snapshot`, `/api/agents/:id`, `/api/health`, and a live stream at `/api/stream` that pushes
  changes to the browser. It serves the built page with sensible caching.
- Security edge guard ported from Habblaud and tested:
  - requests addressed to a foreign host name are refused (DNS-rebinding protection);
  - state-changing requests must be JSON from a local origin (CSRF protection);
  - no cross-origin access to the API.
- `/api/health` deliberately doesn't expose file paths.
- Configuration from `AGENT_OFFICE_PORT`, `_HOST`, `_DATA_DIR`, `_DEMO` and `_ALLOWED_HOSTS`. Smoke-tested the
  built server.

### P1-06 Ingest endpoints — done

- `POST /api/events` lets custom agents report what they do. It only accepts `custom:…` providers, so a script
  can't create fake Claude or Gemini agents.
- `POST /api/hooks/<provider>` receives what the Gemini / Claude / Codex hook scripts send.
- Both are reachable only from this computer, only JSON, at most 256 KB, rate-limited, validated, and every piece of
  text is secret-masked before it's stored or shown.

### P1-07 Adapter framework & liveness — done

- A common frame every provider plugs into: it starts them in order (one broken provider doesn't break the
  others), collects their status for `/api/health`, and gives the UI each provider's badge color and capabilities.
- Every 2 seconds it checks whether each agent's process is still running, and marks agents whose terminal was
  closed as gone. Agents without a known process (custom agents) are considered gone after 2 minutes of silence.

### P1-08 Hook shim kit & installer — done

- `hooks/shim.mjs`: the small script each AI CLI runs on every event. It follows the safety rules: it never slows
  or breaks the agent (always exits cleanly, gives up after 1.5 s), only talks to this computer, and cuts long text
  before sending.
- `npm run hooks:install -- --provider gemini-cli` (plus `hooks:status`, `hooks:uninstall`) edits Gemini's
  settings safely: it backs the file up first, only touches Agent Office's own entries, and running it twice changes
  nothing. Its `light` profile (the default on Windows) skips the per-tool hooks that cost ~0.4 s each there.
- Two Windows findings while building this:
  - Finding the Gemini process behind PowerShell takes 1–3 s, not the 0.3 s I'd estimated. It still happens only
    once per session; docs are corrected.
  - `gemini --version` hangs when not run in a terminal, so the installer reads the version from Gemini's
    package files instead. It already warns that your 0.15.1 is too old.

### P1-09 Claude Code adapter — done

- Claude Code sessions now appear in the office by themselves, with no hooks to install. Every second the server
  reads Claude's own files:
  - the list of open sessions decides each agent's state (working, waiting for you, idle, waiting for a shell);
  - the conversation file supplies prompts, tools, tasks, tokens and the session title;
  - the `subagents/` folder supplies subagents.
- Checked live against this machine: this very session showed up as "working" in the right room, with its title, the
  command it was running, and a background job. Your other open session (3d-snake-game) showed up as idle.
- **Subagent transcripts are now verified against a real file.** To capture one, I ran one tiny read-only subagent
  (it listed the ADR files). Its sanitized transcript is in `test/fixtures/claude-code/subagent/`. Two things are
  new since Habblaud's notes:
  - the subagent's `.meta.json` gains `finished: true` when it's done (I use it as an end signal);
  - a subagent ends with a `SubagentHandback` tool call rather than a normal reply.
- Privacy rules applied:
  - the files holding full API requests and the `credential_org` record are skipped before they're even parsed;
  - file contents in Write/Edit tool calls never leave the adapter;
  - `.key` files are never opened.
- A reused process ID can't keep a dead session alive. On Windows the process start time is checked once per
  session (P0-05's `procStart`).
- New settings:
  - `AGENT_OFFICE_CLAUDE_DIRS` overrides which Claude folders are watched;
  - `AGENT_OFFICE_IN_DOCKER` turns off process checks.
- 66 new tests, ported from Habblaud's, plus replays of every real Claude fixture.
- Not ported yet: Habblaud's GitHub-event detection (PR/merge/CI celebrations) and the "already answered question"
  tweak. Both are cosmetic and are listed for Phase 6.

### P1-10 Gemini CLI adapter — done (one live check left for you)

- `hooks/gemini-cli.mjs` is the script Gemini runs on each event. It strips private content before anything leaves
  Gemini: file contents, command output and the model's replies stay behind. Only the tool name, its inputs
  (without file bodies), success or failure, the exit code and a background process ID are sent.
- The server combines Gemini's hooks with its chat file, which is needed for three things:
  - **denying or cancelling a permission fires no hook**; only the chat file shows it, so the agent stops waiting
    instead of being stuck;
  - model and token counts appear only there;
  - with the `light` profile (Windows default, since each hook costs ~0.4 s), tool activity is read from the chat
    file instead of from slow per-tool hooks.
- Subagents are matched exactly. Gemini's `invoke_agent` call names the subagent's own chat file, so there's no
  guessing.
- Background commands become jobs. Gemini says nothing when they end, so the server checks whether their process
  still exists.
- `/clear` keeps the same character (the old session ends, and the new one starts in the same process).
- Safety: the server only reads files that look like Gemini chat files (`.gemini/tmp/<project>/chats/…`). Another
  program on your computer can't make it read anything else.
- Tested by replaying all 7 real Gemini captures from Phase 0 through the actual hook script, the server and the
  office: allow, deny, Esc-cancel, `/clear`, resume, failures, subagent, background job and editor (ACP) mode. Also
  checked live: the hook script, run as a real process, posted to a running server, and the agent showed
  "waiting: Confirm Write: allowed.txt".
- **Needs you (for the Phase 1 exit check):** a real Gemini session.
  1. `npm i -g @google/gemini-cli@latest` (you have 0.15.1; hooks need ≥ 0.65).
  2. Sign in by running `gemini` once.
  3. `npm run hooks:install -- --provider gemini-cli`.
  4. Start `npm run dev` and use Gemini in any folder.
  I didn't touch your `~/.gemini` settings.
