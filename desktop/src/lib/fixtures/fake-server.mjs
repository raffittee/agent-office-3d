// A stand-in for dist/server/index.js in tests: answers /api/health like Agent Office and shuts down on the IPC
// message "shutdown" (as the real server does). FAKE_MODE=crash exits at once; FAKE_MODE=silent never listens.
import http from 'node:http';

const port = Number(process.env.AGENT_OFFICE_PORT);
if (process.env.FAKE_MODE === 'crash') {
  console.error('boom: cannot start');
  process.exit(3);
}
if (process.env.FAKE_MODE === 'silent') setInterval(() => {}, 1000);
else {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '9.9.9', demo: false, providers: [{ id: 'claude-code', label: 'Claude Code' }], sources: [] }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`fake server on ${port}`));
  process.on('message', (m) => {
    if (m === 'shutdown') server.close(() => process.exit(0));
  });
}
