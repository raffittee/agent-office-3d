# Interacting from the office

Phase 7 adds features that act on your agents' sessions: approving permission requests, answering questions,
sending messages and reading conversations from the office. They are **off by default**. This page explains how to turn them on, what they can do, and what
the risks are.

## Turning them on

1. Start the server with the interactive features on, bound to this computer only:

   ```bash
   AGENT_OFFICE_INTERACTIVE=1 npm start        # or: npm run dev -- --interactive
   ```

   If `AGENT_OFFICE_HOST` isn't a loopback address (`127.0.0.1`, `::1`, `localhost`), the server logs a warning and
   keeps them off.

2. Install the Claude Code hook (one `PermissionRequest` entry per Claude config folder, with a backup first):

   ```bash
   npm run hooks:install -- --provider claude-code     # also hooks:status and hooks:uninstall
   ```

   Restart open Claude Code sessions so they load it.

3. Keep a page of the office open. With no page open, requests stay in the terminal.

## What you can do

- **Approve or deny** a permission request ("Do you want to…") from a card at the bottom right. The card shows the
  tool, a CLI-style title (`Bash(npm test)`) and, under *Arguments*, the masked command, diff or JSON.
- **Always allow**: when Claude Code offers a rule (for example `Bash(npm test:*)` for this project), the card offers
  it too. The office never invents a rule. It only passes back the position of one that Claude Code offered, and the
  hook applies Claude Code's original.
- **Deny with a reason**: the agent sees "Denied by the user in Agent Office: <reason>".
- **Answer a question** (`AskUserQuestion`): pick the options, or type in *Other*. The hook sends Claude Code the
  original question and option texts.
- **Answer in the terminal**: hands the request back. The hook exits without deciding, and the terminal dialog
  decides.

The terminal dialog stays live the whole time, and whichever answers first wins. If you answer in the terminal, the
card goes away when the tool call ends.

## Messages (P7-04)

Select an agent. If it can receive messages, a **Message** box appears under its details (Ctrl+Enter sends). The
text goes into the session exactly as typed, as if you had typed it in the terminal. If the agent is busy, the
message waits in the session's queue. The box shows whether each message got through.

| Provider | How it reaches the session | Setup |
| --- | --- | --- |
| Claude Code | The `agent-office-messages` plugin polls the office every 2 s and submits each message as yours (`$.prompt.submit`, Claude Code 2.1.287+). | `claude plugin marketplace add <this checkout>`, then `claude plugin install agent-office-messages@agent-office`. Set `AGENT_OFFICE_PORT` if the office isn't on 4848. |
| Codex | The server runs `codex queue --thread=<id> --message=<text>` with the account's `CODEX_HOME`. Codex picks it up when the session is idle. | `codex` on `PATH`, or `AGENT_OFFICE_CODEX_BIN`. Subagent threads can't be messaged; Codex refuses that. |
| Custom agents | The SDKs' `inbox()` / `ack()` (see [sdk/README.md](../sdk/README.md)). | Poll `inbox()` every few seconds. |
| Gemini CLI | Not supported: no hook or command can put a prompt into a running session. | — |

**Message privacy:** a message is never sent back to the page and never logged. The timeline shows only its start,
masked.

**Message risk:** a message is a prompt in your name. Anything on this computer that can reach the office can send
one to an agent that has messaging set up.

## Reading conversations (P7-05)

- **💬 Conversation** in an agent's details opens a read-only view of its conversation, refreshed every 2.5 s while
  open. It shows:
  - your prompts and slash commands;
  - the agent's answers and thinking;
  - each tool call (CLI-style title, folded arguments) with its result underneath.
- **🕘** in the top bar lists the 40 most recent sessions of every provider, open or ended, and opens their
  conversations.

How it works:

- The server reads only the last 4 MB of a transcript and shows the latest 400 entries. Each provider has its own
  parser: Claude Code's `projects/**/*.jsonl`, Codex's rollouts, Gemini CLI's `chats/` files.
- **Masked:** every text is masked and cut before it leaves the server.
- **Never shown:**
  - system reminders, developer instructions and environment context;
  - Claude Code's `api-request*` and `credential_org` records (dropped before parsing);
  - paths: history items carry an opaque key.

**Conversation risk:** conversations can contain anything the agents read: code, logs, and possibly secrets the
masking doesn't recognize. They're behind the same local-only gate as the other interactive routes.

## How it works

```
Claude Code ──PermissionRequest──▶ hooks/claude-permission.mjs ──POST /api/permissions──▶ registry
                                         │  long-poll GET /api/permissions/:id/wait          │
                                         ◀───────────── decision ◀── POST …/decision ◀── page card
```

- The hook sends only the session id, the tool name, its input (strings cut to 8 KB), the rule suggestions and the
  `cwd`. It never sends the transcript path.
- The request skips the office entirely, and the hook exits at once, when:
  - the server is down or the interactive features are off;
  - no page is open;
  - the session isn't in the office;
  - the question can't be shown in full.
- The hook waits 5 minutes by default (`AGENT_OFFICE_PERMISSION_TIMEOUT`, in seconds, up to 24 h). After that, the
  terminal decides.
- A request is dropped when:
  - the hook dies;
  - the agent leaves;
  - the tool call ends (it was answered in the terminal);
  - a long wait has had no page open for 5 minutes.

## Safeguards

- **Local only.** The routes answer only when:
  - the server is bound to loopback;
  - the request's `Host` is a loopback name;
  - for `POST`, the body is JSON (`Content-Type: application/json`) and any `Origin` is local.

  An allow-listed LAN name (`AGENT_OFFICE_ALLOWED_HOSTS`) can view the office, but it can't act on it.
- **No arguments in the snapshot.** The snapshot carries only the title and summary. The masked arguments are served
  only by `GET /api/permissions/:id`, which has the same local-only rules.
- **Masked and cut.** Titles, previews and rules go through `maskSecrets` and are truncated. Denial reasons are masked
  in the timeline.
- **Never blocks the agent.** Every error in the hook means "leave without deciding", so the terminal decides as usual.

## Risks

- **Anything that can reach the office can approve.** Any process on this computer that can open
  `http://127.0.0.1:<port>` can approve or deny a pending request: a script, or another local user on a shared
  machine. Leave the interactive features off on shared machines.
- **"Always allow" changes Claude Code's settings.** It writes the rule to the destination Claude Code proposed
  (session, local or project settings, or user settings), exactly as choosing it in the terminal would.
- **A long timeout keeps the agent waiting.** With `AGENT_OFFICE_PERMISSION_TIMEOUT` set high, a background subagent
  waits up to that long if nobody answers, because its terminal dialog only appears once the hook ends. Requests
  with no page open for 5 minutes are handed back to the terminal to limit this.
- **Gemini CLI and Codex** can't be approved from the office yet. Gemini's is the P7-03 spike; Codex's hook only
  observes.
