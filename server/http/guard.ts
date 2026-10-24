// Ported from habblaud server/http/guard.ts (MIT, © 2026 Márcio Junior)
// Edge protections of the HTTP server (they cover the API, static files and Vite in dev mode).
//
// 1) DNS rebinding: a malicious site can make its own domain resolve to 127.0.0.1 and then read /api/snapshot "as
//    if same-origin". The browser sends the attacker's domain in the Host header, so only a Host that is a literal
//    IP, `localhost` (or `*.localhost`) or a name allowed in AGENT_OFFICE_ALLOWED_HOSTS is accepted.
// 2) CSRF: requests that change state (POST) need `Content-Type: application/json`, which a form or a "simple"
//    fetch from another site can't send without a CORS preflight this server never grants, and, when there is an
//    `Origin`, it must be same-origin or local.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';

/** Names allowed by AGENT_OFFICE_ALLOWED_HOSTS (comma-separated; ports are ignored). */
export function parseAllowedHosts(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const item of (raw ?? '').split(',')) {
    const name = hostnameOf(item.trim());
    if (name) out.add(name);
  }
  return out;
}

/** Host name (lower case, no port, no IPv6 brackets) of a Host header or `host[:port]`; undefined if invalid. */
export function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end < 0) return undefined;
    const rest = v.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return undefined;
    return v.slice(1, end);
  }
  const m = /^([a-z0-9._-]+)(?::\d{1,5})?$/.exec(v);
  return m ? m[1]!.replace(/\.$/, '') : undefined;
}

function isLoopbackName(name: string): boolean {
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name === '::1') return true;
  return isIP(name) === 4 && name.startsWith('127.');
}

/**
 * A local Host header (`localhost`, `*.localhost`, 127.x or `[::1]`; port ignored)? Features that act on sessions
 * (Phase 7) serve only whoever opened the office from this computer: a LAN IP or an allowed name (proxy, tunnel)
 * doesn't count. Missing or invalid: false.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  const name = hostnameOf(host);
  return !!name && isLoopbackName(name);
}

/**
 * Accepted Host? A literal IP (no DNS, so no rebinding), `localhost`/`*.localhost` (browsers always resolve it to
 * loopback) or a name from AGENT_OFFICE_ALLOWED_HOSTS. No Host header (HTTP/1.0, command-line tools): accepted,
 * browsers always send one.
 */
export function hostAllowed(host: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (host === undefined) return true;
  const name = hostnameOf(host);
  if (!name) return false;
  return isIP(name) !== 0 || isLoopbackName(name) || allowed.has(name);
}

/**
 * Accepted Origin for requests that change state: missing (curl, scripts, hook shims), same origin as the request's
 * Host, local (localhost/loopback) or a name from AGENT_OFFICE_ALLOWED_HOSTS.
 */
export function originAllowed(origin: string | undefined, host: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (host !== undefined && url.host.toLowerCase() === host.trim().toLowerCase()) return true;
  const name = hostnameOf(url.host);
  return !!name && (isLoopbackName(name) || allowed.has(name));
}

export function isJsonContentType(value: string | undefined): boolean {
  return !!value && /^application\/json\s*(;|$)/i.test(value.trim());
}

function reject(res: ServerResponse, status: number, message: string): void {
  const body = `${message}\n`;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export interface GuardOptions {
  /** Extra names accepted in Host/Origin (AGENT_OFFICE_ALLOWED_HOSTS). */
  allowedHosts?: ReadonlySet<string>;
}

/**
 * A filter for the start of every request: answers (and returns true) when the request must be refused; otherwise
 * returns false and leaves the response alone.
 */
export function createRequestGuard(opts: GuardOptions = {}): (req: IncomingMessage, res: ServerResponse) => boolean {
  const allowed = opts.allowedHosts ?? new Set<string>();
  return (req, res) => {
    const host = req.headers.host;
    if (!hostAllowed(host, allowed)) {
      reject(res, 403, `Host not allowed: ${String(host).slice(0, 100)}. Open Agent Office at http://localhost (or by IP) or allow the name in AGENT_OFFICE_ALLOWED_HOSTS.`);
      return true;
    }
    const method = req.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!originAllowed(origin, host, allowed)) {
      reject(res, 403, 'Origin not allowed.');
      return true;
    }
    const path = (req.url ?? '/').split('?')[0]!;
    if (path.startsWith('/api/') && !isJsonContentType(req.headers['content-type'])) {
      reject(res, 415, 'Send the body as JSON (Content-Type: application/json).');
      return true;
    }
    return false;
  };
}
