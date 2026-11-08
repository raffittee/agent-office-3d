#!/usr/bin/env node
// Screenshot smoke test (P2-11): starts the built server on a free port, opens the demo office in Chromium
// (playwright-core), waits for the scene, saves screenshots and fails on page errors or an empty scene.
//
//   npm run build && npm run shot [-- --out artifacts --sessions 8 --seed 7 --hour 22:30] [--themes] [--thumbs] [--golden]
//
// --golden (P10-19) shoots the office at 08:00, 13:30, 18:30 and 22:30 with the panels hidden (golden-<hhmm>.png) and
// checks the mean brightness of the building: day is bright, and night, dusk and morning stay readable.

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
const hour = arg('hour', '');
const allThemes = args.includes('--themes') || args.includes('--thumbs');
const thumbs = args.includes('--thumbs');
const golden = args.includes('--golden');
/** Hours of the golden shots, and the lowest mean brightness (0..255, of the building's own pixels) each must have. */
const GOLDEN = [
  ['08:00', 140],
  ['13:30', 140],
  ['18:30', 90],
  ['22:30', 55],
];

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
    await page.goto(`http://127.0.0.1:${port}/?mock=1&seed=${seed}&sessions=${sessions}${hour ? `&hour=${encodeURIComponent(hour)}` : ''}`);
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
    // the theme preview page (P4-10): every kind of the example pack, its models included
    let preview = null;
    if (allThemes) {
      const pv = await browser.newPage({ viewport: { width: 1600, height: 900 } });
      pv.on('pageerror', (e) => errors.push(`preview pageerror: ${e.message}`));
      pv.on('console', (m) => m.type() === 'error' && errors.push(`preview console: ${m.text()}`));
      await pv.goto(`http://127.0.0.1:${port}/preview.html?theme=cabin`);
      await pv.waitForFunction(() => document.querySelectorAll('.pv-label.is-model').length > 0, null, { timeout: 30_000 }).catch(() => errors.push('preview: the example models did not load'));
      await pv.waitForTimeout(1000);
      preview = await pv.evaluate(() => ({ labels: document.querySelectorAll('.pv-label').length, models: document.querySelectorAll('.pv-label.is-model').length }));
      await pv.screenshot({ path: join(out, 'preview.png') });
      await pv.close();
    }
    // golden shots (P10-19): each hour on a fresh page, panels hidden, mean brightness of the building measured
    const goldenStats = {};
    if (golden) {
      await page.close(); // the software renderer is slow: don't let this page compete for it
      for (const [h] of GOLDEN) {
        const gp = await browser.newPage({ viewport: { width: 1600, height: 900 } });
        gp.on('pageerror', (e) => errors.push(`golden ${h} pageerror: ${e.message}`));
        await gp.goto(`http://127.0.0.1:${port}/?mock=1&seed=${seed}&sessions=${sessions}&hour=${encodeURIComponent(h)}`);
        await gp.waitForFunction(() => window.agentOffice?.world?.stats().agents > 0, null, { timeout: 30_000 });
        await gp.evaluate(() => {
          document.getElementById('ui').style.visibility = 'hidden';
          document.getElementById('labels').style.visibility = 'hidden';
        });
        await gp.waitForTimeout(6000);
        const png = await gp.screenshot({ path: join(out, `golden-${h.replace(':', '')}.png`) });
        goldenStats[h] = await gp.evaluate(async (b64) => {
          const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
          c.drawImage(bmp, 0, 0);
          const d = c.getImageData(0, 0, bmp.width, bmp.height).data;
          // the sky is the background: it's the most common color along the top edge, so skip pixels close to it
          const key = (i) => `${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`;
          const sky = new Set();
          for (let x = 0; x < bmp.width; x += 7) for (const y of [2, 40, 80]) sky.add(key((y * bmp.width + x) * 4));
          let sum = 0;
          let n = 0;
          for (let i = 0; i < d.length; i += 16) {
            if (sky.has(key(i))) continue;
            sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            n++;
          }
          return { mean: n ? Math.round(sum / n) : 0, share: Math.round((n * 400) / (d.length / 4)) / 100 };
        }, png.toString('base64'));
        await gp.close();
      }
    }
    const result = { overview, drawer, themes, preview, golden: goldenStats, errors };
    writeFileSync(join(out, 'shot.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
    const problems = [];
    if (errors.length) problems.push('page errors');
    if (!overview.agents || !overview.rooms) problems.push('empty scene');
    if (overview.calls > 300) problems.push(`${overview.calls} draw calls (budget 300)`);
    if (!drawer) problems.push('the details drawer did not open');
    if (golden) {
      for (const [h, min] of GOLDEN) {
        const g = goldenStats[h];
        if (!g || g.share < 0.15) problems.push(`golden ${h}: the building is not visible`);
        else if (g.mean < min) problems.push(`golden ${h}: mean brightness ${g.mean} is below ${min}`);
      }
    }
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
