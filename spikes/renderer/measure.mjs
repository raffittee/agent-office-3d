// P0-06 renderer spike harness: build the page, serve it on 127.0.0.1, run each configuration in Chrome at 1920×1080 on
// the real GPU, and collect the numbers. Usage: node spikes/renderer/measure.mjs [--quick]
import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright-core';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = join(here, 'dist');
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

await build({ root: here, base: './', logLevel: 'warn', build: { outDir: dist, emptyOutDir: true, minify: false } });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const path = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html');
  if (!path.startsWith(dist) || !existsSync(path)) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(existsSync);
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-precise-memory-info'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('page error:', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('console error:', m.text()));

// Baseline: how fast does this headless browser schedule rAF on an empty page?
await page.setContent('<!doctype html><title>blank</title><body></body>');
const baselineFps = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let n = 0;
      const t0 = performance.now();
      const tick = (t) => (t - t0 < 3000 ? (n++, requestAnimationFrame(tick)) : resolve(n / ((t - t0) / 1000)));
      requestAnimationFrame(tick);
    }),
);
console.log(`baseline rAF on an empty page: ${baselineFps.toFixed(1)} fps`);

const quick = process.argv.includes('--quick');
const configs = [];
for (const cam of ['ortho', 'persp']) for (const cut of ['none', 'hide', 'cut', 'fade']) configs.push({ cam, cut, chars: 'meshes', shadows: 0 });
for (const chars of ['instanced', 'skinned']) configs.push({ cam: 'ortho', cut: 'hide', chars, shadows: 0 });
for (const chars of ['instanced', 'meshes', 'skinned']) configs.push({ cam: 'ortho', cut: 'hide', chars, shadows: 1 });
configs.push({ cam: 'ortho', cut: 'hide', chars: 'meshes', shadows: 0, labels: 0 });
configs.push({ cam: 'ortho', cut: 'hide', chars: 'meshes', shadows: 0, agents: 60 });
configs.push({ cam: 'ortho', cut: 'hide', chars: 'meshes', shadows: 0, aa: 0 });
configs.push({ cam: 'ortho', cut: 'hide', chars: 'meshes', shadows: 1, aa: 0 });

const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const results = [];
for (const c of quick ? configs.slice(0, 2) : configs.filter((c) => !only || Object.entries(c).map(([k, v]) => `${k}-${v}`).join('_').includes(only))) {
  const params = new URLSearchParams(Object.entries(c).map(([k, v]) => [k, String(v)]));
  if (quick) params.set('seconds', '3');
  const name = Object.entries(c).map(([k, v]) => `${k}-${v}`).join('_');
  await page.goto(`${base}?${params}`);
  await page.waitForFunction(() => window.__result, null, { timeout: 120000, polling: 500 });
  const r = await page.evaluate(() => window.__result);
  await page.evaluate(() => { document.getElementById('hud').style.display = 'none'; });
  await page.screenshot({ path: join(out, `${name}.png`) });
  results.push({ name, ...r });
  console.log(
    name.padEnd(52),
    `fps ${r.fps.toFixed(1)}  frame p50/p95 ${r.frameMsP50.toFixed(1)}/${r.frameMsP95.toFixed(1)}  cpu ${r.cpuMsP50.toFixed(2)}/${r.cpuMsP95.toFixed(2)}  burst ${r.burstMsP50.toFixed(1)}/${r.burstMsP95.toFixed(1)} ms  calls ${r.drawCalls}  tris ${r.triangles}  heap ${r.jsHeapMB?.toFixed(1)} MB`,
  );
}
console.log('GPU:', results[0]?.gpu);
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
await browser.close();
server.close();
