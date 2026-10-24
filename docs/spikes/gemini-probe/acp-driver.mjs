// Throwaway P0-04 probe: drive `gemini --acp` over JSON-RPC (newline-delimited) to exercise tool approvals.
// Usage: node acp-driver.mjs <gemini.js> <transcript.jsonl> <decisions,comma,separated> <prompt> [<prompt2> ...]
// Each permission request takes the next decision: allow | deny.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const [geminiJs, logPath, decisionsCsv, ...prompts] = process.argv.slice(2);
const decisions = decisionsCsv.split(',');
const child = spawn(process.execPath, [geminiJs, '--acp'], { stdio: ['pipe', 'pipe', 'inherit'] });
const log = (dir, msg) => appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), dir, msg }) + '\n');

let nextId = 1;
const pending = new Map();
function request(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  log('out', msg);
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('raw', line); continue; }
    log('in', msg);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(msg.error) : p.resolve(msg.result);
    } else if (msg.method === 'session/request_permission') {
      const want = decisions.shift() ?? 'deny';
      const kinds = want === 'allow' ? ['allow_once'] : ['reject_once', 'reject_always'];
      const opt = msg.params.options.find((o) => kinds.includes(o.kind)) ?? msg.params.options.at(-1);
      const reply = { jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } };
      log('out', reply);
      setTimeout(() => child.stdin.write(JSON.stringify(reply) + '\n'), 1500); // leave a visible "waiting" gap
    } else if (msg.id !== undefined && msg.method) {
      const reply = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported by probe' } };
      log('out', reply);
      child.stdin.write(JSON.stringify(reply) + '\n');
    }
  }
});

try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  const { sessionId } = await request('session/new', { cwd: process.cwd(), mcpServers: [] });
  for (const text of prompts) {
    const r = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    console.log('prompt done:', JSON.stringify(r));
  }
} catch (e) {
  console.log('error:', JSON.stringify(e));
}
child.stdin.end();
setTimeout(() => { child.kill(); process.exit(0); }, 3000);
