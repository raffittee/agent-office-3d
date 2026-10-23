# Changes log (overnight Phase 0 run)

A running log of what was done while you were away, what was decided on your behalf, and what needs your eyes.
Newest task at the bottom. Branch: `phase-0` (pushed to `origin`; `main` is untouched).

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
