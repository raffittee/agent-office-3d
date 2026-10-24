// Agent Office hook shim for Gemini CLI. Registered by `npm run hooks:install -- --provider gemini-cli` for
// SessionStart, SessionEnd, BeforeAgent, AfterAgent, Notification and (profile `full`) BeforeTool / AfterTool.
//
// Gemini waits for every hook, and on Windows each one costs ~0.4 s, so this stays tiny. It never writes to stdout
// (Gemini reads hook stdout as JSON) and always exits 0. What leaves the agent's process tree is cut down here
// (docs/providers/gemini-cli.md › Privacy): tool inputs without file contents; from tool_response only ok, the error
// type, the shell exit code and a background PID; from Notification.details only type, title, fileName and command.
import { agentPid, isMain, mainOf, runShim } from './shim.mjs';

/** Tool-input keys that carry file contents or edits: never forwarded. */
export const DROP_INPUT_KEYS = new Set(['content', 'old_string', 'new_string', 'newContent', 'originalContent', 'fileDiff', 'edits']);
const MAX_INPUT_STRING = 1_000;
const MAX_MESSAGE = 300;

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

/** A tool input without file contents, with strings cut. */
export function slimInput(input) {
  if (!isObject(input)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (DROP_INPUT_KEYS.has(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, MAX_INPUT_STRING);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (isObject(x) && typeof x.text === 'string' ? x.text : '')).join('\n');
  return '';
}

/**
 * What the office needs from a tool_response. Shell failures carry no `error`: the exit code is only in the text
 * ("Exit Code: 3"). A background command reports "Command moved to background (PID: n)".
 */
export function toolResult(response) {
  if (!isObject(response)) return { ok: true };
  const text = `${textOf(response.llmContent)}\n${textOf(response.returnDisplay)}`;
  const out = { ok: true };
  if (isObject(response.error)) {
    out.ok = false;
    const type = str(response.error.type, 60);
    if (type) out.error_type = type;
  }
  const exit = /Exit Code:\s*(-?\d+)/i.exec(text)?.[1];
  if (exit !== undefined) {
    out.exit_code = Number(exit);
    if (out.exit_code !== 0) out.ok = false;
  }
  const bg = /moved to background \(PID:\s*(\d+)\)/i.exec(text)?.[1];
  if (bg) out.background_pid = Number(bg);
  return out;
}

/** The body posted to /api/hooks/gemini-cli. `resolvePid` runs only on SessionStart (it costs 1–3 s on Windows). */
export function buildBody(input, resolvePid = () => agentPid()) {
  const event = str(input.hook_event_name, 40);
  if (!event) return undefined;
  const body = { hook_event_name: event };
  for (const k of ['session_id', 'transcript_path', 'cwd', 'timestamp']) {
    const v = str(input[k], 4_000);
    if (v) body[k] = v;
  }
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
    case 'BeforeAgent': {
      const prompt = str(input.prompt, 8_000);
      if (prompt) body.prompt = prompt;
      break;
    }
    case 'BeforeTool':
    case 'AfterTool': {
      const name = str(input.tool_name, 200);
      if (name) body.tool_name = name;
      const slim = slimInput(input.tool_input);
      if (slim) body.tool_input = slim;
      if (event === 'AfterTool') body.tool_result = toolResult(input.tool_response);
      break;
    }
    case 'Notification': {
      const type = str(input.notification_type, 60);
      if (type) body.notification_type = type;
      const message = str(input.message, MAX_MESSAGE);
      if (message) body.message = message;
      if (isObject(input.details)) {
        const d = {};
        for (const k of ['type', 'title', 'fileName', 'command']) {
          const v = str(input.details[k], MAX_MESSAGE);
          if (v) d[k] = v;
        }
        body.details = d;
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
    await runShim({ provider: 'gemini-cli', build: (input) => buildBody(input) });
  });
}
