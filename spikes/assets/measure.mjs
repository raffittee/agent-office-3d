// P0-07 asset spike harness. Usage: node spikes/assets/measure.mjs <dir with ual-raw.glb, ual-meshopt.glb, kenney-merged.glb, kenney-meshopt.glb>
// The asset files are served from that directory and never copied into the repo.
import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright-core';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = join(here, 'dist');
const assets = resolve(process.argv[2]);
const out = join(here, 'out');
mkdirSync(out, { recursive: true });
await build({ root: here, base: './', logLevel: 'warn', build: { outDir: dist, emptyOutDir: true } });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary' };
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const root = p.startsWith('/assets-src/') ? assets : dist;
  const file = join(root, p.replace(/^\/(assets-src\/)?/, '') || 'index.html');
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.log('page error:', e.message));

const runs = [
  { name: 'raw-30', char: 'ual-raw.glb', furniture: 'kenney-merged.glb', n: 30 },
  { name: 'meshopt-30', char: 'ual-meshopt.glb', furniture: 'kenney-meshopt.glb', n: 30 },
  { name: 'meshopt-60', char: 'ual-meshopt.glb', n: 60 },
  { name: 'lod25-30', char: 'ual-lod-meshopt.glb', n: 30 },
  { name: 'lod25-60', char: 'ual-lod-meshopt.glb', n: 60 },
];
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const results = [];
for (const r of runs.filter((r) => !only || r.name.includes(only))) {
  const qs = new URLSearchParams({ char: `${base}/assets-src/${r.char}`, n: String(r.n), ...(r.furniture ? { furniture: `${base}/assets-src/${r.furniture}` } : {}) });
  await page.goto(`${base}/index.html?${qs}`);
  await page.waitForFunction(() => window.__result, null, { timeout: 120000 });
  const res = await page.evaluate(() => window.__result);
  await page.evaluate(() => { document.getElementById('hud').style.display = 'none'; });
  await page.screenshot({ path: join(out, `${r.name}.png`) });
  results.push({ name: r.name, ...res });
  console.log(r.name, JSON.stringify(res));
}
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1));
await browser.close();
server.close();
