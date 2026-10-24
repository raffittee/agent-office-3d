// Scenario stub (Responses API). Main thread: write a file → background job → poll it → spawn a subagent → wait →
// an escalated command (approval) → final message. The subagent (its prompt has SUBTASK): one command, then a reply.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const log = process.argv[2];
const port = Number(process.argv[3] ?? 4891);
let n = 0;
const fc = (name, args, ns) => ({ type: 'function_call', id: `fc_${++n}`, call_id: `call_${n}`, name, ...(ns ? { namespace: ns } : {}), arguments: JSON.stringify(args), status: 'completed' });
const msg = (text) => ({ type: 'message', id: `msg_${++n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    appendFileSync(log, `--- ${req.method} ${req.url}\n${body.slice(0, 400000)}\n`);
    if (!req.url.includes('responses')) { res.writeHead(404); return res.end('{}'); }
    let j = {};
    try { j = JSON.parse(body); } catch {}
    const input = j.input ?? [];
    const text = JSON.stringify(input);
    const outs = input.filter((i) => i.type === 'function_call_output' || i.type === 'custom_tool_call_output');
    const last = outs[outs.length - 1];
    const child = text.includes('SUBTASK') && !text.includes('spawn_agent');
    let item;
    if (child) item = outs.length === 0 ? fc('exec_command', { cmd: 'ls | wc -l' }) : msg('There are 3 files.');
    else {
      const step = outs.length;
      if (step === 0) item = fc('exec_command', { cmd: 'echo hello > b.txt' });
      else if (step === 1) item = fc('exec_command', { cmd: 'sleep 3; echo built', yield_time_ms: 250 });
      else if (step === 2) {
        const m = /session ID (\d+)/i.exec(last?.output ?? '') ?? /"session_id":\s*(\d+)/.exec(last?.output ?? '');
        item = m ? fc('write_stdin', { session_id: Number(m[1]), chars: '', yield_time_ms: 5000 }) : fc('exec_command', { cmd: 'true' });
      } else if (step === 3) item = fc('spawn_agent', { message: 'SUBTASK: count the files in this folder' }, 'multi_agent_v1');
      else if (step === 4) {
        const m = /"(?:agent_id|id)":\s*"([^"]+)"/.exec(last?.output ?? '');
        item = fc('wait_agent', { targets: [m ? m[1] : 'unknown'], timeout_ms: 20000 }, 'multi_agent_v1');
      } else if (step === 5) item = fc('exec_command', { cmd: 'touch /etc/agent-office-probe', sandbox_permissions: 'require_escalated', justification: 'Write outside the project?' });
      else item = msg('All done.');
    }
    const usage = { input_tokens: 1500, input_tokens_details: { cached_tokens: 300 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 1550 };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of [
      { type: 'response.created', response: { id: `r${n}` } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `r${n}`, usage } },
    ])
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
}).listen(port, '127.0.0.1');
