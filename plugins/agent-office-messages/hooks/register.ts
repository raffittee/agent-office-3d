// Ported from habblaud mod/habblaud-mensagens/hooks/register.ts (MIT, © 2026 Márcio Junior)
// Messages from the office (P7-04, Claude Code 2.1.287+): brings what you type in Agent Office into the session, as
// if you had typed it in the terminal.
//
// What it does (`claude plugin validate` lists exactly what the module calls):
//
// 1. Every 2 s, only where the session draws (`$.session.surfaces()` empty = `claude -p`/SDK: nothing to do) or in a
//    desktop-app session (CLAUDE_CODE_ENTRYPOINT=claude-desktop), it asks the local Agent Office for this session's
//    messages: POST http://127.0.0.1:<AGENT_OFFICE_PORT or 4848>/api/inbox with {provider: "claude-code", session}.
//    Asking also marks the session present, which shows the agent's message box in the office. When the office is
//    down or answers anything but 2xx (403 = interactive features off), it asks every 30 s until it's back.
// 2. Each message, in order, goes to the session through `$.prompt.submit({ text, asUser: true })`: the model reads
//    it as yours. The text goes exactly as it came. `{drop}` (a hook refused it) or an exception = a failure, with the
//    reason. With the session mid-turn, Claude Code keeps the prompt until it's free and the call may take a while: the
//    wait per message is at most 2 s. Past that the message is in the session's queue and counts as delivered, and
//    the next ones of the same round follow in order without waiting.
// 3. One POST /api/inbox/ack with {provider, session, results: [{id, ok, error?}]}. No messages, no ack.
//
// Rules: no hook throws (each step has its try/catch and a failure is silence). One round at a time. No $.process,
// $.model, $.fs, no reading the conversation, no tool decisions; the network is 127.0.0.1 only. State lives in module
// variables: a hot reload starts over (a message fetched and not confirmed fails on the server after 30 s).
//
// Claude Code's static analysis: every call is written out ($.noun.method), event names are string literals, and `$`
// is only passed to functions declared at the top level of this file.
import type { EngineInterface, HttpResponse, Register } from 'claude-code'

/** Agent Office's default port. */
export const DEFAULT_PORT = 4848
/** How often to ask; when the office is down, back off to the second. */
export const POLL_MS = 2_000
export const OFFLINE_POLL_MS = 30_000
/** How long to wait for the local office (`$.http.fetch` takes no AbortSignal: it races a timer). */
export const FETCH_TIMEOUT_MS = 2_000
/** How long to wait for `$.prompt.submit` before counting the message as in the session's queue. */
export const SUBMIT_WAIT_MS = 2_000
/** Longest failure reason (from a hook or an exception; the message text itself is never cut). */
export const MAX_REASON = 500

/** A message as POST /api/inbox hands it over. */
export interface InboxMessage {
  id: string
  /** The text as typed; empty when the server sent something that isn't text. */
  text: string
}

/** A message's outcome, as POST /api/inbox/ack takes it. */
export interface AckResult {
  id: string
  ok: boolean
  error?: string
}

type Submitted = { ok: true } | { ok: false; error: string }

interface ModEnv {
  port: number
  /** A Claude desktop-app session: runs as an SDK and has a surface only while on screen, but takes prompts anyway. */
  desktop: boolean
}

// ---------------------------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------------------------

export function portOf(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : DEFAULT_PORT
}

/** Body of POST /api/inbox. */
export function inboxBody(session: string): string {
  return JSON.stringify({ provider: 'claude-code', session })
}

/** Body of POST /api/inbox/ack. */
export function ackBody(session: string, results: readonly AckResult[]): string {
  return JSON.stringify({ provider: 'claude-code', session, results })
}

/**
 * Reads POST /api/inbox's answer; anything off-format = undefined (counts as "down"). An item without an id is left out
 * (it can't be confirmed); with an id and no text it comes in with an empty text, to be confirmed as a failure.
 */
export function parseInbox(text: string): InboxMessage[] | undefined {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined
  const list = (j as Record<string, unknown>).messages
  if (!Array.isArray(list)) return undefined
  const out: InboxMessage[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    if (typeof m.id !== 'string' || !m.id) continue
    out.push({ id: m.id, text: typeof m.text === 'string' ? m.text : '' })
  }
  return out
}

/** A failure reason on one line, bounded: a `{drop}` text or an exception's message. */
export function reasonText(raw: unknown, fallback: string): string {
  const msg = typeof raw === 'string' ? raw : raw && typeof (raw as { message?: unknown }).message === 'string' ? (raw as { message: string }).message : ''
  const line = msg.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!line) return fallback
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line
}

// ---------------------------------------------------------------------------------------------
// Module state (gone on a hot reload) and what talks to Claude Code
// ---------------------------------------------------------------------------------------------

let env: ModEnv | undefined
let timer: { cancel: () => void } | undefined
let timerMs = 0
/** One round at a time: a slow office or a busy session never stacks rounds. */
let polling = false

/** The session's environment, read once per load (each name written out, as the analysis requires). */
async function readEnv($: EngineInterface): Promise<ModEnv> {
  if (env) return env
  env = {
    port: portOf(await $.env.get('AGENT_OFFICE_PORT')),
    desktop: (await $.env.get('CLAUDE_CODE_ENTRYPOINT'))?.trim() === 'claude-desktop',
  }
  return env
}

/** What `promise` resolves to within `ms`; past that, undefined (the promise carries on by itself). */
async function waitAtMost<T>($: EngineInterface, promise: Promise<T>, ms: number): Promise<T | undefined> {
  let wait: { cancel: () => void } | undefined
  const timeout = new Promise<undefined>((resolve) => {
    wait = $.clock.after(ms, () => resolve(undefined))
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    wait?.cancel()
  }
}

/** POST a JSON body to the local office within 2 s: the answer, or undefined (down, stuck). Never throws. */
async function postJson($: EngineInterface, port: number, path: string, body: string): Promise<HttpResponse | undefined> {
  try {
    const request = $.http.fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      // without the Content-Type the server's guard refuses the POST (415)
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    })
    return await waitAtMost($, request, FETCH_TIMEOUT_MS)
  } catch {
    return undefined
  }
}

/** One message to the session, as if you typed it. Never throws. */
async function submitOne($: EngineInterface, text: string): Promise<Submitted> {
  try {
    const r = await $.prompt.submit({ text, asUser: true })
    if (typeof r?.drop === 'string') return { ok: false, error: reasonText(r.drop, 'a session hook refused the message') }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: reasonText(err, 'the session did not accept the message') }
  }
}

/** Sends the messages to the session, in order, and returns each one's outcome. Never throws. */
async function deliver($: EngineInterface, messages: readonly InboxMessage[]): Promise<AckResult[]> {
  const results: AckResult[] = []
  /** A call ran past its deadline: the session is busy and the next ones queue behind it, without waiting. */
  let queued = false
  for (const m of messages) {
    if (!m.text.trim()) {
      results.push({ id: m.id, ok: false, error: 'empty message' })
      continue
    }
    const submitted = submitOne($, m.text)
    if (queued) {
      void submitted
      results.push({ id: m.id, ok: true })
      continue
    }
    const out = await waitAtMost($, submitted, SUBMIT_WAIT_MS)
    if (!out) {
      queued = true
      results.push({ id: m.id, ok: true })
    } else results.push(out.ok ? { id: m.id, ok: true } : { id: m.id, ok: false, error: out.error })
  }
  return results
}

/** (Re)schedules the rounds: 2 s with the office up, 30 s when it's down. */
function schedule($: EngineInterface, ms: number): void {
  if (timer && timerMs === ms) return
  timer?.cancel()
  timerMs = ms
  timer = $.clock.every(ms, () => {
    void round($)
  })
}

/** One round: fetch this session's messages, send each one and confirm. Never throws. */
async function round($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const e = await readEnv($)
    const surfaces = await $.session.surfaces()
    if (!surfaces.length && !e.desktop) return
    const session = await $.session.id()
    const res = await postJson($, e.port, '/api/inbox', inboxBody(session))
    const messages = res?.ok ? parseInbox(res.text) : undefined
    if (!messages) {
      schedule($, OFFLINE_POLL_MS)
      return
    }
    schedule($, POLL_MS)
    if (!messages.length) return
    const results = await deliver($, messages)
    // if the confirmation fails, the server fails the messages after 30 s ("the session did not confirm")
    await postJson($, e.port, '/api/inbox/ack', ackBody(session, results))
  } catch {
    // silence: the next round tries again
  } finally {
    polling = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      schedule($, POLL_MS)
    } catch {
      // without rounds, the session carries on as always
    }
    return next(e)
  })
}
