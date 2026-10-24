// Ported from habblaud server/http/static.ts (MIT, © 2026 Márcio Junior)
// The built client (dist/client) in production, with an SPA fallback.
//
// Caching:
// - /bundle/* are Vite's hashed files (build.assetsDir = 'bundle'): their content never changes, so they are cached
//   for a year (immutable);
// - everything else (index.html and client/public) has a fixed name and may change on every build: `no-cache` +
//   ETag/Last-Modified, and the browser revalidates (304).
import { createReadStream, statSync, type Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

/** Folder of Vite's hashed files (same as `build.assetsDir` in vite.config.ts). */
export const HASHED_DIR = '/bundle/';
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const REVALIDATE = 'no-cache';

function fileStat(p: string): Stats | undefined {
  try {
    const st = statSync(p);
    return st.isFile() ? st : undefined;
  } catch {
    return undefined;
  }
}

/** Weak ETag from size and modification time (cheap and stable across restarts). */
export function etagOf(st: Pick<Stats, 'size' | 'mtimeMs'>): string {
  return `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

/** Is the browser's copy still good? (If-None-Match wins over If-Modified-Since.) */
export function isNotModified(req: IncomingMessage, etag: string, mtimeMs: number): boolean {
  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string' && inm.trim()) {
    const strip = (s: string) => s.trim().replace(/^W\//, '');
    const want = strip(etag);
    return inm.split(',').some((s) => s.trim() === '*' || strip(s) === want);
  }
  const ims = req.headers['if-modified-since'];
  if (typeof ims === 'string' && ims.trim()) {
    const since = Date.parse(ims);
    // Last-Modified has a resolution of seconds.
    return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

/**
 * The pages' Content-Security-Policy (P8-01): only our own scripts, styles (inline ones: the overlay injects its
 * stylesheet), WebAssembly (the meshopt decoder), images from data:/blob: URLs (glTF textures), connections to this
 * server only, and no framing, plugins or base-URL tricks. Production only: Vite's dev server injects inline scripts.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function createStaticHandler(distDir: string): (req: IncomingMessage, res: ServerResponse, pathname: string) => void {
  const root = resolve(distDir);
  const index = join(root, 'index.html');

  const send = (req: IncomingMessage, res: ServerResponse, file: string, st: Stats, cache: string) => {
    const etag = etagOf(st);
    const headers: Record<string, string | number> = {
      'Cache-Control': cache,
      ETag: etag,
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      'X-Content-Type-Options': 'nosniff',
      // The page must not be framed by other sites (clickjacking).
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    };
    if (extname(file).toLowerCase() === '.html') headers['Content-Security-Policy'] = CSP;
    if (isNotModified(req, etag, st.mtimeMs)) {
      res.writeHead(304, headers);
      return void res.end();
    }
    res.writeHead(200, {
      ...headers,
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': st.size,
    });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  };

  return (req, res, pathname) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      return void res.end('Method not allowed');
    }
    const indexStat = fileStat(index);
    if (!indexStat) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return void res.end('The client is not built. Run "npm run build" (or use "npm run dev").');
    }
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return void res.end('Invalid path');
    }
    const file = resolve(root, `.${rel}`);
    const inside = file === root || file.startsWith(root + sep);
    const st = inside && file !== root ? fileStat(file) : undefined;
    if (st) return send(req, res, file, st, rel.startsWith(HASHED_DIR) ? IMMUTABLE : REVALIDATE);
    if (rel.startsWith('/assets/') || rel.startsWith(HASHED_DIR)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return void res.end('Not found');
    }
    // SPA: any other route serves index.html.
    send(req, res, index, indexStat, REVALIDATE);
  };
}
