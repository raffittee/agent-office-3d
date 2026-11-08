// Runs the desktop app from the sources:  npm run desktop:dev   (AGENT_OFFICE_DEMO=1 for simulated agents)
// Builds the web app and the release package, bundles the Electron files, then starts Electron on them.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktop = join(root, 'desktop');
const win = process.platform === 'win32';

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: win });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!existsSync(join(desktop, 'node_modules', 'electron'))) run('npm', ['ci'], desktop);
run('npm', ['run', 'build'], root);
run('npm', ['run', 'package'], root);
run('node', ['build.mjs'], desktop);

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const electron = join(desktop, 'node_modules', '.bin', win ? 'electron.cmd' : 'electron');
const child = spawn(electron, [desktop], {
  stdio: 'inherit',
  shell: win,
  env: { ...process.env, AGENT_OFFICE_PACKAGE_DIR: join(root, 'release', `agent-office-${version}`) },
});
child.on('exit', (code) => process.exit(code ?? 0));
