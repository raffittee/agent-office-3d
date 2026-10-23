// P0-06 helper: open one configuration of the built spike in live mode and print the HUD after a few seconds.
// Usage: node spikes/renderer/probe-one.mjs "<query string>"  (run measure.mjs once first to build dist/)
import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const dist = fileURLToPath(new URL('./dist', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  const path = join(dist, new URL(req.url, 'http://x').pathname.replace(/^\/+/, '') || 'index.html');
  if (!path.startsWith(dist) || !existsSync(path)) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.log('page error:', e.stack));
page.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 300)));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?measure=0&${process.argv[2] ?? ''}`);
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(2000);
  console.log(await page.evaluate(() => document.getElementById('hud').textContent));
}
await page.screenshot({ path: fileURLToPath(new URL('./out/probe.png', import.meta.url)) });
await browser.close();
server.close();
