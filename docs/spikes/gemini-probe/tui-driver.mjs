// Throwaway P0-04 probe: drive the interactive Gemini TUI through a pseudo-terminal.
// Usage: node tui-driver.mjs <node-pty dir> <gemini.js> <screen.log> <steps.json>
// steps: [{ "wait": "<regex>", "send": "<text>", "delay": ms }]; "\r" = Enter, "\u001b" = Esc.
import { createRequire } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';

const [ptyDir, geminiJs, screenLog, stepsPath] = process.argv.slice(2);
const pty = createRequire(import.meta.url)(ptyDir);
const steps = JSON.parse(readFileSync(stepsPath, 'utf8'));

const term = pty.spawn(process.execPath, [geminiJs], { name: 'xterm-256color', cols: 140, rows: 45, cwd: process.cwd(), env: process.env });
let screen = '';
const strip = (s) => s.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\u001b[\]P^_][^\u0007\u001b]*(\u0007|\u001b\\)/g, '').replace(/\u001b./g, '');
term.onData((d) => {
  const t = strip(d);
  screen += t;
  if (screen.length > 200000) screen = screen.slice(-100000);
  appendFileSync(screenLog, t);
});
term.onExit(({ exitCode }) => { console.log('gemini exited', exitCode); process.exit(0); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [n, step] of steps.entries()) {
  if (step.wait) {
    const re = new RegExp(step.wait, 'i');
    const start = Date.now();
    let mark = screen.length - 4000;
    while (!re.test(screen.slice(Math.max(0, step.fresh ? mark : 0)))) {
      if (Date.now() - start > (step.timeout ?? 60000)) { console.log(`step ${n}: timed out waiting for /${step.wait}/`); break; }
      await sleep(200);
    }
  }
  await sleep(step.delay ?? 500);
  appendFileSync(screenLog, `\n<<<PROBE step ${n}: send ${JSON.stringify(step.send)}>>>\n`);
  console.log(`step ${n}: send ${JSON.stringify(step.send)}`);
  if (step.send !== undefined) for (const ch of step.send.match(/\u001b|\r|[^\u001b\r]+/g) ?? []) { term.write(ch); await sleep(60); }
  screen = ''; // later waits look only at new output
}
await sleep(5000);
term.kill();
process.exit(0);
