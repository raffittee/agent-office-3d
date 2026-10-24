// Agent Office server entry point.
//   npm run dev    -> tsx server/index.ts --dev (Vite in middleware mode, HMR on the same server)
//   npm start      -> node dist/server/index.js (serves dist/client)
import http from 'node:http';
import { join } from 'node:path';
import { AdapterSet } from './adapters/adapter';
import { ClaudeCodeAdapter } from './adapters/claude-code/adapter';
import { GeminiCliAdapter } from './adapters/gemini-cli/adapter';
import { loadConfig } from './config';
import { createApiHandler } from './http/app';
import { createRequestGuard } from './http/guard';
import { Hub } from './http/sse';
import { createStaticHandler } from './http/static';
import { createIngestHandler } from './ingest/ingest';
import { errMsg, log } from './log';
import { NameStore } from './model/names';
import { Office } from './model/office';
import { RoomAliases } from './model/room-aliases';

/** How often agents' processes are checked (the Phase 1 exit asks for status changes within 2 s). */
const LIVENESS_MS = 2_000;

const config = loadConfig();

const names = new NameStore(join(config.dataDir, 'names.json'));
names.load();
const aliases = new RoomAliases(join(config.dataDir, 'rooms.json'));
aliases.load();

const adapters = new AdapterSet([new ClaudeCodeAdapter({ inDocker: config.inDocker }), new GeminiCliAdapter({ home: config.home })]);

const office = new Office({
  names,
  roomAlias: (path) => aliases.get(path),
  version: config.version,
  startedAt: Date.now(),
  sources: () => adapters.sources(),
  providers: () => adapters.providers(),
});
await adapters.start(office);
const hub = new Hub(office);
hub.start();
const tick = setInterval(() => office.tick(), 250);
tick.unref();
const liveness = setInterval(() => adapters.checkLiveness(office), LIVENESS_MS);
liveness.unref();

const guard = createRequestGuard({ allowedHosts: config.allowedHosts });
const ingest = createIngestHandler({ apply: (e) => office.apply(e), hooks: (p) => adapters.hooks(p) });
const api = createApiHandler({ office, hub, version: config.version, sources: () => adapters.sources(), providers: () => adapters.providers(), ingest });

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => void;
let fallback: Handler = createStaticHandler(join(config.rootDir, 'dist', 'client'));

const server = http.createServer((req, res) => {
  if (guard(req, res)) return;
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://local');
  } catch {
    res.writeHead(400).end();
    return;
  }
  try {
    if (!api(req, res, url)) fallback(req, res, url.pathname);
  } catch (err) {
    log.error(`request failed: ${errMsg(err)}`);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

if (config.dev) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(config.rootDir, 'vite.config.ts'),
    server: { middlewareMode: true, ws: { server } },
  });
  fallback = (req, res) => vite.middlewares(req, res);
}

server.on('error', (err) => {
  log.error(`server error: ${errMsg(err)}`);
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  log.info(`Agent Office on http://${config.host}:${config.port}${config.dev ? ' (dev)' : ''}`);
});

function shutdown(): void {
  clearInterval(tick);
  clearInterval(liveness);
  adapters.stop();
  hub.stop();
  names.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
