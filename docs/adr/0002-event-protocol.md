# ADR 0002: Provider-neutral event protocol

- **Status:** accepted (P1-01, 2026-10-25). The types live in `shared/protocol.ts`; changes are additive only.
- **Date:** 2026-10-24
- **Evidence:** [Gemini CLI notes](../providers/gemini-cli.md), [Claude Code notes](../providers/claude-code.md)

## Context

Agent Office must show Claude Code, Gemini CLI, Codex and custom agents in one office (D2). Their data sources
differ completely:

- Claude Code: registry files, transcripts and hooks;
- Gemini CLI: shell-wrapped hooks and chat JSONL;
- Codex: lock files, rollouts and hooks;
- custom agents: whatever they choose to post.

Everything after the adapters (reducer, snapshot, simulation, renderer) must not know which vendor it is looking at.

## Decision

Adapters normalize everything into **`AgentEvent` v1**, as sketched in CLAUDE.md › Core contracts, with these
changes from the Phase 0 spikes.

1. **Ids.** The main agent id is `${provider}:${account}:${session}`, and a subagent's is `${mainId}:${agent}`.
   `account` is a **short slug**: `default`, or the first 8 hex characters of SHA-256 of the config-dir path. Never
   the path itself.
2. **`pid` is the agent process**, not the hook's parent. Shims resolve it through shell wrappers (Gemini runs hooks
   via `pwsh`/`bash -c`). Claude Code adds `procStart`, so liveness can compare (pid, start time).
3. **Background jobs get their own events** (new): `job.start` and `job.end`, with
   `job: { id: string; label?: string; ok?: boolean }`. The status machine becomes: `turn.end` → `shell` while any
   job is open; `job.end` of the last job → `idle`. Sources:
   - Claude: `backgroundTaskId` → `<task-notification>`;
   - Gemini: `is_background` → PID from the result, ended by PID liveness;
   - Codex: per P5-01.
4. **Denials and cancels** map to `tool.end { ok: false }` followed by `turn.end` (Gemini has no hook for them; the
   adapter reads them from the chat file). `tool` gains an optional `error?: string` (a short error kind, never
   output).
5. **Session continuity** (new, optional): `session.start` may carry `continues?: string`, the session id it
   replaces in the same process (`/clear`). The office keeps the same character and desk.
6. **Usage:** `usage` events carry `model` and `tokens`. For Gemini they come from the chat file, never from hooks.
7. **Privacy at the edge:** shims strip tool output and file contents before posting (Gemini's `tool_response`,
   `Notification.details` bodies). The server masks and truncates everything again on ingest.
8. **`compact`** is emitted only from a real compaction record (Claude's `compact_boundary`). Gemini's
   `PreCompress` fires before every request, so it doesn't count.

The full types (`AgentEvent`, `OfficeSnapshot`, `AgentInfo`, `RoomInfo`, `FeedItem`, `Notice`, `AgentDetail`,
`AgentStatus`, `ActivityKind`, provider capabilities) are written in `shared/protocol.ts` in P1-01, with a JSON
Schema and a dependency-free validator.

## Consequences

- One reducer and one status machine serve every provider. Adding a provider means writing an adapter plus
  fixtures, never touching the simulation or the renderer.
- The protocol is slightly bigger than the CLAUDE.md sketch (`job.*`, `continues`, `tool.error`). The sketch is
  updated when P1-01 lands.
- Providers that can't observe some events (Gemini in ACP mode, Gemini denials) degrade to coarser statuses rather
  than wrong ones. Adapters fill gaps from transcripts where they can.
