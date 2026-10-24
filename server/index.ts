// Agent Office server entry point.
//   npm run dev    -> tsx server/index.ts --dev (Vite in middleware mode, HMR on the same server)
//   npm start      -> node dist/server/index.js (serves dist/client)
import http from 'node:http';
import { join } from 'node:path';
import { AdapterSet } from './adapters/adapter';
import { ClaudeCodeAdapter } from './adapters/claude-code/adapter';
import { CodexAdapter } from './adapters/codex/adapter';
import { DemoAdapter } from './adapters/demo';
import { GeminiCliAdapter } from './adapters/gemini-cli/adapter';
import { interactive, loadConfig } from './config';
import { createApiHandler } from './http/app';
import { createRequestGuard } from './http/guard';
import { Hub } from './http/sse';
import { createStaticHandler } from './http/static';
import { createIngestHandler } from './ingest/ingest';
import { errMsg, log } from './log';
import { AccountsService, demoUsage } from './accounts/service';
import { NameStore } from './model/names';
import { Office } from '../shared/model/office';
import type { AgentInfo } from '../shared/protocol';
import { RoomAliases } from './model/room-aliases';
import { createCodexQueueRunner, findCodexBin } from './messages/codex';
import { createConversationRoutes } from './conversation/http';
import { createMessageRoutes } from './messages/http';
import { MessageRegistry } from './messages/registry';
import { createPermissionRoutes } from './permissions/http';
import { PermissionRegistry } from './permissions/registry';

/** How often agents' processes are checked (the Phase 1 exit asks for status changes within 2 s). */
const LIVENESS_MS = 2_000;

const config = loadConfig();

const names = new NameStore(join(config.dataDir, 'names.json'));
names.load();
const aliases = new RoomAliases(join(config.dataDir, 'rooms.json'));
aliases.load();

const demo = config.demo ? new DemoAdapter() : undefined;
const adapters = new AdapterSet([new ClaudeCodeAdapter({ inDocker: config.inDocker }), new GeminiCliAdapter({ home: config.home }), new CodexAdapter({ home: config.home }), ...(demo ? [demo] : [])]);
/** Provider badges: the running adapters, plus the ones only the demo simulates (Codex). */
const providers = () => (demo ? [...adapters.providers(), ...demo.extraProviders(adapters.providers())] : adapters.providers());

const accounts = new AccountsService({
  usageDir: join(config.dataDir, 'usage'),
  home: config.home,
  providers,
  accountsOf: (id) => adapters.accountsOf(id),
  ...(demo ? { extraUsage: demoUsage } : {}),
});

const interactiveOn = interactive(config);
if (config.interactiveRequested && !interactiveOn) log.warn(`interactive features stay off: ${config.host} is not a loopback address`);
// set once the office exists (the registry reads it, the office reads the registry)
let permissions: PermissionRegistry | null = null;
let messages: MessageRegistry | null = null;

const office = new Office({
  names,
  accounts: (sessions) => accounts.accounts(sessions),
  roomAlias: (path) => aliases.get(path),
  version: config.version,
  startedAt: Date.now(),
  sources: () => adapters.sources(),
  providers,
  demo: config.demo,
  ...(config.theme ? { theme: config.theme } : {}),
  ...(interactiveOn
    ? {
        interactive: true,
        permissions: () => permissions?.snapshot() ?? new Map(),
        onToolEnd: (id: string, tool: string, at: number) => permissions?.toolEnded(id, tool, at),
        canMessage: (a: AgentInfo) => messages?.canMessage(a) ?? false,
      }
    : {}),
});
await adapters.start(office);
const hub = new Hub(office);
hub.start();
if (interactiveOn) {
  permissions = new PermissionRegistry({ office, viewers: () => hub.size });
  permissions.start();
  const codexBin = findCodexBin(process.env);
  messages = new MessageRegistry({
    office,
    ...(codexBin ? { codex: { run: createCodexQueueRunner(codexBin), homeOf: (account: string) => adapters.accountsOf('codex').find((a) => a.id === account)?.dir } } : {}),
  });
  messages.start();
  log.info('interactive features on: permission requests and questions can be answered from the office');
}
const tick = setInterval(() => office.tick(), 250);
tick.unref();
const liveness = setInterval(() => adapters.checkLiveness(office), LIVENESS_MS);
liveness.unref();
// plan usage changes outside any event (a statusline tap, a token_count): refresh the accounts when it does
let usageKey = '';
const usageTimer = setInterval(() => {
  const key = accounts.usageKey();
  if (key !== usageKey) {
    usageKey = key;
    office.markDirty();
  }
}, 5_000);
usageTimer.unref();

const guard = createRequestGuard({ allowedHosts: config.allowedHosts });
const ingest = createIngestHandler({ apply: (e) => office.apply(e), hooks: (p) => adapters.hooks(p) });
const api = createApiHandler({
  office,
  hub,
  version: config.version,
  sources: () => adapters.sources(),
  providers,
  ingest,
  ...(permissions && messages
    ? (() => {
        const conversation = createConversationRoutes(office, adapters);
        return {
          actions: {
            '/api/permissions': createPermissionRoutes(permissions),
            '/api/messages': createMessageRoutes(messages),
            '/api/inbox': createMessageRoutes(messages),
            '/api/conversation': conversation,
            '/api/sessions': conversation,
          },
        };
      })()
    : {}),
});

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
  permissions?.stop();
  messages?.stop();
  adapters.stop();
  hub.stop();
  names.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
