# Claude Code: provider notes

Verified 2026-10-24 (P0-05) on Windows 11 against the files of **Claude Code 2.1.306 and 2.1.309** (VS Code extension),
with transcripts written by 2.1.299–2.1.309. Habblaud's notes and parser target **2.1.293**, and its test fixtures
are synthetic. These are the first checks against real files. Evidence: [`test/fixtures/claude-code/`](../../test/fixtures/claude-code/).

## What still matches Habblaud

- **Open sessions:** `<config>/sessions/<pid>.json` exists while the process lives and is deleted when it exits
  (observed). Required fields `pid`, `sessionId` and `cwd`, plus `startedAt`, `version`, `kind` (`interactive`),
  `entrypoint` (`claude-vscode`), `name`, `status`, `updatedAt` and `statusUpdatedAt`, are all present, so Habblaud's
  `parseRegistryEntry` works unchanged.
- **Status values:** `busy` and `idle` observed. `waiting` (with `waitingFor`) and `shell` weren't observed on this
  machine; they stay as Habblaud documents them.
- **Transcripts:** `<config>/projects/<encoded-cwd>/<sessionId>.jsonl`, append-only JSONL with `user`, `assistant`,
  `system`, `attachment`, `queue-operation`, `custom-title`, `ai-title`, `agent-name`, `last-prompt` and `cost-state`
  records. Tool calls are `assistant` `tool_use` blocks; results are `user` `tool_result` blocks plus `toolUseResult`.
- **Background shells:** `toolUseResult.backgroundTaskId` on launch. The end arrives as a `<task-notification>` in a
  `queue-operation` (`enqueue`, then `remove`) and an `attachment` of type `queued_command`, or as a user message.
  `TaskStop` takes `task_id` and reports `task_type: "local_bash"`.
- **Compaction:** `system` `compact_boundary` (with `compactMetadata.trigger`), followed by a `user` record with
  `isCompactSummary: true`.

## What's new since 2.1.293

| Change | Impact |
| --- | --- |
| Registry: `procStart` (process start as a Windows FILETIME string, matching `Get-Process`'s `StartTime`) | **Use (pid, procStart) for liveness.** That's immune to PID reuse, which `process.kill(pid, 0)` alone isn't. |
| Registry: `pidDomain` (`win32:<user>`), `peerProtocol`, `peerFeatures` (`notify_idle`, `artifact_yield`), `messagingSocketPath` (named pipe `\\.\pipe\LOCAL\cc-msg-…`), `nameSource`, `nameSince` | Parse and ignore for now. `messagingSocketPath` is a candidate channel for Phase 7 messaging; investigate before using it. |
| `sessions/` also holds **`<pid>.<hash>.key` files** | **Never read them.** They're likely secrets. The registry reader must only open `*.json`, as Habblaud's already does. |
| New record types: `api-request`, `api-request-blob`, `api-request-shape` | Full API request bodies inside the transcript. They're large and sensitive. **Skip without parsing**, and never forward them. |
| New record types: `atis-latch`, `mode`, `file-history-delta`, `file-history-snapshot` | Ignore. `mode` seems to replace Habblaud's `permission-mode` (to confirm when porting). |
| `attachment` type **`credential_org`** | Never read or forward. The fixtures omit its body. |
| `user` records carry `permissionDecision` `{decision: accept\|reject, source: config\|user_temporary, reasonType?, grantScope?, reasonCode?, circuitBreaker?}` and `toolDenialKind` (`permission-rule`) | Shows denials and approvals after the fact. Useful for the feed and for leaving `waiting`. |
| **`PowerShell` tool** on Windows (`toolUseResult`: `stdout`, `stderr`, `interrupted`, `backgroundTaskId`) | Map it like `Bash` in the tool table (P1-02), including background jobs. |
| `toolUseResult` for Bash adds `persistedOutputPath` / `persistedOutputSize`; large outputs move to `<sessionId>/tool-results/*.txt` | Never read those files: they're conversation content. |
| `assistant` records add `requestedModel`, `effort`, `perTurnEffort`, `thinkingDisplay`, … | `message.model` is still the model. |
| `<sessionId>/custom-title.json` next to the transcript | Optional title source. |

## Paths and casing (Windows)

- The encoded project folder keeps the case of the `cwd` as the client wrote it. Sessions started from VS Code
  record `c:\Users\…` and get a folder `c--Users-…`; the desktop app writes `C:\…` and gets `C--Users-…`.
  **Normalize room keys case-insensitively on Windows**, and find transcript folders case-insensitively.
- Transcripts can be very large. One on this machine is **200 MB and 15,908 lines**. Keep Habblaud's boot rule: read
  the last ~1 MB first and the rest in the background.

## Accounts

`~/.claude` only, with `CLAUDE_CONFIG_DIR` unset, so the account is `default`. `~/.claude.json` exists. Per the
rules, only its email and organization may be read; the spike didn't need it.

## Subagents (verified in P1-09, 2.1.310)

- The files are where Habblaud says: `<sessionId>/subagents/agent-<agentId>.jsonl`, with
  `agent-<agentId>.meta.json` beside it.
- The meta also carries `model`, `isBuiltIn` and `requestNonInteractive`. Once the subagent hands its result back,
  it gains **`finished: true`**, which the adapter uses as an end signal.
- A subagent ends with a **`SubagentHandback`** tool call, and its result record has `toolEndsTurn: true`. There's
  no `end_turn` reply.
- Parent side: the `Agent` tool result has `status: async_launched`, `isAsync` and the `agentId`. Two messages
  arrive at the end: a peer `<agent-message>` and a `<task-notification>` whose `task-id` is the agent id. Each one
  arrives as a `queue-operation` enqueue, then a `queued_command` attachment, then a remove.
- Subagent transcripts also contain `api-request*` records and a `credential_org` attachment. These are skipped the
  same way as in main transcripts.

## Not verified here

- **`waiting` and `shell` registry statuses**: not observed (see above).
- **`PermissionRequest` hook** (2.1.287+): Phase 7.

## Fixtures

See [`test/fixtures/claude-code/README.md`](../../test/fixtures/claude-code/README.md).
