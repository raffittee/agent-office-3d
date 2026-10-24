// Ported from habblaud server/messages/http.ts (MIT, © 2026 Márcio Junior)
// Message routes (P7-04). The gate (interactive features on, loopback Host) is in http/app.ts; the edge guard
// already required JSON and a local Origin on POSTs.
//
//   POST /api/messages        (page)        {agentId, text}: 201 OutboxMessage | 400 | 404 | 409 | 429
//   GET  /api/messages/:id    (page)        the message's status: 200 OutboxMessage | 404
//   POST /api/inbox           (plugin, SDK) {provider, session}: 200 {messages: InboxMessage[]} (marks presence)
//   POST /api/inbox/ack       (plugin, SDK) {provider, session, results: [{id, ok, error?}]}: 200 {ok: true}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { InvalidRequest, MAX_OPEN, type MessageRegistry } from './registry';

const ITEM = /^\/api\/messages\/([^/]+)$/;

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: 'method not allowed' });
}

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
  else if (err instanceof InvalidRequest) sendJson(res, 400, { error: err.message });
  else sendJson(res, 500, { error: 'internal error' });
}

export function createMessageRoutes(registry: MessageRegistry): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const send = async (req: IncomingMessage, res: ServerResponse) => {
    const r = registry.send(await readJson(req));
    if ('message' in r) return sendJson(res, 201, r.message);
    switch (r.error) {
      case 'invalid':
        return sendJson(res, 400, { error: 'expected {agentId, text} with a non-empty text of up to 20,000 characters' });
      case 'not-found':
        return sendJson(res, 404, { error: 'unknown agent (it may have left the office)' });
      case 'unavailable':
        return sendJson(res, 409, { error: r.reason });
      case 'too-many':
        return sendJson(res, 429, { error: `${MAX_OPEN} messages already wait for delivery to this agent` });
    }
  };
  const inbox = async (req: IncomingMessage, res: ServerResponse) => sendJson(res, 200, { messages: registry.inbox(await readJson(req)) });
  const ack = async (req: IncomingMessage, res: ServerResponse) => {
    registry.ack(await readJson(req));
    sendJson(res, 200, { ok: true });
  };
  const post = (req: IncomingMessage, res: ServerResponse, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    if ((req.method ?? 'GET') !== 'POST') return methodNotAllowed(res, 'POST');
    handler(req, res).catch((err) => fail(res, err));
  };

  return (req, res, path) => {
    if (path === '/api/messages') return post(req, res, send);
    if (path === '/api/inbox') return post(req, res, inbox);
    if (path === '/api/inbox/ack') return post(req, res, ack);
    const m = ITEM.exec(path);
    if (!m) return sendJson(res, 404, { error: 'unknown route' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET');
    let id: string;
    try {
      id = decodeURIComponent(m[1]!);
    } catch {
      return sendJson(res, 400, { error: 'invalid id' });
    }
    const msg = registry.get(id);
    if (msg) sendJson(res, 200, msg);
    else sendJson(res, 404, { error: 'unknown message' });
  };
}
