// P7-03 probe: answers BeforeTool with the decision in $DECISION and logs what it saw.
import { appendFileSync } from 'node:fs';
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let ev = {};
  try { ev = JSON.parse(raw); } catch {}
  appendFileSync(process.env.PROBE_LOG, JSON.stringify({ at: Date.now(), event: ev.hook_event_name, tool: ev.tool_name, decision: process.env.DECISION }) + '\n');
  if (ev.hook_event_name === 'BeforeTool' && ev.tool_name === 'run_shell_command') process.stdout.write(JSON.stringify({ decision: process.env.DECISION, reason: 'decided by the Agent Office probe' }));
  process.exit(0);
});
