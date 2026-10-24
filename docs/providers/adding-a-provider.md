# Adding a provider

A provider is a coding CLI the office understands natively, the way it understands Claude Code, Gemini CLI and Codex.
If you only want **your own agent** in the office, you don't need any of this: use the SDK ([`sdk/`](../../sdk/README.md))
and it appears as `custom:<name>`.

Vendor-specific code lives in exactly three places: `server/adapters/<id>/`, `hooks/<id>.mjs` and
`shared/tools/<id>.ts`. Everything else reads `provider` only to pick a badge and capabilities. The Codex adapter
(P5-01) is the most complete example. Gemini CLI shows a hooks-first design.

## Checklist

### 1. Look before you write (never guess a format)

- [ ] Install the real CLI. If you can't use an account, drive it offline against a stub model. Gemini CLI and
      Codex both accept a custom endpoint: see `docs/spikes/gemini-probe/` and `docs/spikes/codex-probe/`.
- [ ] Run a session that covers: a prompt, a read, an edit, a shell command, a failing command, a background command,
      a subagent, a permission prompt (allow and deny), a cleared or resumed session, and exit.
- [ ] Find where it records state: session files, transcripts, lock files, a database, hooks and their payloads.
      Note what each event carries: session id, turn id, tool call id, cwd, pid, model, tokens, plan limits.
- [ ] Capture **sanitized** samples into `test/fixtures/<id>/`: replace home paths (`/home/dev/...`), remove system
      prompts and anything personal, and keep them small. Note how they were captured.
- [ ] Write `docs/providers/<id>.md`: version, file layout, formats, hook events and fields, the mapping to
      `AgentEvent`, privacy, and what isn't verified yet. Summarize it under CLAUDE.md › Provider notes.
- [ ] Add the id: `BuiltinProviderId` in `shared/protocol.ts` (additive) and the JSON Schema in
      `shared/agent-event.schema.json`.

### 2. The tool table — `shared/tools/<id>.ts`

- [ ] `describe<Id>Tool(name, input) → ActivityDescription` for every tool the CLI offers, under **every name** it
      appears with: transcripts and hooks often disagree (Codex: `exec_command` vs `Bash`, namespaced
      `multi_agent_v1wait_agent`).
- [ ] Reuse `describeCommand` for shells (it recognizes tests, git, installs, builds…), and `make(kind, icon, text,
      detail)` for the rest. Never put file contents in `detail`.
- [ ] Register it in `shared/tools/index.ts` (`describeToolFor`).
- [ ] Test it in `shared/tools/tools.test.ts` or next to the adapter.

### 3. The adapter — `server/adapters/<id>/`

- [ ] Implement `ProviderAdapter` (`server/adapters/adapter.ts`): `id`, `label`, `color` (the badge),
      `capabilities`, `start(ctx)`, `stop()`, `sources()`, `describeTool`, and as needed `onHook(payload)` and
      `alive(target)`.
- [ ] Keep parsers **pure** (a line or a payload in, items out) in their own module, and test them against the
      fixtures.
- [ ] In `start`, rebuild sessions that are already open between `ctx.beginBoot()` and `ctx.endBoot()`. Read only the
      end of long files (`FileTail.seekTail`).
- [ ] Emit `AgentEvent`s through `ctx.emit` (it validates and masks). Status follows the shared machine:
      `turn.start` → working, `waiting` → waiting, `turn.end` → idle, `job.*` → shell, `subagent.end` → done,
      `session.end` → offline.
- [ ] When two sources report the same thing (hooks and files), report it **once**: key turns, tools, subagents and
      jobs by the provider's own ids.
- [ ] `account` is a slug (`accountSlug(dir, defaultDir)`), never a path or an email.
- [ ] Register it in `server/index.ts`. If the demo simulates this provider, remove it from `DEMO_PROVIDERS` or keep
      it: `extraProviders` already skips running adapters.

### 4. Liveness

- [ ] Decide how a session is known to be alive, in this order of preference:
  1. a provider signal (Claude Code's session registry with `procStart`, Codex's lock files) → `alive()` returns
     true or false;
  2. the agent's PID (the hook shim sends it) → return `undefined` and the PID probe runs;
  3. nothing → a 2-minute heartbeat timeout.
- [ ] PIDs get reused: compare a process start time when the provider records one.
- [ ] In Docker (`AGENT_OFFICE_IN_DOCKER`), PIDs belong to the host: don't probe them.

### 5. Capabilities

- [ ] Set `capabilities` honestly: `transcript`, `approve`, `message` (Phase 7), `usage` (plan limits are known),
      `subagents`. The UI turns features on from them.

### 6. The hook shim — `hooks/<id>.mjs` (if the CLI has hooks)

Rules from CLAUDE.md › Hook shim rules:

- [ ] Plain Node ≥ 22, `node:*` imports only (plus `./shim.mjs`). Use `runShim` and `agentPid`.
- [ ] Never break or slow the agent: every error → exit 0, nothing on stdout. Posting takes at most 1.5 s.
- [ ] Observe-only events never write to stdout.
- [ ] Talk only to `127.0.0.1:<port>` (`~/.agent-office/hooks.json`, then `AGENT_OFFICE_PORT`).
- [ ] Cut content in the shim, before it leaves the agent's process tree: no file contents, no tool output (only an
      exit code or an id), no model replies. Strings ≤ 8 KB, bodies ≤ 200 KB.
- [ ] Resolve the agent's PID once, on session start (`agentPid` skips shell wrappers).
- [ ] Register as few events as possible. Run observe-only hooks asynchronously when the CLI allows it.
- [ ] On the server, validate the shim's body field by field (`hook.ts`). Accept only paths that look like the
      provider's own files, so a local process can't make the server read arbitrary files.

### 7. The installer

- [ ] Add a target to `scripts/hooks-install.ts` (`TARGETS`): the settings files (one per account), events, the
      handler per event, the matcher.
- [ ] Merge idempotently, back the file up first, never touch other tools' entries, and support `uninstall` and
      `status`. If the CLI trusts hooks by a hash of their command, keep the command free of options.
- [ ] Test it on a fake home in `server/test/hooks-install.test.ts`.

### 8. Accounts and usage (if the provider exposes them)

- [ ] Discover config folders by **layout only**: never open credentials (`.credentials*`, `auth.json`,
      `oauth_creds.json`, env files, `config.toml`).
- [ ] Plan limits, if any, go to the account's usage (P5-04).

### 9. Tests and docs

- [ ] Replay the fixtures through the shim's `buildBody`, the adapter and the `Office` reducer, and check the
      statuses (see `server/adapters/codex/codex.test.ts` and `gemini-cli/gemini.test.ts`).
- [ ] Check that content never leaks: the fixtures' file contents and replies must not appear in shim bodies or
      events.
- [ ] Run `npm run typecheck && npm test && npm run build`, and run the CLI live once against the dev server.
- [ ] Update CLAUDE.md (provider notes, commands, env vars), `TASKS.md` and `CHANGES.md`.
