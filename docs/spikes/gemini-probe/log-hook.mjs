// Throwaway P0-04 probe: append each raw hook stdin (plus process facts) to a JSONL file. Prints nothing, exits 0.
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const out = process.env.PROBE_LOG;
const t0 = Date.now();
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let parentOfParent = null;
  try {
    // Who is our parent (the shell) and its parent (hopefully gemini)?
    const q = `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.ppid}" | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress)`;
    if (process.platform === 'win32' && process.env.PROBE_PARENTS === '1') {
      parentOfParent = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', q], { encoding: 'utf8', timeout: 5000 }));
    }
  } catch (e) {
    parentOfParent = String(e);
  }
  const rec = {
    receivedAt: new Date(t0).toISOString(),
    ppid: process.ppid,
    pid: process.pid,
    parent: parentOfParent,
    argv: process.argv.slice(2),
    env: { GEMINI_SESSION_ID: process.env.GEMINI_SESSION_ID, GEMINI_CWD: process.env.GEMINI_CWD, GEMINI_PROJECT_DIR: process.env.GEMINI_PROJECT_DIR },
    stdinBytes: Buffer.byteLength(raw),
    payload: (() => { try { return JSON.parse(raw); } catch { return raw; } })(),
  };
  try { if (out) appendFileSync(out, JSON.stringify(rec) + '\n'); } catch {}
  process.exit(0);
});
