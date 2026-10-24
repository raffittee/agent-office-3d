// The read-only conversation view (P7-05). Session-touching (it shows what agents read and write), so it sits behind
// the same gate as the other interactive routes (http/app.ts: interactive features on, loopback Host). Paths never
// leave the server; every text is masked and cut by the providers' parsers.
//
//   GET /api/conversation/:agentId          the latest part of an agent's conversation: ConversationPage
//   GET /api/sessions                       recent sessions (open or ended), newest first: RecentSession[]
//   GET /api/sessions/:key/conversation     a recent session's conversation: ConversationPage
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { lastPage } from '../../shared/conversation';
import type { Office } from '../../shared/model/office';
import type { ConversationEntry, ConversationPage, ProviderId, RecentSession } from '../../shared/protocol';
import type { AdapterSet, SessionFile } from '../adapters/adapter';
import { sendJson } from '../http/app';
import { readTail } from './files';

/** Sessions in the history list. */
export const RECENT_MAX = 40;

const AGENT = /^\/api\/conversation\/([^/]+)$/;
const SESSION = /^\/api\/sessions\/([\w-]{8,64})\/conversation$/;

/** A transcript's latest part, parsed. */
export function pageOf(provider: ProviderId, file: string, parse: (lines: Iterable<string>) => ConversationEntry[]): ConversationPage {
  const tail = readTail(file);
  const page = lastPage(parse(tail.lines));
  return { provider, entries: page.entries, truncated: tail.truncated || page.dropped };
}

/** A stable, opaque key for a session (no path in it). */
export function sessionKey(s: Pick<SessionFile, 'provider' | 'account' | 'sessionId'>): string {
  return createHash('sha256').update(`${s.provider}|${s.account}|${s.sessionId}`).digest('base64url').slice(0, 22);
}

export function createConversationRoutes(office: Office, adapters: AdapterSet): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  /** The files behind the keys of the last list. */
  let listed = new Map<string, SessionFile>();

  const read = (res: ServerResponse, provider: ProviderId, file: string, parse: ((lines: Iterable<string>) => ConversationEntry[]) | undefined) => {
    if (!parse) return sendJson(res, 404, { error: 'this provider has no conversation view' });
    try {
      sendJson(res, 200, pageOf(provider, file, parse));
    } catch {
      sendJson(res, 404, { error: 'the transcript could not be read' });
    }
  };

  return (req, res, path) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET');
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    const a = AGENT.exec(path);
    if (a) {
      let id: string;
      try {
        id = decodeURIComponent(a[1]!);
      } catch {
        return sendJson(res, 400, { error: 'invalid id' });
      }
      const agent = office.get(id);
      const source = agent ? adapters.conversationOf(agent) : undefined;
      if (!agent || !source) return sendJson(res, 404, { error: 'no transcript for this agent' });
      return read(res, agent.provider, source.file, source.parse);
    }
    if (path === '/api/sessions') {
      const files = adapters.recentSessions(RECENT_MAX);
      listed = new Map(files.map((f) => [sessionKey(f), f]));
      const open = new Set(office.list().filter((x) => x.kind === 'main' && x.status !== 'offline').map((x) => `${x.provider}|${x.account}|${x.sessionId}`));
      const list: RecentSession[] = files.map((f) => ({
        key: sessionKey(f),
        provider: f.provider,
        account: f.account,
        sessionId: f.sessionId,
        lastAt: f.lastAt,
        open: open.has(`${f.provider}|${f.account}|${f.sessionId}`),
        ...(f.project ? { project: f.project } : {}),
      }));
      return sendJson(res, 200, list);
    }
    const s = SESSION.exec(path);
    if (s) {
      const f = listed.get(s[1]!);
      if (!f) return sendJson(res, 404, { error: 'unknown session: refresh the list' });
      return read(res, f.provider, f.file, adapters.parserOf(f.provider));
    }
    sendJson(res, 404, { error: 'unknown route' });
  };
}
