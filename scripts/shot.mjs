#!/usr/bin/env node
// Screenshot smoke test (P2-11): starts the built server on a free port, opens the demo office in Chromium
// (playwright-core), waits for the scene, saves screenshots and fails on page errors or an empty scene.
//
//   npm run build && npm run shot [-- --out artifacts --sessions 8 --seed 7] [--themes] [--thumbs]
//
// --themes also switches live to every theme pack and saves theme-<id>.png (P4-02: no page errors, state kept).
// --thumbs writes each theme's picker thumbnail to themes/<id>/thumb.png (run after changing a built-in theme).
//
// Browser: $CHROME_PATH if set, else the installed Chrome ("chrome" channel), else Playwright's own Chromium.
// Software WebGL (SwiftShader) is fine: this checks that the office renders, not how fast.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const out = resolve(root, arg('out', 'artifacts'));
const sessions = Number(arg('sessions', '8'));
const seed = Number(arg('seed', '7'));
const allThemes = args.includes('--themes') || args.includes('--thumbs');
const thumbs = args.includes('--thumbs');

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function launch() {
  const flags = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  if (process.env.CHROME_PATH) return chromium.launch({ executablePath: process.env.CHROME_PATH, args: flags });
  try {
    return await chromium.launch({ channel: 'chrome', args: flags });
  } catch {
    return chromium.launch({ args: flags });
  }
}

async function main() {
  mkdirSync(out, { recursive: true });
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), 'agent-office-shot-'));
  const server = spawn(process.execPath, [join(root, 'dist/server/index.js')], {
    env: { ...process.env, AGENT_OFFICE_PORT: String(port), AGENT_OFFICE_DATA_DIR: data, AGENT_OFFICE_CLAUDE_DIRS: join(data, 'none') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  const browser = await launch();
  const errors = [];
  try {
    // wait for the server
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) break;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
    await page.goto(`http://127.0.0.1:${port}/?mock=1&seed=${seed}&sessions=${sessions}`);
    await page.waitForFunction(() => window.agentOffice?.world?.stats().agents > 0, null, { timeout: 30_000 });
    await page.waitForTimeout(6000);
    const overview = await page.evaluate(() => window.agentOffice.world.stats());
    await page.screenshot({ path: join(out, 'office.png') });
    // a selected agent, with its drawer
    await page.click('.ui-agent');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(out, 'selected.png') });
    const drawer = await page.isVisible('.ui-drawer');
    const themes = {};
    if (allThemes) {
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.agentOffice.world.overview());
      const ids = await page.evaluate(() => window.agentOffice.themes().map((t) => t.look.id));
      for (const id of ids) {
        const agents = await page.evaluate(() => window.agentOffice.world.stats().agents);
        await page.evaluate((theme) => window.agentOffice.world.setOptions({ theme }), id);
        await page.waitForTimeout(3500);
        const stats = await page.evaluate(() => window.agentOffice.world.stats());
        themes[id] = { calls: stats.calls, triangles: stats.triangles, agents: stats.agents, keptAgents: stats.agents >= agents };
        await page.screenshot({ path: join(out, `theme-${id}.png`) });
        if (thumbs) {
          await page.evaluate(() => document.getElementById('ui').style.setProperty('visibility', 'hidden'));
          await page.evaluate(() => document.getElementById('labels').style.setProperty('visibility', 'hidden'));
          await page.screenshot({ path: join(root, 'themes', id, 'thumb.png'), clip: { x: 400, y: 170, width: 800, height: 500 }, scale: 'css' });
          await page.evaluate(() => document.getElementById('ui').style.removeProperty('visibility'));
          await page.evaluate(() => document.getElementById('labels').style.removeProperty('visibility'));
        }
      }
    }
    const result = { overview, drawer, themes, errors };
    writeFileSync(join(out, 'shot.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
    const problems = [];
    if (errors.length) problems.push('page errors');
    if (!overview.agents || !overview.rooms) problems.push('empty scene');
    if (overview.calls > 300) problems.push(`${overview.calls} draw calls (budget 300)`);
    if (!drawer) problems.push('the details drawer did not open');
    for (const [id, t] of Object.entries(themes)) {
      if (t.calls > 300) problems.push(`${id}: ${t.calls} draw calls (budget 300)`);
      if (!t.keptAgents) problems.push(`${id}: agents lost on the theme switch`);
    }
    if (problems.length) throw new Error(problems.join(', '));
    console.log(`screenshots in ${out}`);
  } finally {
    await browser.close();
    server.kill();
    rmSync(data, { recursive: true, force: true });
    if (process.exitCode) console.error(serverLog.slice(-2000));
  }
}

main().catch((err) => {
  console.error(`shot: ${err.message}`);
  process.exitCode = 1;
});
