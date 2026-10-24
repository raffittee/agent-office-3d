# Spike: OTLP receiver (P5-05)

**Question:** should the office accept OpenTelemetry logs (OTLP/HTTP JSON at `/v1/logs`, local only) as another
generic path, mapping the CLIs' own telemetry to `AgentEvent`s?

**Answer: not for v1.** See [ADR 0006](../adr/0006-otlp.md). The telemetry describes requests and finished tool
calls, not a session's life. It carries content we'd have to throw away, and it's large.

## How it was measured (2026-10-25)

- `docs/spikes/otlp/receiver.mjs`: a capture receiver on `127.0.0.1:4318` that records every OTLP request
  (path, content type, size, body).
- **Codex 0.164.0**, driven offline against the P5-01 stub (`docs/spikes/codex-probe/stub-scenario.mjs`): a write, a
  background command, a subagent, a refused escalation. Telemetry turned on with
  `[otel] exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }` and
  `log_user_prompt = false` in a throwaway `CODEX_HOME/config.toml`.
- **Gemini CLI 0.65.0**, driven by the P0-04 probe (`docs/spikes/gemini-probe/`, scenario `work`): reads, a failed
  read and a failed edit, a subagent. `telemetry: { enabled, target: "local", otlpEndpoint: "http://127.0.0.1:4318",
  otlpProtocol: "http", logPrompts: false }`.
- **Claude Code:** not captured: its telemetry needs a signed-in session. Nothing below is assumed about it.

The raw captures aren't committed: they hold machine paths, a host name and an installation id.

## Measurements

| | Codex 0.164.0 | Gemini CLI 0.65.0 |
| --- | --- | --- |
| Session length | ~4 s, 7 tool calls, 1 subagent | ~3 s, 10 tool calls, 1 subagent |
| Requests | 2 × `/v1/logs` (JSON) | `/v1/logs`, `/v1/traces`, `/v1/metrics` (JSON) |
| Bytes received | **205 KB** | **1.3 MB** (logs 738 KB, traces 531 KB, metrics 33 KB) |
| Delay (event → received) | 135–865 ms (batched) | one batch at exit |
| Log records | 76 (45 `codex.sse_event`, 9 `codex.api_request`) | 67 (24 `gen_ai.client.inference.operation.details`, 12 + 12 api request/response) |
| For comparison: hook path (same scenario, shim bodies from the fixtures) | 18 posts, 7.9 KB | 33 posts, 10.7 KB |

## What the telemetry has and lacks

| Needed by the office | Codex telemetry | Gemini telemetry |
| --- | --- | --- |
| Session id | `conversation.id` (a subagent has its own) | `session.id` |
| **cwd (the room)** | **no** | **no** (only `process.command_args`) |
| PID (liveness) | no | `process.pid` (resource) |
| Session start | `codex.conversation_starts` | `gemini_cli.config` |
| **Session end** | **no** | **no** |
| Turn start | `codex.user_prompt` (prompt redacted) | `gemini_cli.user_prompt` |
| **Turn end** | **no** (only `codex.turn_ttft`) | **no** |
| Tool start | `codex.tool_decision` (approved) | **no** |
| Tool end | `codex.tool_result` (`call_id`, `success`, `duration_ms`) | `gemini_cli.tool_call` (`success`, `error_type`) |
| Waiting for the user | no (decisions only after the fact) | no |
| Subagents | a new `conversation.id`; the parent link only inside `spawn_agent`'s output text | `gemini_cli.agent.start` / `agent.finish` (`agent_id`, `agent_name`) |
| Background jobs | no | no |
| Tokens | `codex.sse_event` `response.completed` | `gemini_cli.api_response` |

**Content it carries** (we'd have to drop it on arrival, after it already left the agent's process):

- Codex: every tool call's `arguments` and the start of its `output`, plus `auth.*` flags.
- Gemini: `gen_ai.system_instructions` (~2.3 KB per request), error messages with full paths, an installation id.

## A possible mapping, for the record

| Telemetry | `AgentEvent` |
| --- | --- |
| `codex.conversation_starts`, `gemini_cli.config` | `session.start` (no cwd: room "(no project)") |
| `codex.user_prompt`, `gemini_cli.user_prompt` | `turn.start` |
| `codex.tool_decision` | `tool.start` |
| `codex.tool_result`, `gemini_cli.tool_call` | `tool.end` (Gemini: `tool.start` + `tool.end` together) |
| `gemini_cli.agent.start` / `agent.finish` | `subagent.start` / `subagent.end` |
| `codex.sse_event` (`response.completed`), `gemini_cli.api_response` | `usage` |
| (nothing) | `turn.end`, `session.end`: only by timeout |

Without `turn.end`, every agent would look busy until a timeout, and without `cwd` every agent would land in the same
room. Both are things the hook and file paths already get right.
