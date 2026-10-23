// Agent Office server entry point.
//   npm run dev    -> tsx server/index.ts --dev (Vite in middleware mode, HMR on the same server)
//   npm start      -> node dist/server/index.js
// Skeleton only: /api/health. Snapshot, SSE, static files and the edge guard land in P1-05.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config';

const config = loadConfig();

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let fallback: Handler = (_req, res) => {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end('not found');
};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  fallback(req, res);
});

if (config.dev) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    server: { middlewareMode: true, ws: { server } },
  });
  fallback = (req, res) => vite.middlewares(req, res);
}

server.listen(config.port, config.host, () => {
  console.log(`Agent Office on http://${config.host}:${config.port}${config.dev ? ' (dev)' : ''}`);
});
