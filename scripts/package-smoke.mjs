// Smoke test of an UNPACKED release package (what the release pipeline runs on Windows and Linux before publishing):
//
//   node scripts/package-smoke.mjs <unpacked package folder> [--installer]
//
// Starts the packaged server in demo mode on a free port with a throwaway HOME, then checks the health route, the
// page and a script it links, the snapshot, and that the bundled installers run. With --installer it also runs the
// package's own install script into a temp folder, runs the installed command, and uninstalls again.
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = process.argv[2] ? resolve(process.argv[2]) : null;
if (!dir) {
  console.error('Usage: node scripts/package-smoke.mjs <unpacked package folder> [--installer]');
  process.exit(2);
}
const cli = join(dir, 'bin', 'agent-office.mjs');
const home = mkdtempSync(join(tmpdir(), 'ao-smoke-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, AGENT_OFFICE_DATA_DIR: join(home, '.agent-office'), CLAUDE_CONFIG_DIR: '', GEMINI_CLI_HOME: '', CODEX_HOME: '' };
const checks = [];

function check(name, ok, detail = '') {
  checks.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
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

function node(args, extra = {}) {
  return spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60_000, ...extra });
}

async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return { status: r.status, type: r.headers.get('content-type') ?? '', text: await r.text() };
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const f of ['bin/agent-office.mjs', 'dist/server/index.js', 'dist/client/index.html', 'hooks/gemini-cli.mjs', 'scripts/hooks-install.mjs', 'scripts/usage-install.mjs', 'install.sh', 'install.ps1', 'README.md', 'LICENSE']) {
    check(`has ${f}`, existsSync(join(dir, f)));
  }
  check('no sources or tests shipped', !existsSync(join(dir, 'server')) && !existsSync(join(dir, 'client')) && !existsSync(join(dir, 'plugins/agent-office-messages/tests')));

  const v = node([cli, 'version']);
  check('agent-office version matches package.json', v.status === 0 && v.stdout.trim() === manifest.version, `${v.stdout}${v.stderr}`);

  // hooks installer, bundled: a dry run must not need tsx or write anything
  const dry = node([cli, 'hooks', 'install', '--provider', 'gemini-cli', '--dry-run']);
  check('hooks installer runs (dry run)', dry.status === 0, `${dry.stdout}${dry.stderr}`);
  const usage = node([cli, 'usage', 'status']);
  check('usage installer runs', usage.status === 0, `${usage.stdout}${usage.stderr}`);
  const bad = node([cli, 'nonsense']);
  check('unknown command is refused', bad.status === 2);

  // the server
  const port = await freePort();
  const server = spawn(process.execPath, [cli, 'start', '--demo'], { env: { ...env, AGENT_OFFICE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    let health = null;
    for (let i = 0; i < 60 && !health; i++) {
      try {
        health = JSON.parse((await get(`${base}/api/health`)).text);
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    check('server answers /api/health', !!health?.ok, log.slice(-500));
    check('health reports the package version', health?.version === manifest.version, `${health?.version}`);
    check('demo mode is on', health?.demo === true);
    const page = await get(`${base}/`);
    check('serves the page', page.status === 200 && page.type.includes('html') && /<script/.test(page.text));
    const script = /src="(\/[^"]+\.js)"/.exec(page.text)?.[1];
    const js = script ? await get(`${base}${script}`) : null;
    check('serves the page script', !!js && js.status === 200 && js.type.includes('javascript'), script ?? 'no script tag');
    const snap = JSON.parse((await get(`${base}/api/snapshot`)).text);
    check('snapshot has demo agents', Array.isArray(snap.agents) && snap.agents.length > 0);
    // fetch() won't send a Host of our choosing, so use node:http (DNS-rebinding guard)
    const foreign = await new Promise((res) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/api/health', headers: { Host: 'evil.example' }, timeout: 5000 }, (r) => {
        r.resume();
        res(r.statusCode);
      });
      req.on('error', () => res(0));
      req.end();
    });
    check('refuses a foreign Host header', foreign === 403, `status ${foreign}`);
  } finally {
    server.kill();
  }

  if (process.argv.includes('--installer')) {
    const prefix = join(home, 'installed');
    const bin = join(home, 'bin');
    const win = process.platform === 'win32';
    const run = (extra = []) =>
      win
        ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'install.ps1'), '-Prefix', prefix, '-NoShortcut', ...extra], { env, encoding: 'utf8', timeout: 120_000 })
        : spawnSync('sh', [join(dir, 'install.sh'), '--prefix', prefix, '--bin-dir', bin, ...extra], { env, encoding: 'utf8', timeout: 120_000 });
    const first = run();
    check('installer installs', first.status === 0, `${first.stdout}${first.stderr}`);
    const again = run();
    check('installer upgrades in place', again.status === 0, `${again.stdout}${again.stderr}`);
    const installed = win ? spawnSync(join(prefix, 'agent-office.cmd'), ['version'], { env, encoding: 'utf8', shell: true }) : spawnSync(join(bin, 'agent-office'), ['version'], { env, encoding: 'utf8' });
    check('the installed command runs', installed.status === 0 && installed.stdout.trim() === manifest.version, `${installed.stdout}${installed.stderr}`);
    const removed = run(win ? ['-Uninstall'] : ['--uninstall']);
    check('installer uninstalls', removed.status === 0 && !existsSync(prefix), `${removed.stdout}${removed.stderr}`);
  }
}

try {
  await main();
} catch (err) {
  check('smoke test ran to the end', false, err instanceof Error ? err.stack : String(err));
} finally {
  rmSync(home, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} of ${checks.length} checks failed.` : `\nAll ${checks.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
