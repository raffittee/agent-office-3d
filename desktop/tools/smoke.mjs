// Smoke test of the packaged desktop app (CI, Windows):
//   node desktop/tools/smoke.mjs <path to Agent Office.exe> [--out <dir for screenshots>]
// Starts the app against a throwaway data folder in demo mode, drives its window over the DevTools protocol, and checks
// that the server came up, the page has the shell bridge, widget mode works, the window can't be turned into a browser,
// and the integrations can be listed. The tray can't be driven from here (that part is checked by hand).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const exe = process.argv[2] ? resolve(process.argv[2]) : null;
const outIndex = process.argv.indexOf('--out');
const out = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : null;
if (!exe || !existsSync(exe)) {
  console.error('Usage: node desktop/tools/smoke.mjs <path to Agent Office.exe> [--out <dir>]');
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { chromium } = createRequire(join(root, 'package.json'))('playwright-core');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const win = process.platform === 'win32';
const checks = [];

function check(name, ok, detail = '') {
  checks.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}
async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const data = mkdtempSync(join(tmpdir(), 'ao-desktop-'));
if (out) mkdirSync(out, { recursive: true });
const port = await freePort();
const debugPort = await freePort();
let app = null;
let browser = null;
const log = [];

try {
  app = spawn(exe, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(data, 'user')}`, '--use-angle=swiftshader', '--ignore-gpu-blocklist'], {
    env: { ...process.env, HOME: data, USERPROFILE: data, AGENT_OFFICE_DATA_DIR: join(data, 'office'), AGENT_OFFICE_DEMO: '1', AGENT_OFFICE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  app.stdout.on('data', (d) => log.push(String(d)));
  app.stderr.on('data', (d) => log.push(String(d)));
  let exited = null;
  app.once('exit', (code) => (exited = code));

  const h = await until('the server', async () => (exited !== null ? Promise.reject(new Error(`the app exited with ${exited}`)) : health(port)), 60_000);
  check('the app started its server', h.ok === true);
  check('it runs the bundled version', h.version === version, `${h.version} vs ${version}`);
  check('demo mode reached the server', h.demo === true);

  browser = await until('the DevTools port', () => chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`), 30_000);
  const pageOf = async (needle) =>
    until(`a page with ${needle}`, async () => {
      for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().includes(needle)) return p;
      return null;
    });

  // ---- window mode
  let page = await pageOf(`127.0.0.1:${port}/?shell=desktop&mode=window`);
  await page.waitForFunction(() => !!window.agentOfficeShell && !!window.agentOffice, null, { timeout: 30_000 });
  check('the page has the shell bridge', true);
  const state = await page.evaluate(() => window.agentOfficeShell.getState());
  check('the shell reports window mode and the version', state?.mode === 'window' && state?.version === version, JSON.stringify(state));
  check('the page has no Node access', await page.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined'));
  await page.waitForFunction(() => (window.agentOffice.store.snapshot?.agents.length ?? 0) > 0, null, { timeout: 30_000 });
  check('demo agents reach the page', true);
  await page.waitForTimeout(1500);
  if (out) await page.screenshot({ path: join(out, 'desktop-window.png') });
  const top = await page.evaluate(() => getComputedStyle(document.querySelector('.ui-topbar')).display);
  check('the top bar is shown in window mode', top !== 'none');

  // the page can't be sent anywhere else
  await page.evaluate(() => {
    location.href = 'file:///C:/Windows/win.ini';
  });
  await page.waitForTimeout(800);
  check('a navigation away from the app is blocked', page.url().startsWith(`http://127.0.0.1:${port}/`), page.url());

  const info = await page.evaluate(() => window.agentOfficeShell.integrations());
  check('the integrations can be listed', Array.isArray(info?.items) && info.items.length === 4, JSON.stringify(info));
  check('the integrations check finds Node', info?.node?.ok === true, info?.node?.message);

  // ---- widget mode
  // the window is replaced, so the page that asks goes away before it can see an answer
  await page.evaluate(() => void window.agentOfficeShell.setMode('widget')).catch(() => {});
  page = await pageOf('mode=widget');
  await page.waitForFunction(() => document.documentElement.classList.contains('shell-widget'), null, { timeout: 30_000 });
  check('widget mode swaps the panels for one bar', await page.evaluate(() => !!document.querySelector('.ui-shellbar') && getComputedStyle(document.querySelector('.ui-topbar')).display === 'none'));
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  check('the widget is small', size.w <= 600 && size.h <= 450, JSON.stringify(size));
  await page.waitForFunction(() => (window.agentOffice.store.snapshot?.agents.length ?? 0) > 0, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  if (out) await page.screenshot({ path: join(out, 'desktop-widget.png') });
  const wstate = await page.evaluate(() => window.agentOfficeShell.getState());
  check('the shell reports widget mode, kept on top', wstate?.mode === 'widget' && wstate?.pinned === true, JSON.stringify(wstate));

  // ---- back, so the saved mode isn't left on widget for the next run, then quit with the whole process tree
  await page.evaluate(() => void window.agentOfficeShell.setMode('window')).catch(() => {});
  await pageOf('mode=window');
  check('it can switch back to the window', true);
} catch (err) {
  check('smoke test ran to the end', false, `${err instanceof Error ? err.message : String(err)}\n--- app output ---\n${log.join('').slice(-1500)}`);
} finally {
  try {
    await browser?.close();
  } catch {
    // already gone
  }
  if (app?.pid) {
    if (win) spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    else app.kill('SIGKILL');
  }
  await sleep(1500);
  check('the server went away with the app', (await health(port)) === null);
  rmSync(data, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} of ${checks.length} checks failed.` : `\nAll ${checks.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
