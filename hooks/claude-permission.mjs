#!/usr/bin/env node
// Ported from habblaud mod/habblaud-permissoes/hooks/permission-hook.mjs (MIT, © 2026 Márcio Junior)
// Claude Code's PermissionRequest hook for Agent Office (P7-01, P7-02): approve or deny Claude Code's permission
// requests ("Do you want to…") from the office, and answer its AskUserQuestion prompts. Installed by
//
//   npm run hooks:install -- --provider claude-code     # writes it into <claude config>/settings.json
//
// Claude Code shows its dialog in the terminal and runs this hook AT THE SAME TIME (whichever answers first wins); for
// background subagents the dialog only shows after the hook ends. The hook:
// 1. reads the request's JSON from stdin (session_id, tool_name, tool_input, permission_suggestions…);
// 2. sends only what the office uses to POST http://127.0.0.1:<port>/api/permissions. If Agent Office doesn't answer,
//    refuses (interactive features off) or says no page is open or the session is unknown, it leaves at once without
//    deciding: the terminal carries on as usual;
// 3. otherwise waits for the decision on GET /api/permissions/:id/wait (answers of up to 25 s, in a loop) until its
//    timeout (5 min by default: --timeout <s> or AGENT_OFFICE_PERMISSION_TIMEOUT);
// 4. approved or denied: prints the decision (hookSpecificOutput.decision). A question answered: approves the call
//    with the ORIGINAL input plus `answers` ({question text: chosen labels}), as Claude Code's hook docs say to answer
//    AskUserQuestion; the page picks by position and the texts come from stdin. "Answer in the terminal", a timeout or
//    any error: leaves without printing anything, and the terminal decides.
//
// Rules: plain Node (22+), `node:*` and the shim kit only; never hangs or breaks the session (every error = leave
// without deciding); talks only to 127.0.0.1. AGENT_OFFICE_HOOK_DEBUG=1 writes what happens to stderr.
import { isMain, readConfig, readStdin, trimDeep } from './shim.mjs';

export const DEFAULT_TIMEOUT_S = 300;
const MIN_TIMEOUT_S = 5;
const MAX_TIMEOUT_S = 86_400;
/** Longest single long-poll (the server answers "pending" and the hook asks again). */
const WAIT_S = 25;
/** Registering: if Agent Office doesn't answer in this, it's down (or stuck). */
const REGISTER_TIMEOUT_MS = 2_000;
const MAX_STRING = 8_000;
const MAX_BODY = 200_000;
const ASK_TOOL = 'AskUserQuestion';

const debug = process.env.AGENT_OFFICE_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[agent-office permission] ${msg}\n`) : () => {};

/** The timeout: argument (--timeout <s>) or AGENT_OFFICE_PERMISSION_TIMEOUT, clamped to 5 s – 24 h. */
export function timeoutMsOf(argv, env = process.env) {
  const i = argv.indexOf('--timeout');
  const raw = Number(i >= 0 ? argv[i + 1] : (env.AGENT_OFFICE_PERMISSION_TIMEOUT ?? ''));
  return (Number.isFinite(raw) && raw > 0 ? Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, raw)) : DEFAULT_TIMEOUT_S) * 1_000;
}

/** The body sent to Agent Office: only what it uses (no transcript_path, nothing else from stdin), cut to size. */
export function requestBody(input, timeoutMs) {
  const body = { provider: 'claude-code', session_id: input.session_id, tool_name: input.tool_name, tool_input: {}, timeout_ms: timeoutMs };
  for (const k of ['agent_id', 'agent_type', 'cwd']) if (typeof input[k] === 'string') body[k] = input[k];
  if (Array.isArray(input.permission_suggestions)) body.permission_suggestions = trimDeep(input.permission_suggestions, 1_000);
  for (const max of [MAX_STRING, 1_000, 200]) {
    body.tool_input = trimDeep(input.tool_input ?? {}, max);
    if (JSON.stringify(body).length <= MAX_BODY) break;
  }
  return body;
}

const text = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * AskUserQuestion's `answers` ({ORIGINAL question text: ORIGINAL labels of the chosen options, in their order, and the
 * free text last, joined with ", "}) from the answers by position. undefined = can't answer (leave without deciding):
 * no `questions`, a question unanswered or answered twice, a bad position, several choices without multiSelect,
 * questions with the same text.
 */
export function answersFor(answers, toolInput) {
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : undefined;
  if (!questions || !Array.isArray(answers) || !answers.length) return undefined;
  const out = {};
  const done = new Set();
  for (const a of answers) {
    const q = a && Number.isInteger(a.question) ? questions[a.question] : undefined;
    if (!q || typeof q !== 'object' || !text(q.question) || done.has(a.question) || Object.hasOwn(out, q.question)) return undefined;
    done.add(a.question);
    const options = Array.isArray(q.options) ? q.options : [];
    const parts = [];
    for (const i of Array.isArray(a.options) ? a.options : []) {
      const label = Number.isInteger(i) && i >= 0 ? options[i]?.label : undefined;
      if (!text(label)) return undefined;
      parts.push(label);
    }
    if (text(a.other)) parts.push(a.other.trim());
    if (!parts.length || (q.multiSelect !== true && parts.length > 1)) return undefined;
    out[q.question] = parts.join(', ');
  }
  // every real question needs an answer (the invalid ones never showed in the office)
  if (questions.some((q, i) => q && typeof q === 'object' && text(q.question) && !done.has(i))) return undefined;
  return out;
}

/**
 * The hook's output for a decision (undefined = leave without deciding). An "always allow" rule picked on the page
 * comes back only as a POSITION: the original suggestion Claude Code sent is applied. A question: only `answer`
 * approves it (without `answers` the call would have no answer); denying works.
 */
export function decisionOutput(result, input) {
  if (!result || result.status !== 'decided') return undefined;
  const ask = input?.tool_name === ASK_TOOL;
  const out = (decision) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
  if (result.behavior === 'answer') {
    const answers = ask ? answersFor(result.answers, input.tool_input) : undefined;
    return answers ? out({ behavior: 'allow', updatedInput: { ...input.tool_input, answers } }) : undefined;
  }
  if (result.behavior === 'allow') {
    if (ask) return undefined;
    const decision = { behavior: 'allow' };
    const list = Array.isArray(input?.permission_suggestions) ? input.permission_suggestions : [];
    const chosen = Number.isInteger(result.suggestion) ? list[result.suggestion] : undefined;
    if (chosen && typeof chosen === 'object') decision.updatedPermissions = [chosen];
    return out(decision);
  }
  if (result.behavior === 'deny') {
    const reason = typeof result.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 1_000) : '';
    const decision = { behavior: 'deny', message: reason ? `Denied by the user in Agent Office: ${reason}` : 'Denied by the user in Agent Office.' };
    if (result.interrupt === true) decision.interrupt = true;
    return out(decision);
  }
  return undefined;
}

/** A request to the local Agent Office; null = down, timed out or unreadable. */
async function call(base, method, path, body, timeoutMs) {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let json;
    try {
      json = raw ? JSON.parse(raw) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch (err) {
    debug(`${method} ${path}: ${err?.name ?? 'error'} ${err?.message ?? ''}`);
    return null;
  }
}

/** Decides the request (or not). Returns the output to print, or undefined. Never throws. */
export async function run(argv = process.argv.slice(2), env = process.env, stdinText) {
  try {
    const timeoutMs = timeoutMsOf(argv, env);
    const raw = stdinText ?? (await readStdin());
    if (!raw) return undefined;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!input || typeof input !== 'object' || typeof input.session_id !== 'string' || typeof input.tool_name !== 'string') return undefined;
    if (input.hook_event_name !== undefined && input.hook_event_name !== 'PermissionRequest') return undefined;

    const base = `http://127.0.0.1:${readConfig(env).port}`;
    const deadline = Date.now() + timeoutMs;
    const reg = await call(base, 'POST', '/api/permissions', requestBody(input, timeoutMs), REGISTER_TIMEOUT_MS);
    if (!reg || reg.status !== 201 || typeof reg.json?.id !== 'string') {
      debug(`not taken (${reg ? `${reg.status} ${JSON.stringify(reg.json ?? null)}` : 'Agent Office is down'})`);
      return undefined;
    }
    const id = encodeURIComponent(reg.json.id);
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        debug('timed out: the terminal decides');
        return undefined;
      }
      const waitS = Math.max(0.05, Math.min(WAIT_S, left / 1_000));
      const r = await call(base, 'GET', `/api/permissions/${id}/wait?timeout=${waitS}`, undefined, waitS * 1_000 + 5_000);
      if (!r || r.status !== 200) return undefined;
      if (r.json?.status === 'pending') continue;
      debug(`answer: ${JSON.stringify(r.json)}`);
      return decisionOutput(r.json, input);
    }
  } catch (err) {
    debug(`error: ${err?.message ?? err}`);
    return undefined;
  }
}

export async function main() {
  const timeoutMs = timeoutMsOf(process.argv.slice(2));
  // safety net: nothing keeps the process alive past the timeout
  setTimeout(() => process.exit(0), timeoutMs + 15_000).unref();
  const out = await run();
  // No process.exit right after fetch on Windows (nodejs/node#56645): let the loop drain (which also waits for the
  // write to the pipe), and exit 1 s later at most.
  const finish = () => setTimeout(() => process.exit(0), 1_000).unref();
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`, finish);
  else finish();
}

if (isMain(import.meta.url)) main().catch(() => process.exit(0));
