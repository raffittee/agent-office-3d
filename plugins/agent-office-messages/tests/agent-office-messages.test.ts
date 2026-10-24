// Ported from habblaud mod/habblaud-mensagens/tests/habblaud-mensagens.test.ts (MIT, © 2026 Márcio Junior)
// The messages plugin's tests, run by Claude Code itself: `claude plugin test` inside plugins/agent-office-messages
// (no session, no login, no network). The stubs answer for Claude Code and Agent Office: env, clock (mock.clock),
// $.session.id, $.session.surfaces, $.http.fetch (the server's two routes) and the prompt.submit below (the session:
// accepts, a hook refuses, the call throws or hangs).
import type { HttpResponse, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { ackBody, inboxBody, MAX_REASON, parseInbox, portOf, reasonText, type InboxMessage } from '../hooks/register'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const PORT = '4850'
const INBOX_URL = `http://127.0.0.1:${PORT}/api/inbox`
const ACK_URL = `${INBOX_URL}/ack`
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' }

/** The office's inbox answer: messages, 'offline' (connection refused), 'hang' (no answer) or a raw HTTP answer. */
type Answer = InboxMessage[] | 'offline' | 'hang' | { status: number; text: string }
/** What the session does with a prompt: takes it, a hook refuses, the call throws, or it hangs (busy session). */
type Fate = 'ok' | 'drop' | 'throw' | 'hang'

interface World {
  env?: Record<string, string>
  surfaces?: ReadonlyArray<'terminal' | 'desktop'>
  inbox?: () => Answer
  ack?: () => 'ok' | 'offline' | 'hang'
  fate?: (text: string) => Fate
}

interface Sent {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

function response(status: number, text: string): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json' }, text }
}

/** A queue of answers: each ask takes the next; when it runs out, no messages. */
function batches(...list: Answer[]): () => Answer {
  return () => list.shift() ?? []
}

/** Registers every stub (before the first call on $, as the kit requires) and returns what gets captured. */
function world(on: On, w: World = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, w.env ?? { HOME: '/home/dev', AGENT_OFFICE_PORT: PORT })
  const sent: Sent[] = []
  const submits: Array<{ text: string; origin: unknown }> = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: w.surfaces ?? ['terminal'] }))
  on('http.fetch', async ($, e) => {
    const body = e.init?.body
    sent.push({ url: e.url, method: e.init?.method, headers: e.init?.headers, body: body === undefined ? undefined : JSON.parse(body) })
    if (e.url.endsWith('/ack')) {
      const a = w.ack ? w.ack() : 'ok'
      if (a === 'offline') return { deny: 'connect ECONNREFUSED 127.0.0.1:4850' }
      if (a === 'hang') {
        await clock.sleep(60_000)
        return { deny: 'too late' }
      }
      return { value: response(200, '{"ok":true}') }
    }
    const a = w.inbox ? w.inbox() : []
    if (a === 'offline') return { deny: 'connect ECONNREFUSED 127.0.0.1:4850' }
    if (a === 'hang') {
      await clock.sleep(60_000)
      return { deny: 'too late' }
    }
    return { value: Array.isArray(a) ? response(200, JSON.stringify({ messages: a })) : response(a.status, a.text) }
  })
  on('prompt.submit', async ($, e) => {
    submits.push({ text: e.text, origin: e.origin })
    const fate = w.fate ? w.fate(e.text) : 'ok'
    if (fate === 'drop') return { drop: `refused by a hook: ${e.text}` }
    if (fate === 'throw') throw new Error('the session\nclosed')
    if (fate === 'hang') await clock.sleep(60_000)
    return { text: e.text }
  })
  return {
    clock,
    sent,
    submits,
    inboxes: () => sent.filter((s) => s.url === INBOX_URL),
    acks: () => sent.filter((s) => s.url === ACK_URL),
    texts: () => submits.map((s) => s.text),
  }
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const INBOX = { provider: 'claude-code', session: 'sess-1' }

describe('rounds', () => {
  test('every 2 s it asks the office (marking presence); with no messages nothing reaches the session and there is no ack', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    expect(w.sent).toEqual([])
    await w.clock.advance(2_000)
    expect(w.sent).toEqual([{ url: INBOX_URL, method: 'POST', headers: JSON_HEADERS, body: INBOX }])
    await w.clock.advance(4_000)
    expect(w.inboxes().length).toBe(3)
    expect(w.acks()).toEqual([])
    expect(w.submits).toEqual([])
  })

  test('delivers in order as if you typed it (text intact) and confirms everything in one POST', async ($, on) => {
    const typed = '  and then:\n- open the PR\n\n(no rush)  '
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'run the tests' }, { id: 'm2', text: typed }]) })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['run the tests', typed])
    expect(w.submits[0]?.origin).toEqual({ kind: 'plugin', name: 'agent-office-messages', asUser: true })
    expect(w.acks()).toEqual([{ url: ACK_URL, method: 'POST', headers: JSON_HEADERS, body: { ...INBOX, results: [{ id: 'm1', ok: true }, { id: 'm2', ok: true }] } }])
    await w.clock.advance(2_000)
    expect(w.sent.map((s) => s.url)).toEqual([INBOX_URL, ACK_URL, INBOX_URL])
    expect(w.submits.length).toBe(2)
  })

  test('a hook refusing and an exception become failures with the reason; no text fails without reaching the session', async ($, on) => {
    const raw = JSON.stringify({
      messages: [
        { id: 'a', text: 'go ahead' },
        { id: 'b', text: 'forbidden' },
        { id: 'c', text: 'breaks' },
        { id: 'd', text: '  \n ' },
        { id: 'e', text: 42 },
        // no id: it can't be confirmed, so it's left out
        { text: 'orphan' },
      ],
    })
    const w = world(on, {
      inbox: batches({ status: 200, text: raw }),
      fate: (t) => (t === 'forbidden' ? 'drop' : t === 'breaks' ? 'throw' : 'ok'),
    })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['go ahead', 'forbidden', 'breaks'])
    expect(w.acks()[0]?.body).toEqual({
      ...INBOX,
      results: [
        { id: 'a', ok: true },
        { id: 'b', ok: false, error: 'refused by a hook: forbidden' },
        // the throwing hook below is skipped and, with nothing under it, the call rejects: the reason is the kit's
        { id: 'c', ok: false, error: expect.stringMatching(/\S/) },
        { id: 'd', ok: false, error: 'empty message' },
        { id: 'e', ok: false, error: 'empty message' },
      ],
    })
  })

  test('busy session: past 2 s it counts as delivered and the next ones follow in order; rounds carry on', async ($, on) => {
    const w = world(on, {
      inbox: batches([
        { id: 'm1', text: 'first' },
        { id: 'm2', text: 'second' },
        { id: 'm3', text: 'third' },
      ]),
      fate: (t) => (t === 'first' ? 'hang' : 'ok'),
    })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['first'])
    expect(w.acks()).toEqual([])
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['first', 'second', 'third'])
    expect(w.acks().map((a) => a.body)).toEqual([{ ...INBOX, results: [{ id: 'm1', ok: true }, { id: 'm2', ok: true }, { id: 'm3', ok: true }] }])
    const asked = w.inboxes().length
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBeGreaterThan(asked)
  })

  test('one round at a time: with the session busy and the ack stuck, the middle ask is skipped', async ($, on) => {
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'first' }]), fate: () => 'hang', ack: () => 'hang' })
    await $.session.start(START)
    await w.clock.advance(2_000)
    // the round runs from 2 s (ask) to 4 s (submit deadline) and on to 6 s (ack deadline): the 4 s round doesn't start
    await w.clock.advance(3_000)
    expect(w.inboxes().length).toBe(1)
    expect(w.acks().length).toBe(1)
    await w.clock.advance(3_000)
    expect(w.inboxes().length).toBeGreaterThan(1)
    expect(w.texts()).toEqual(['first'])
  })

  test('a failing ack is silent: rounds carry on', async ($, on) => {
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'hi' }]), ack: () => 'offline' })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.acks().length).toBe(1)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(2)
    expect(w.texts()).toEqual(['hi'])
  })

  test('office down, 403 (interactive features off) or 404: backs off to 30 s until it is back', async ($, on) => {
    let answer: Answer = 'offline'
    const w = world(on, { inbox: () => answer })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
    await w.clock.advance(28_000)
    expect(w.inboxes().length).toBe(1)
    answer = { status: 403, text: '{"error":"the interactive features are off"}' }
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(2)
    answer = { status: 404, text: '{"error":"unknown route"}' }
    await w.clock.advance(30_000)
    expect(w.inboxes().length).toBe(3)
    answer = []
    await w.clock.advance(30_000)
    expect(w.inboxes().length).toBe(4)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(5)
    expect(w.acks()).toEqual([])
  })

  test('office stuck: gives up after 2 s and backs off to 30 s', async ($, on) => {
    let hang = true
    const w = world(on, { inbox: () => (hang ? 'hang' : []) })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
    await w.clock.advance(31_000)
    expect(w.inboxes().length).toBe(1)
    hang = false
    await w.clock.advance(1_000)
    expect(w.inboxes().length).toBe(2)
  })

  test('a session without a surface (claude -p, SDK) never asks', async ($, on) => {
    const w = world(on, { surfaces: [] })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(10_000)
    expect(w.sent).toEqual([])
  })

  test('a desktop-app session off screen (an SDK without a surface) asks anyway', async ($, on) => {
    const w = world(on, { surfaces: [], env: { HOME: '/home/dev', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', AGENT_OFFICE_PORT: PORT } })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
  })

  test('without AGENT_OFFICE_PORT it asks on the default port', async ($, on) => {
    const w = world(on, { env: {} })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.sent).toEqual([{ url: 'http://127.0.0.1:4848/api/inbox', method: 'POST', headers: JSON_HEADERS, body: INBOX }])
  })
})

describe('pure functions', () => {
  test('inbox: an odd shape = down; an item without an id is left out; no text becomes an empty text', () => {
    expect(parseInbox('<html>')).toBeUndefined()
    expect(parseInbox('[]')).toBeUndefined()
    expect(parseInbox('{"messages":{}}')).toBeUndefined()
    expect(parseInbox('{"messages":[]}')).toEqual([])
    expect(parseInbox(JSON.stringify({ messages: [{ id: 'a', text: ' x\n' }, { id: '', text: 'y' }, { text: 'z' }, null, { id: 'b' }] }))).toEqual([
      { id: 'a', text: ' x\n' },
      { id: 'b', text: '' },
    ])
  })

  test('the two routes’ bodies', () => {
    expect(JSON.parse(inboxBody('s'))).toEqual({ provider: 'claude-code', session: 's' })
    expect(JSON.parse(ackBody('s', [{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'no' }]))).toEqual({
      provider: 'claude-code',
      session: 's',
      results: [
        { id: 'a', ok: true },
        { id: 'b', ok: false, error: 'no' },
      ],
    })
  })

  test('failure reason: one line, bounded, and the fallback when there is no text', () => {
    expect(reasonText('a\nhook\t refused ', 'fallback')).toBe('a hook refused')
    expect(reasonText(new Error('boom'), 'fallback')).toBe('boom')
    expect(reasonText({ message: 'from elsewhere' }, 'fallback')).toBe('from elsewhere')
    expect(reasonText('   ', 'fallback')).toBe('fallback')
    expect(reasonText(undefined, 'fallback')).toBe('fallback')
    const long = reasonText('x'.repeat(2_000), 'fallback')
    expect(long.length).toBe(MAX_REASON)
    expect(long.endsWith('…')).toBe(true)
  })

  test('port', () => {
    expect(portOf('4850')).toBe(4850)
    expect(portOf('0')).toBe(4848)
    expect(portOf('abc')).toBe(4848)
    expect(portOf(undefined)).toBe(4848)
  })
})
