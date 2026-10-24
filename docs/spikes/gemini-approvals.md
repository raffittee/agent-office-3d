# Spike P7-03: approving Gemini CLI tool calls from the office

**Question:** can a `BeforeTool` hook decision safely mirror Gemini CLI's own confirmation, so the office can
approve or deny a tool call the way it does for Claude Code (P7-01)?

**Answer: no, so nothing is built.** In Gemini CLI 0.65.0, a hook can deny or force a prompt, but it can't approve.
It also runs before the CLI decides whether to ask, so it can't mirror the prompt. Gemini approvals stay in the
terminal. The office keeps showing the raised hand from the `Notification(ToolPermission)` hook.

## Method

- **Source:** Gemini CLI 0.65.0 from npm, bundled code.
  - `evaluateBeforeToolHook` and `Scheduler._processToolCall` handle the decision.
  - `DefaultHookOutput.isBlockingDecision` / `isAskDecision` read it.
- **Behavior:** the unmodified interactive TUI, driven through `node-pty`
  ([gemini-probe/tui-driver.mjs](gemini-probe/tui-driver.mjs)), with the model replaced by the local stub
  ([gemini-probe/fake-gemini.mjs](gemini-probe/fake-gemini.mjs), scenario `exec`: one
  `run_shell_command "mkdir probe-dir"`, then text).
- **The hook:** [gemini-probe/decide-hook.mjs](gemini-probe/decide-hook.mjs) answers `BeforeTool(run_shell_command)`
  with `{"decision": $DECISION, "reason": "…"}` and logs every call. Each run used a fresh `GEMINI_CLI_HOME`.

## Results

| Hook output | Approval mode | What happened |
| --- | --- | --- |
| `{"decision":"allow"}` | default | The CLI **still showed "Allow once"**, and `Notification(ToolPermission)` fired. The command didn't run until the prompt was answered. |
| `{"decision":"deny","reason":…}` | default | **No prompt.** The tool didn't run (`probe-dir` absent), and the model got `{"error":"Tool execution blocked: <reason>"}`, then carried on. |
| `{"decision":"ask"}` | YOLO | The CLI **showed "Allow once"** even in YOLO mode (`forcedDecision: "ask_user"`). |

The source agrees:

- `block` and `deny` become a `POLICY_VIOLATION` error.
- `ask` forces `PolicyDecision.ASK_USER`.
- Any other decision, `allow` included, is ignored, so `checkPolicy` decides as if no hook ran.
- `hookSpecificOutput.tool_input` can rewrite the arguments. That isn't relevant here, and we never use it.

## Why mirroring isn't safe

1. **It can't approve.** "Approve from the office" is impossible: only the terminal can approve.
2. **The hook runs before the policy check.** `BeforeTool` doesn't know whether the CLI will ask. To offer "deny"
   while waiting for the office, the hook would have to hold **every** tool call, including auto-approved reads,
   until the office answers or a timeout passes.
3. **It's sequential, not concurrent.** Claude Code shows its dialog and runs the hook at the same time. Gemini waits
   for the hook first, so a waiting hook would hide the terminal prompt instead of racing it. Hooks already cost
   ~0.4 s each on Windows (P0-04).
4. **`Notification` is observe-only.** It fires at the right moment, when the prompt is shown, but its output is
   ignored.

## Decision

- No Gemini approvals in the office for v1. `GeminiCliAdapter.capabilities.approve` stays `false`, and the hook
  shim still prints nothing.
- **Revisit if:**
  - Gemini CLI adds a hook that runs at confirmation time and accepts a decision (a `PermissionRequest`
    equivalent); or
  - `BeforeTool` gains an `allow` that skips the prompt. Re-run this probe on each supported version bump.
- **ACP mode** (`gemini --acp`) does send permission requests over JSON-RPC
  ([gemini-probe/acp-driver.mjs](gemini-probe/acp-driver.mjs) answers them). Only the ACP client (the editor) can
  answer, though, and the office isn't that client.
