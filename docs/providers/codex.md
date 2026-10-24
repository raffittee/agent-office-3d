# Codex: provider notes

**Verified against the real CLI, Codex 0.164.0 (`npm i @openai/codex`), on 2026-10-25 (P5-01).** Codex was driven
offline against a stub model (a local Responses API: `docs/spikes/codex-probe/`), with `exec`, background commands,
a subagent, `apply_patch` and a rejected escalation. Sanitized captures are in `test/fixtures/codex/`.

How it was run: a temporary `CODEX_HOME` with a `config.toml` naming the stub as `model_provider` (`wire_api =
"responses"`), and `codex exec --dangerously-bypass-hook-trust --skip-git-repo-check "<prompt>" </dev/null`. Without
`</dev/null`, `exec` waits for more input on stdin. Without the trust bypass, untrusted hooks don't run.

## Files

| What | Where | Notes |
| --- | --- | --- |
| Open threads | `<CODEX_HOME>/thread-writer-locks/<threadId>.lock` | Empty files, present while a thread is loaded; `.coordination.lock` is not a thread. **Check existence only**: opening one with `flock` would hold Codex's lock. |
| Rollouts | `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<threadId>.jsonl` | One per thread, subagents included. Old ones may move to `archived_sessions/`. |
| Hooks | `<CODEX_HOME>/hooks.json` | `{ "hooks": { "<Event>": [{ "matcher"?, "hooks": [{ "type": "command", "command", "timeout", "async"? }] }] } }` |
| Trust | `config.toml` › `[hooks.state."…"].trusted_hash` | Written by Codex when the user trusts a hook in `/hooks`. **We never read or write `config.toml` or `auth.json`.** |
| Also there | `state_5.sqlite`, `logs_2.sqlite`, `skills/`, `shell_snapshots/`… | Not used. |

Thread ids are UUIDv7 (`01a16fe8-b06f-7d41-b4b5-b9df82fd2dff`). A session's main thread id is the `session_id`.

## Rollout format (`history_mode: "paginated"`, since 0.158)

Every line: `{ "timestamp", "ordinal", "type", "payload" }`.

- `session_meta` (first line, ~22 KB because it holds the base instructions): `id`, `session_id`, `cwd`,
  `cli_version`, `source` (`"exec"`, `"cli"`, `"vscode"`…, or `{ "subagent": { "thread_spawn": { "parent_thread_id",
  "depth", "agent_nickname", "agent_role" } } }`), `thread_source` (`user`, `subagent`), `agent_nickname`,
  `parent_thread_id`, `git`.
- `event_msg`:
  - `task_started` (`turn_id`) … `task_complete` (`turn_id`, `last_agent_message`, `duration_ms`); `turn_aborted`.
  - `item_completed` with `item.type`: `UserMessage` (the prompt), `AgentMessage`, `CommandExecution` (`process_id`,
    `command`, `exit_code`), `FileChange` (`changes`: path → `{type, unified_diff | content}`), `CollabAgentToolCall`.
    A command left running in the background completes **when its process ends**.
  - `token_count`: `info.total_token_usage` (cumulative) and `info.last_token_usage` (`input_tokens` includes
    `cached_input_tokens`), plus `rate_limits` (`limit_id: "codex"`, `primary`/`secondary` with `used_percent`,
    `window_minutes` 300 or 10080, `resets_at`; `plan_type`; `rate_limit_reached_type`). The stub sends no limits, so
    they are all `null` in the fixtures.
  - `thread_settings_applied` (`model`, `approval_policy`…).
- `response_item`: the model context. `function_call` (`name`, `namespace` for `multi_agent_v1` tools, `arguments`
  JSON, `call_id`), `function_call_output` (`call_id`, `output` text), `custom_tool_call` / `custom_tool_call_output`
  (`apply_patch`: `input` is the patch text), `message`.
- `turn_context`, `world_state`, `token_usage_record`: context bookkeeping.

Tool output texts the adapter reads (never forwarded):

- `exec_command`: `Chunk ID: …\nWall time: …\nProcess exited with code N\n…`, or `Process running with session ID N`
  (the command keeps running: a background job; `write_stdin` with `session_id: N` polls it).
- `apply_patch`: `Exit code: N\nWall time: …\nOutput:\nSuccess. Updated the following files:\nA notes.md\nM x.txt`.
- A refused escalation (`exec` forces `approval_policy` never): `approval policy is Never; reject command — …`.
- `spawn_agent`: `{"agent_id": "<thread>", "nickname": "Einstein"}`; `wait_agent`: `{"status": {"<id>": {"completed":
  "…"}}, "timed_out": false}`.

## Tools offered by 0.164.0

`exec_command` (`cmd`, `yield_time_ms`, `sandbox_permissions`, `justification`, `workdir`…), `write_stdin`
(`session_id`, `chars`), `apply_patch` (custom/freeform; offered only for known models), `request_user_input`,
`view_image`, `web_search`, `tool_search`, `get_goal` / `create_goal` / `update_goal`, and the `multi_agent_v1`
namespace: `spawn_agent` (`message`, `items`, `fork_context`, `model`), `wait_agent` (`targets`), `send_input`,
`resume_agent`, `close_agent`. `update_plan` and `shell` are no longer offered. Codex reads and searches files through
`exec_command`.

## Hooks

Events (all observed except `PermissionRequest`, which `exec` never raises): `SessionStart` (`source`),
`UserPromptSubmit` (`prompt`, `turn_id`), `PreToolUse` / `PostToolUse` (`tool_name`, `tool_input`, `tool_use_id` =
the rollout's `call_id`, `tool_response`), `Stop` (`last_assistant_message`), `SubagentStart` / `SubagentStop`
(`agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`), `SessionEnd` (`reason`).

Fields on every event: `session_id` (the main thread), `transcript_path`, `cwd`, `hook_event_name`, `model`,
`permission_mode`, plus `turn_id` on turn events. **A subagent's events carry the parent's `session_id` and their own
`agent_id`**: that's how its tools are told apart.

Names in hooks differ from the rollout: a shell call is `Bash` with `tool_input.command` (the rollout says
`exec_command` with `cmd`), and namespaced tools are glued to their namespace (`multi_agent_v1wait_agent`).
`spawn_agent` stays `spawn_agent`.

Behavior: hooks run through `$SHELL -lc` (`ppid` is the shell). `async: true` hooks don't block. `SessionEnd`'s timeout is
clamped to 3 s. The environment holds `CODEX_HOME` only when the user set it. A new or changed hook runs only after
the user trusts it in `/hooks` (the hash covers the command, timeout and async flag, and the group's position), so the
installer appends groups at the end and uses a command without options.

## Mapping to `AgentEvent` (server/adapters/codex/)

| Codex | `AgentEvent` |
| --- | --- |
| a lock appears, or `SessionStart` | `session.start` (rebuilt from the rollout's last 512 KB) |
| `task_started` + `UserMessage`, or `UserPromptSubmit` | `turn.start` (with the prompt), once per `turn_id` |
| `function_call` / `custom_tool_call`, or `PreToolUse` | `tool.start`, once per `call_id` |
| `*_output`, or `PostToolUse` | `tool.end` (`ok` from the exit code; `rejected`) |
| `Process running with session ID N` | `job.start` `exec:N`; `job.end` when its `CommandExecution` completes |
| subagent rollout (`thread_spawn.parent_thread_id`), or `SubagentStart` | `subagent.start` (role = nickname, title = task) |
| its `task_complete`, or `SubagentStop` | `subagent.end` |
| `request_user_input`, `PermissionRequest` | `waiting` (question, permission) |
| `token_count` | `usage` (tokens); `rate_limits` → plan usage (P5-04) |
| `task_complete` / `turn_aborted`, or `Stop` | `turn.end` |
| the lock disappears, or `SessionEnd` | `session.end` |

Liveness: a main thread is alive while its lock exists (`alive()`), without a PID probe.

## Privacy

Payloads contain prompts, patch contents (`apply_patch` input, `FileChange`), command output and the model's replies.
The shim (`hooks/codex.mjs`) forwards the prompt (masked and truncated by the server), tool inputs without file
contents (an `apply_patch` becomes its file list), and from tool output only an exit code, a background exec session,
a rejection and a spawned agent's id and nickname. The adapter reads rollouts for the same fields only.

## Not verified yet

- `PermissionRequest`'s payload (needs the interactive TUI with an approval policy that asks).
- Interactive (TUI) sessions and the desktop app: the files are the same format, `source` differs.
- Real `rate_limits` values (needs a signed-in account).
