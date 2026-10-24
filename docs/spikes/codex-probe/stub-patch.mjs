import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const log = process.argv[2];
let n = 0;
createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    appendFileSync(log, `--- ${req.url}\n${body.slice(0, 400000)}\n`);
    if (!req.url.includes('responses')) { res.writeHead(404); return res.end('{}'); }
    const j = JSON.parse(body);
    const tools = j.tools ?? [];
    const ap = tools.find((t) => t.name === 'apply_patch');
    const outs = (j.input ?? []).filter((i) => /output$/.test(i.type ?? ''));
    const patch = '*** Begin Patch\n*** Add File: notes.md\n+hello\n*** Update File: x.txt\n@@\n-a\n+A\n*** End Patch\n';
    let item;
    if (outs.length === 0 && ap) item = ap.type === 'custom' ? { type: 'custom_tool_call', id: `ctc_${++n}`, call_id: `call_p${n}`, name: 'apply_patch', input: patch, status: 'completed' } : { type: 'function_call', id: `fc_${++n}`, call_id: `call_p${n}`, name: 'apply_patch', arguments: JSON.stringify({ input: patch }), status: 'completed' };
    else if (outs.length === 1) item = { type: 'function_call', id: `fc_${++n}`, call_id: `call_q${n}`, name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Write notes', status: 'completed' }, { step: 'Review', status: 'in_progress' }] }), status: 'completed' };
    else item = { type: 'message', id: `msg_${++n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Patched. tools=${tools.map((t) => `${t.name ?? t.type}:${t.type}`).join(',')}`, annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of [{ type: 'response.created', response: { id: 'r' } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'r', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
}).listen(4892, '127.0.0.1');
