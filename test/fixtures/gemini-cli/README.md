# Gemini CLI fixtures

Captured on 2026-10-24 from the **real Gemini CLI 0.65.0** on Windows 11. A local stub replaced the model and
answered with scripted tool calls (see [`docs/spikes/gemini-probe/`](../../../docs/spikes/gemini-probe/)). Paths and
user names were rewritten to `C:\Users\dev\…`. The secret in `config.env` is fake (`sk-ant-api03-FAKE…`) and is kept
on purpose as masking test data.

## Hook payloads (`hooks-*.jsonl`)

One line per hook invocation: `{ "receivedAt": "<when the shim ran>", "payload": <raw stdin JSON> }`.

| File | Front end | What happens |
| --- | --- | --- |
| `hooks-headless-work.jsonl` | `-p`, yolo | read, replace, write (with the fake secret), shell, **parallel** glob + grep, **background** shell, **subagent** (`invoke_agent` → `list_directory` → `complete_task`) |
| `hooks-headless-fail.jsonl` | `-p`, yolo | `read_file` on a missing file (`error.type: file_not_found`), shell `exit 3` (no `error`, exit code only in text) |
| `hooks-headless-resume.jsonl` | `-p --resume latest` | `SessionStart(resume)` with the same `session_id` as the fail run |
| `hooks-tui-allow-deny.jsonl` | TUI | write → permission → **allowed**; write → permission → **denied** (no further hook); new prompt; `/quit` (two `SessionEnd`) |
| `hooks-tui-exec-allow.jsonl` | TUI | shell command needing approval (`details.type: exec`) → allowed |
| `hooks-tui-cancel-clear.jsonl` | TUI | permission prompt **cancelled with Esc**; `/clear` (`SessionEnd(clear)` old id → `SessionStart(clear)` new id); prompt; `/quit` |
| `hooks-acp.jsonl` | `--acp` | shell + write with approval over ACP: **no** `SessionStart` / tool / `Notification` hooks fire |

## Chat files (`chat-*.jsonl`)

Verbatim session files from `<home>/.gemini/tmp/<slug>/chats/`.

| File | Session |
| --- | --- |
| `chat-headless-work.jsonl` | Main session of the headless work run |
| `chat-headless-work-subagent.jsonl` | Its subagent (`chats/<parentSessionId>/<subagentSessionId>.jsonl`, `kind: "subagent"`) |
| `chat-tui-allow-deny.jsonl` | The TUI allow and deny run: `status: "cancelled"` and `info: "Request cancelled."` after the denial |
