// Ported from habblaud server/http/app.ts (MIT, © 2026 Márcio Junior)
// API routes (/api/*). JSON responses; unknown routes → 404 JSON. Ingest routes (POST /api/events,
// /api/hooks/:provider) are plugged in by deps.ingest (P1-06).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProviderMeta, SourceInfo } from '../../shared/protocol';
import type { Office } from '../../shared/model/office';
import { isJsonContentType, isLoopbackHost } from './guard';
import type { Hub } from './sse';

export interface ApiDeps {
  office: Office;
  hub: Hub;
  version: string;
  sources: () => SourceInfo[];
  providers: () => ProviderMeta[];
  demo?: () => boolean;
  /** Ingest routes; returns false for paths it doesn't own. */
  ingest?: (req: IncomingMessage, res: ServerResponse, path: string) => boolean;
  /**
   * Session-touching routes (P7: /api/permissions…), keyed by path prefix. Present only with the interactive features
   * on; each request must also come with a loopback Host (local-only, whatever names are allow-listed).
   */
  actions?: Record<string, (req: IncomingMessage, res: ServerResponse, path: string) => void>;
}

/** Path prefixes of the session-touching routes: answered 403 while the interactive features are off. */
export const ACTION_PREFIXES = ['/api/permissions', '/api/messages', '/api/inbox'];

export const MAX_BODY = 256 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // The API is read only by our own page: no "no-cors" reads by other origins.
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(data);
}

/** Reads a JSON body. Requires `Content-Type: application/json` (the CSRF barrier; see guard.ts). */
export function readJson(req: IncomingMessage, max = MAX_BODY): Promise<unknown> {
  if (!isJsonContentType(req.headers['content-type'])) {
    req.resume();
    return Promise.reject(new HttpError(415, 'send the body as JSON (Content-Type: application/json)'));
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    req.resume();
    return Promise.reject(new HttpError(413, 'body too large'));
  }
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Too large: keep draining (without keeping it) so a 413 can be answered.
      if (size > max) return void fail(new HttpError(413, 'body too large'));
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > max) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return ok({});
      try {
        ok(JSON.parse(raw));
      } catch {
        fail(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', fail);
  });
}

/** Sends an HttpError (or a 500 for anything else) as JSON. */
export function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
  else sendJson(res, 500, { error: 'internal error' });
}

/** Returns a handler for /api/* that answers false for everything else. */
export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const { office, hub } = deps;
  const methodNotAllowed = (res: ServerResponse, allow: string) => {
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: 'method not allowed' });
  };
  const readOnly = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    methodNotAllowed(res, 'GET, HEAD');
    return false;
  };

  return (req, res, url) => {
    const path = url.pathname;
    if (!path.startsWith('/api/')) return false;

    if (deps.ingest?.(req, res, path)) return true;

    const prefix = ACTION_PREFIXES.find((p) => path === p || path.startsWith(`${p}/`));
    if (prefix) {
      const route = deps.actions?.[prefix];
      if (!route) {
        req.resume();
        sendJson(res, 403, { error: 'the interactive features are off (start with AGENT_OFFICE_INTERACTIVE=1 on a local bind)' });
      } else if (!isLoopbackHost(req.headers.host)) {
        req.resume();
        sendJson(res, 403, { error: 'interactive routes answer only on localhost' });
      } else route(req, res, path);
      return true;
    }

    if (path === '/api/stream') {
      if (readOnly(req, res)) hub.attach(req, res);
      return true;
    }
    if (path === '/api/snapshot') {
      if (readOnly(req, res)) sendJson(res, 200, hub.current());
      return true;
    }
    if (path === '/api/health') {
      if (readOnly(req, res)) {
        sendJson(res, 200, {
          ok: true,
          version: deps.version,
          demo: deps.demo?.() ?? false,
          providers: deps.providers().map((p) => ({ id: p.id, label: p.label })),
          sources: deps.sources().map((s) => ({ provider: s.provider, label: s.label, ok: s.ok, sessions: s.sessions, ...(s.error ? { error: s.error } : {}) })),
        });
      }
      return true;
    }
    if (path.startsWith('/api/agents/')) {
      if (!readOnly(req, res)) return true;
      let id: string;
      try {
        id = decodeURIComponent(path.slice('/api/agents/'.length));
      } catch {
        sendJson(res, 400, { error: 'invalid agent id' });
        return true;
      }
      const detail = id && !id.includes('/') ? office.detail(id) : undefined;
      if (!detail) sendJson(res, 404, { error: 'unknown agent' });
      else sendJson(res, 200, detail);
      return true;
    }
    req.resume();
    sendJson(res, 404, { error: 'unknown route' });
    return true;
  };
}
