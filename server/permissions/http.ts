// Ported from habblaud server/permissions/http.ts (MIT, © 2026 Márcio Junior)
// /api/permissions routes (P7-01). The edge guard (http/guard.ts) already required JSON and a local Origin on POSTs;
// these routes also need the interactive features on (a local bind, AGENT_OFFICE_INTERACTIVE) and a loopback Host.
//
//   POST /api/permissions                 (hook)  registers a request: 201 {id, expiresAt} or 200 {skip}
//   GET  /api/permissions/:id/wait        (hook)  long-poll: {status: pending | decided | released}
//   GET  /api/permissions/:id             (page)  the detail, with the arguments (command, diff…)
//   POST /api/permissions/:id/decision    (page)  {behavior: allow | deny | terminal | answer, message?, answers?, …}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { InvalidRequest, parseDecision, WAIT_MAX_MS, type PermissionRegistry } from './registry';

const ITEM = /^\/api\/permissions\/([^/]+)(?:\/(wait|decision))?$/;

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

/** The wait asked in `?timeout=` (seconds), capped at WAIT_MAX_MS. */
export function waitMs(url: URL): number {
  const raw = Number(url.searchParams.get('timeout'));
  if (!Number.isFinite(raw) || raw <= 0) return WAIT_MAX_MS;
  return Math.min(WAIT_MAX_MS, Math.max(50, raw * 1_000));
}

export function createPermissionRoutes(registry: PermissionRegistry): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const register = async (req: IncomingMessage, res: ServerResponse) => {
    const r = registry.register(await readJson(req));
    if ('skip' in r) sendJson(res, 200, { skip: r.skip });
    else sendJson(res, 201, r);
  };

  const wait = (req: IncomingMessage, res: ServerResponse, id: string) => {
    const w = registry.wait(id, waitMs(new URL(req.url ?? '/', 'http://localhost')));
    if (!w) return sendJson(res, 404, { error: 'unknown request' });
    req.socket.setTimeout(0);
    // the connection closed before the answer (the hook died or gave up): drop the wait
    res.on('close', () => {
      if (!res.writableEnded) w.cancel();
    });
    w.result.then(
      (result) => {
        if (!res.destroyed && !res.writableEnded) sendJson(res, 200, result);
      },
      (err) => fail(res, err),
    );
  };

  const decide = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    const d = parseDecision(await readJson(req));
    if (!d) throw new HttpError(400, 'expected {behavior: "allow" | "deny" | "terminal", message?, interrupt?, suggestion?} or {behavior: "answer", answers: [{question, options?, other?}]}');
    switch (registry.decide(id, d)) {
      case 'ok':
        return sendJson(res, 200, { ok: true });
      case 'not-found':
        return sendJson(res, 404, { error: 'unknown request: already answered, expired or answered in the terminal' });
      case 'conflict':
        return sendJson(res, 409, { error: 'this request was already answered' });
      case 'invalid':
        return sendJson(res, 400, { error: 'unknown rule suggestion for this request' });
      case 'invalid-answer':
        return sendJson(res, 400, { error: 'this decision does not fit the request: questions take "answer" (each question once, with its options); the others "allow" or "deny"' });
    }
  };

  return (req, res, path) => {
    const method = req.method ?? 'GET';
    if (path === '/api/permissions') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      register(req, res).catch((err) => fail(res, err));
      return;
    }
    const m = ITEM.exec(path);
    if (!m) return sendJson(res, 404, { error: 'unknown route' });
    let id: string;
    try {
      id = decodeURIComponent(m[1]!);
    } catch {
      return sendJson(res, 400, { error: 'invalid id' });
    }
    if (m[2] === 'wait') {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      return wait(req, res, id);
    }
    if (m[2] === 'decision') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      decide(req, res, id).catch((err) => fail(res, err));
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET');
    const detail = registry.detail(id);
    if (detail) sendJson(res, 200, detail);
    else sendJson(res, 404, { error: 'unknown request' });
  };
}
