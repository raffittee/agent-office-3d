# Claude Code fixtures

Cut from **real** Claude Code files on 2026-10-24 (versions 2.1.300–2.1.309, Windows, VS Code extension) and
**redacted to structure**:

- Kept: record and block types, ids (`uuid`, `toolu_…`, `msg_…`), `sessionId`, timestamps, versions, tool names,
  models, stop reasons, permission decisions, background task ids, `<task-notification>` tags (task id, tool-use id,
  status).
- Replaced: every other string becomes `"<redacted:N>"` (N = original length). Tool inputs get synthetic values by
  key (`command: "npm test"`, `file_path: "C:\Users\dev\code\project\src\main.ts"`, …). Object keys that held content
  (file paths, question text) become `"<keyN>"`.
- Dropped: the bodies of `api-request*` records (only the key names are listed under `"<omitted>"`), and the
  `credential_org` attachment.

Each file is a **contiguous** slice, so record order is real. Two slices from the same session are joined where
noted.

| File | What it shows |
| --- | --- |
| `registry-busy.json`, `registry-idle.json` | `sessions/<pid>.json` (2.1.309 and 2.1.306), including the new fields (`procStart`, `pidDomain`, `peerFeatures`, `messagingSocketPath`, …) |
| `transcript-session-start.jsonl` | The first 45 records of a session: `queue-operation`, attachments (`session_context`, `credential_org` omitted, …), first prompt, tool calls and results, `stop_hook_summary` |
| `transcript-ask-user-question.jsonl` | `AskUserQuestion` tool use, the answer (`permissionDecision.source: user_temporary`) |
| `transcript-denied.jsonl` | A tool call rejected by a safety rule: `permissionDecision.decision: reject`, `toolDenialKind: permission-rule` |
| `transcript-background-shell.jsonl` | Background launch (`toolUseResult.backgroundTaskId`), then later the `<task-notification>` (`queue-operation` enqueue → `queued_command` attachment → remove). Two slices of one session. |
| `transcript-task-stop.jsonl` | Background launch, then `TaskStop` (`task_type: local_bash`). Two slices of one session. |
| `transcript-compact.jsonl` | `system` `compact_boundary` followed by the `isCompactSummary` user record, then the `/compact` command record (its `<command-name>` tags restored as structure in P1-09) |
| `subagent/<sessionId>.jsonl`, `subagent/<sessionId>/subagents/agent-*.jsonl` + `.meta.json` | A real background `Explore` subagent (2.1.310, captured in P1-09), laid out like a session folder. Parent side: the `Agent` call, `async_launched` with `agentId`, then the hand-back and the `<task-notification>` (queue → attachment → remove). Subagent side: its attachments, `api-request*` (omitted), `Glob`/`Read`, and the closing `SubagentHandback` call (`toolEndsTurn: true`). The meta gains `model` and `finished: true`. |

Missing on this machine (capture later): registry `waiting` and `shell` statuses.
