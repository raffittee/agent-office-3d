// Agent Office hook shim for Codex (P5-01). Registered by `npm run hooks:install -- --provider codex` in
// <CODEX_HOME>/hooks.json for SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, Stop,
// SubagentStart, SubagentStop and PermissionRequest (observe-only: approving from the office is Phase 7).
//
// Codex runs hooks through `$SHELL -lc` and trusts each one by a hash of its command (the user approves it in /hooks),
// so the command has no flags. Observe-only events run async. It never writes to stdout and always exits 0. What
// leaves the agent's process tree is cut down here (docs/providers/codex.md › Privacy): an apply_patch input becomes
// its file list; tool output is reduced to an exit code, a background exec session and, for spawn_agent, the new
// agent's id and nickname; the last assistant message is dropped.
import { agentPid, isMain, mainOf, runShim } from './shim.mjs';

const MAX_INPUT_STRING = 1_000;

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v, max) {
  return typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined;
}

/** Files a patch touches, without their contents. */
export function patchFiles(patch) {
  const out = [];
  for (const m of String(patch).slice(0, 200_000).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim().slice(0, 500));
  return out.slice(0, 50);
}

/** A tool input without file contents, with strings cut. */
export function slimInput(toolName, input) {
  if (toolName === 'apply_patch') {
    const patch = isObject(input) ? input.command ?? input.input ?? input.patch : input;
    return { files: patchFiles(typeof patch === 'string' ? patch : '') };
  }
  if (!isObject(input)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = v.slice(0, MAX_INPUT_STRING);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v.slice(0, 20).map((x) => x.slice(0, 200));
  }
  return out;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (isObject(v) && typeof v.output === 'string') return v.output;
  if (isObject(v) && typeof v.content === 'string') return v.content;
  return '';
}

/** What the office needs from a tool_response: an exit code, a background exec session, a spawned agent. */
export function toolResult(toolName, response) {
  const text = textOf(response).slice(0, 20_000);
  const out = {};
  const exit = /Process exited with code (-?\d+)/.exec(text)?.[1] ?? /^Exit code: (-?\d+)/m.exec(text)?.[1];
  if (exit !== undefined) out.exit_code = Number(exit);
  const running = /Process running with session ID (\d+)/.exec(text)?.[1];
  if (running) out.exec_session = Number(running);
  if (/^approval policy is \w+; reject command/.test(text)) out.rejected = true;
  if (/spawn_agent$/.test(toolName)) {
    try {
      const j = JSON.parse(text);
      if (typeof j.agent_id === 'string') out.agent_id = j.agent_id.slice(0, 64);
      if (typeof j.nickname === 'string') out.nickname = j.nickname.slice(0, 40);
    } catch {
      // not JSON: nothing to add
    }
  }
  return out;
}

/** The body posted to /api/hooks/codex. `resolvePid` runs only on SessionStart (it costs 1–3 s on Windows). */
export function buildBody(input, resolvePid = () => agentPid(), env = process.env) {
  const event = str(input.hook_event_name, 40);
  if (!event) return undefined;
  const body = { hook_event_name: event };
  for (const k of ['session_id', 'turn_id', 'transcript_path', 'cwd', 'agent_id', 'agent_type', 'agent_transcript_path', 'model', 'permission_mode']) {
    const v = str(input[k], 4_000);
    if (v) body[k] = v;
  }
  if (env.CODEX_HOME) body.codex_home = String(env.CODEX_HOME).slice(0, 4_000);
  switch (event) {
    case 'SessionStart': {
      const source = str(input.source, 40);
      if (source) body.source = source;
      const pid = resolvePid();
      if (Number.isInteger(pid) && pid > 0) body.pid = pid;
      break;
    }
    case 'SessionEnd': {
      const reason = str(input.reason, 40);
      if (reason) body.reason = reason;
      break;
    }
    case 'UserPromptSubmit': {
      const prompt = str(input.prompt, 8_000);
      if (prompt) body.prompt = prompt;
      break;
    }
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PermissionRequest': {
      const name = str(input.tool_name, 200);
      if (name) body.tool_name = name;
      const id = str(input.tool_use_id, 200);
      if (id) body.tool_use_id = id;
      const slim = slimInput(name, input.tool_input);
      if (slim) body.tool_input = slim;
      if (event === 'PostToolUse') body.tool_result = toolResult(name ?? '', input.tool_response);
      if (event === 'PermissionRequest') {
        const reason = str(input.reason ?? input.message ?? input.justification, 300);
        if (reason) body.reason = reason;
      }
      break;
    }
    default:
      break;
  }
  return body;
}

if (isMain(import.meta.url)) {
  mainOf(async () => {
    await runShim({ provider: 'codex', build: (input) => buildBody(input) });
  });
}
