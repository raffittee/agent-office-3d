# Gemini CLI: provider notes

Verified 2026-10-24 (P0-04) on Windows 11 with PowerShell 7. Raw evidence: [`test/fixtures/gemini-cli/`](../../test/fixtures/gemini-cli/).
Re-run the probe ([`docs/spikes/gemini-probe/`](../spikes/gemini-probe/)) whenever the supported version changes.

## Versions

| | Version | Hooks |
| --- | --- | --- |
| Installed globally on this machine | `gemini --version` → **0.15.1** | Off by default. Needs `tools.enableHooks: true` and `tools.enableMessageBusIntegration: true`. |
| Tested (latest on npm) | **0.65.0** | **On by default** (`enableHooks ?? true`; `hooksConfig.{enabled,disabled,notifications}` in settings). |

**Recommendation:** support Gemini CLI **≥ 0.65.0** at first (the version these notes describe). The installer reads
`gemini --version` and warns on anything older. Upgrade the global install with `npm i -g @google/gemini-cli@latest`
(not done by the spike).

## How the evidence was captured

No Google account is configured on this machine, so the spike ran the **real CLI** against a **local stub of the
Gemini API** that returns scripted model turns (tool calls or text):

- `GEMINI_CLI_HOME=<scratch>` isolates the whole `~/.gemini` (settings, tmp, chats); the real `~/.gemini` was not touched.
- `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:<port>` plus `security.auth.selectedType: "gemini-api-key"` and a dummy
  `GEMINI_API_KEY` send every model call to the stub. (`GOOGLE_GEMINI_BASE_URL` alone selects the "gateway" auth
  type, which the CLI rejects.)
- A logging shim registered for every event except `BeforeModel`, `AfterModel` and `BeforeToolSelection` appended
  each raw stdin payload to a file.
- Three front ends were driven: headless (`-p`), the interactive TUI (through `node-pty`, which Gemini itself
  bundles), and ACP (`--acp`, JSON-RPC on stdio).

Everything in the hook payloads and chat files is produced by the CLI; only the model's words are scripted. The
model ids seen (`gemini-3.8-flash` for turns, `gemini-3.5-flash-lite` for routing) are the CLI's own defaults.

## Answers to the P0-04 questions

### Payloads

Every event carries `session_id`, `transcript_path`, `cwd`, `hook_event_name` and `timestamp` (ISO 8601, UTC).

| Event | Extra fields | Notes |
| --- | --- | --- |
| `SessionStart` | `source`: `startup` \| `resume` \| `clear` | On `resume`, `transcript_path` names a file that is **never created**; later events point to the real file. |
| `SessionEnd` | `reason`: `exit` \| `clear` \| … | `/quit` fires it **twice**. |
| `BeforeAgent` | `prompt` | The user's prompt. |
| `AfterAgent` | `prompt`, `prompt_response`, `stop_hook_active` | `prompt_response` is the model's final text. |
| `BeforeTool` | `tool_name`, `tool_input`, (`mcp_context`), (`original_request_name`) | **No tool-call id.** Fires **before** the permission prompt. |
| `AfterTool` | `tool_name`, `tool_input`, `tool_response` | `tool_response = { llmContent, returnDisplay, error? }`. Can be large (5+ KB) and holds file contents and command output. |
| `Notification` | `notification_type: "ToolPermission"`, `message`, `details` | No `tool_name`. `details.type`: `edit` (`title`, `fileName`, `filePath`, `fileDiff`, `originalContent`, `newContent`), `exec` (`title`, `command`, `rootCommand`), `mcp` (`serverName`, `toolName`, `toolDisplayName`) or `info` (`prompt`, `urls`). |
| `PreCompress` | `trigger`: `auto` \| `manual` | **Fires before every model request**, not only when history is compressed. |

Hook processes also get these environment variables: `GEMINI_SESSION_ID`, `GEMINI_CWD`, `GEMINI_PROJECT_DIR`,
`GEMINI_PLANS_DIR` and, "for compatibility", **`CLAUDE_PROJECT_DIR`**. Our Claude Code shim must not treat
`CLAUDE_PROJECT_DIR` as proof that it is running under Claude Code.

### Event order

Headless, one prompt with tools (`hooks-headless-work.jsonl`):

```
SessionStart(startup) → BeforeAgent → PreCompress
  → BeforeTool(read_file) → AfterTool(read_file) → PreCompress
  → BeforeTool(glob) → BeforeTool(grep_search) → AfterTool(glob) → AfterTool(grep_search) → PreCompress   (parallel calls)
  → BeforeTool(invoke_agent) → BeforeTool(list_directory) → AfterTool(list_directory) → … → AfterTool(invoke_agent)
→ AfterAgent → SessionEnd(exit)
```

Permission prompt, TUI (`hooks-tui-allow-deny.jsonl`, `hooks-tui-exec-allow.jsonl`):

```
allowed:  BeforeTool → Notification(ToolPermission) → [user allows] → AfterTool → … → AfterAgent
denied:   BeforeTool → Notification(ToolPermission) → [user denies] → (nothing) … next prompt's BeforeAgent
```

`/clear` (`hooks-tui-cancel-clear.jsonl`): `SessionEnd(clear)` with the **old** id, then `SessionStart(clear)` with a
**new** id, in the same process.

### What ends a "waiting" state

- **Allow:** the `AfterTool` of that tool.
- **Deny, or Esc while the prompt is open:** **no hook fires**. There is no `AfterTool` and no `AfterAgent`. The
  next hook is the next prompt's `BeforeAgent`, or `SessionEnd`. The chat file does record it: the tool call is
  rewritten with `status: "cancelled"`, followed by an `info` message `"Request cancelled."`.
  The adapter must tail `transcript_path` to leave `waiting` promptly. It then emits `tool.end {ok: false}` and
  `turn.end`, so the protocol doesn't change.

### `session_id` stability

- **Resume** (`--resume latest`): the same `session_id`, with `SessionStart(source: "resume")`.
- **`/clear` / `/new`:** a **new** `session_id` in the same process. The office should show this as the same
  character starting fresh, not as one agent leaving and another arriving. Key the character by (pid, cwd) across a
  `clear` pair.

### Subagents

Yes. The model calls the `invoke_agent` tool (`agent_name`: `generalist`, `codebase_investigator`, …; `prompt`):

- The subagent's own tool calls fire `BeforeTool` / `AfterTool` with the **parent's `session_id` and
  `transcript_path`**. Nothing in the payload names the subagent. They can be attributed only by nesting inside
  `BeforeTool(invoke_agent)` … `AfterTool(invoke_agent)`, which is ambiguous when subagents run in parallel.
- The subagent's transcript is `chats/<parentSessionId>/<subagentSessionId>.jsonl`, and its first line has
  `kind: "subagent"`.
- `AfterTool(invoke_agent).tool_response.llmContent` reports `Termination Reason: GOAL` (or an error such as
  `ERROR_NO_COMPLETE_TASK_CALL`). `returnDisplay.recentActivity[]` lists the subagent's recent tool calls.
- Mapping: `BeforeTool(invoke_agent)` → `subagent.start`; `AfterTool(invoke_agent)` → `subagent.end`. Inner tool
  events go to the only open subagent, or to the parent when the attribution is ambiguous.

### Session files (`transcript_path` and `chats/`)

- **Folder:** `<GEMINI_CLI_HOME or ~>/.gemini/tmp/<project-slug>/chats/`. The slug comes from
  `<home>/.gemini/projects.json`, which maps the **lower-cased** absolute project path to a short id such as the
  folder name. This replaces the SHA-256 `<project_hash>` folders, which the CLI migrates.
- **Main session:** `session-<YYYY-MM-DDTHH-MM>-<first 8 of sessionId>.jsonl`.
- **Format:** JSONL, append-only, read as last-write-wins:
  - line 1: metadata `{ sessionId, projectHash, startTime, lastUpdated, kind: "main" | "subagent", directories? }`;
  - messages `{ id, timestamp, type: "user" | "gemini" | "info" | …, content, … }`. A message is **appended again
    with the same `id`** every time it changes (tokens arriving, tool calls finishing), so readers keep the last copy
    per `id`;
  - `gemini` messages carry `model`, `tokens { input, output, cached, thoughts, tool, total }`, `thoughts[]` and
    `toolCalls[] { id, name, args, result, status: "success" | "error" | "cancelled", timestamp, displayName,
    description, resultDisplay }`;
  - control lines: `{ "$set": {…} }` (metadata), `{ "$rewindTo": "<messageId>" }` (history rewound) and
    `{ "$patch": … }`.
- Tool calls are written **when they finish**, not when they start.
- The first `user` message is a `<session_context>` blob (date, OS, workspace tree). Skip it.
- **Model and tokens come only from this file.** No hook payload carries them.

### Built-in tool names (0.65.0)

From the tool declarations the CLI sends to the model (`--approval-mode yolo`; default headless mode omits the tools
that need approval):

`read_file`, `list_directory`, `glob`, `grep_search`, `replace`, `write_file`, `run_shell_command`
(`is_background`), `list_background_processes`, `read_background_output`, `web_fetch`, `google_web_search`,
`invoke_agent`, `activate_skill`, `enter_plan_mode`, `update_topic`; inside subagents also `complete_task`.

Compared with CLAUDE.md: **`search_file_content` is now `grep_search`**; `read_many_files`, `save_memory` and
`write_todos` are **not declared** in 0.65.0. MCP tools arrive with `mcp_context`.

### Tool results and errors

- `tool_response.error = { message, type }` on tool errors (e.g. `type: "file_not_found"`).
- **Shell failures carry no `error`**: `llmContent` contains `Exit Code: 3` and `returnDisplay` says
  `Command exited with code: 3`. The shim must parse this to set `ok`.
- **Background jobs** (`run_shell_command` with `is_background: true`): `AfterTool` arrives right away with
  `Command moved to background (PID: <n>)`. No hook fires when the job ends.

### Enable flag

Not needed on 0.65.0 (hooks are on unless `hooksConfig.enabled: false`). On 0.15.1 it's needed (see Versions).

## Mechanics the shim and installer must respect

- **Matchers.** For tool events the matcher is a regex on `tool_name`. For `SessionStart`, `SessionEnd` and
  `PreCompress` it is compared to the trigger by **exact string equality**, so the plan's `.*` would never match.
  **Use `"*"` for every event**; the planner treats it as "match all".
- **How hooks run.** Through a shell: on Windows, `ComSpec` if that is PowerShell, else `pwsh.exe`, else
  `powershell.exe` (`-NoProfile -Command`); elsewhere `bash -c`. The registered command must be valid PowerShell:
  write `node "<path>"`, never a quoted executable first.
- **Blocking.** Gemini awaits each hook (default timeout 60 s). Hooks for one event run in parallel; events are
  sequential. In the TUI an "Executing Hooks: node …" spinner is visible while they run.
- **Liveness.** The shim's `process.ppid` is the **shell** (`pwsh.exe`), not Gemini. The agent's PID is its
  grandparent. The shell is still alive while the shim runs, so the shim must look the grandparent up itself
  (Windows: `wmic`, ~1 s, or a CIM query through PowerShell, 2–3 s, measured in P1-08; Linux: `/proc/<ppid>/stat`;
  macOS: `ps -o ppid=`), and only on `SessionStart`.
  On Linux, `bash -c` with a single command may `exec` node directly, so check the parent's name before climbing.
- **ACP mode** (`--acp`, used by editor integrations) fires **no** `SessionStart`, `BeforeTool`, `AfterTool` or
  `Notification` hooks, only `BeforeAgent`, `AfterAgent`, `PreCompress` and `SessionEnd`
  (`hooks-acp.jsonl`). ACP sessions will look idle-only unless the adapter also tails their chat files.
- **Accounts.** `GEMINI_CLI_HOME` relocates the whole `.gemini` folder. Treat it like `CLAUDE_CONFIG_DIR`: account
  = that home, or `default`.

## Performance (Windows 11, this machine)

| Measurement | Result |
| --- | --- |
| One no-op hook (`pwsh -NoProfile -Command 'node -e 0'`) | **~420 ms** (pwsh alone ~320 ms, node alone ~80 ms) |
| Scripted headless session, 7 tool steps, no hooks | 5.8 s, 6.1 s |
| Same session with all 8 hook events registered (33 hooks fired) | **18.9 s, 19.6 s** |

With hooks on Windows, every tool call costs ~0.8 s extra (`BeforeTool` + `AfterTool`), and `PreCompress` adds ~0.4
s to **every model request**. On Linux and macOS, `bash -c node` costs ~0.1 s per hook (not measured here).

## Privacy

Payloads carry conversation content: `prompt`, `prompt_response`, full `tool_input` (`write_file.content`), and
`tool_response.llmContent` with file contents and command output. `Notification.details` has `originalContent`,
`newContent` and `fileDiff`. **The shim forwards only what the office needs:**

- `tool_input`, truncated (8 KB per string), and masked server-side;
- from `tool_response`, only `ok`, `error.type`, the shell exit code and the background PID;
- from `Notification.details`, only `type`, `title`, `fileName` and `command`.

## Corrected mapping to `AgentEvent`

| Gemini CLI | `AgentEvent` | Change vs. CLAUDE.md |
| --- | --- | --- |
| `SessionStart` | `session.start` | matcher must be `"*"`; on `clear`, link to the previous session in the same pid |
| `BeforeAgent` | `turn.start` (`prompt`) | — |
| `BeforeTool` | `tool.start`; `invoke_agent` → `subagent.start` | may precede a permission prompt; no tool id (pair by name, FIFO) |
| `AfterTool` | `tool.end` (`ok` derived as above); `invoke_agent` → `subagent.end` | — |
| `Notification` (`ToolPermission`) | `waiting` (`permission`, text from `details.title`) | — |
| chat file: tool call `cancelled` / `info "Request cancelled."` | `tool.end {ok: false}` + `turn.end` | **new**: the only signal after a deny |
| `AfterAgent` | `turn.end` | — |
| chat file: `gemini` message `model` / `tokens` | `usage` (`model`, `tokens`) | **new**: hooks carry neither |
| `PreCompress` | *(not registered)* | **changed**: fires before every request, so it isn't a compaction signal |
| `SessionEnd` | `session.end` | fires twice on `/quit`: the reducer must be idempotent |

## Recommendations for P1-08 / P1-10

1. Register `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `Notification`, `BeforeTool` and `AfterTool`,
   all with matcher `"*"`. **Don't register `PreCompress`.**
2. Offer two hook profiles. **`full`** registers all seven. **`light`** leaves out `BeforeTool` and `AfterTool` and
   reads tool activity from the chat file once each call finishes, so 2 hooks per prompt instead of 2 per tool
   call. Default to `light` on Windows, where each hook costs ~0.4 s, and `full` elsewhere. Make it switchable with
   `--profile`.
3. The adapter always tails `transcript_path`: denials and cancels, model, tokens, subagent files, and ACP sessions.
4. The shim computes `ok` before dropping `tool_response`, and resolves the agent PID (the grandparent through the
   shell) on `SessionStart` only.
5. Support Gemini CLI ≥ 0.65.0 to start with.

## How the adapter uses this (P1-10)

- **Shim** (`hooks/gemini-cli.mjs`): it slims the payload before posting. `tool_response` becomes
  `tool_result: {ok, error_type, exit_code, background_pid}`, and the file-content keys of `tool_input` are dropped.
  The agent PID is resolved on `SessionStart` only.
- **Server** (`server/adapters/gemini-cli/`):
  - **Pairing.** Hook tool calls pair by name, oldest first, under generated ids, so parallel calls pair correctly.
  - **Subagents.** Tool hooks between `BeforeTool(invoke_agent)` and its `AfterTool` belong to a subagent and are
    ignored there; the subagent's chat file reports them instead. The parent's chat entry for `invoke_agent` carries
    **`agentId` = the subagent's chat session id**, so subagents match exactly. A subagent ends on `complete_task`,
    on the parent's finished `invoke_agent`, or after 120 s of silence.
  - **Chat files.** Paths come from hook payloads, so only `<home>/.gemini/tmp/<slug>/chats/session-*.jsonl` and
    `chats/<id>/<id>.jsonl` are opened. The account is `default`, or a hash of the `<home>` holding `.gemini`.
  - **Light profile and ACP.** Tool calls come from the chat file once they finish. If they're read after
    `AfterAgent`, a `turn.end` follows so the agent doesn't stay busy.
  - **Background jobs** end when their PID stops answering a probe.
  - **`/clear`.** `SessionEnd(clear)` waits up to 10 s for the `SessionStart(clear)` from the same PID, which then
    carries `continues`. Without one, the old session ends.
  - **Ignored events.** Events we don't register (`PreCompress`, …) are accepted and ignored.
- **Not covered yet:** sessions that were already running when the office started appear on their next hook. Gemini
  has no session registry to read at boot.

## Approving from the office (P7-03)

Not possible in 0.65.0. `BeforeTool` can return `deny`/`block` (the tool doesn't run, and the model sees `Tool
execution blocked: <reason>`) or `ask` (forces the prompt, even in YOLO mode). `allow` is ignored, so the CLI still
asks. The hook also runs before the policy check, so it can't tell whether a prompt will follow. See
[docs/spikes/gemini-approvals.md](../spikes/gemini-approvals.md).

