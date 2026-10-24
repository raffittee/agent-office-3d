// OTLP/HTTP capture receiver (P5-05 spike): appends every request body (JSON or protobuf, as base64) to a file.
//   node docs/spikes/otlp/receiver.mjs <out.jsonl> [port=4318]
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const [out, port = '4318'] = process.argv.slice(2);
createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    const type = String(req.headers['content-type'] ?? '');
    const body = type.includes('json') ? buf.toString('utf8') : buf.toString('base64');
    appendFileSync(out, `${JSON.stringify({ at: Date.now(), path: req.url, type, bytes: buf.length, body })}\n`);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
}).listen(Number(port), '127.0.0.1');
