// Builds the desktop app:  node desktop/tools/pack.mjs [--dir] [--skip-package]
//   1. the release package (npm run build + npm run package), unless --skip-package
//   2. the Electron bundles (desktop/dist)
//   3. electron-builder: the Windows installer (out/Agent-Office-Setup-<version>.exe), or with --dir just the
//      unpacked app (out/win-unpacked on Windows, out/linux-unpacked on Linux), which is what the smoke test runs.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builderConfig } from './builder-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktop = join(root, 'desktop');
const argv = process.argv.slice(2);
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`desktop: "${cmd} ${args.join(' ')}" failed`);
    process.exit(r.status ?? 1);
  }
}

if (!argv.includes('--skip-package')) {
  run('npm', ['run', 'build'], root);
  run('npm', ['run', 'package'], root);
}
const packageDir = join(root, 'release', `agent-office-${version}`);
run('node', ['build.mjs'], desktop);

const { build, Platform } = createRequire(join(desktop, 'package.json'))('electron-builder');
const targets = argv.includes('--dir') ? Platform.current().createTarget('dir') : Platform.WINDOWS.createTarget(['nsis']);
// the unpacked build is for testing: no icon or version info in the .exe, so no helper tools to download from GitHub
const editExecutable = !argv.includes('--dir');
// Electron itself was downloaded and checked by `npm ci` (in desktop/): reuse it instead of downloading it again
const dist = join(desktop, 'node_modules', 'electron', 'dist');
const electronDist = existsSync(join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron')) ? dist : undefined;
await build({ targets, config: builderConfig({ version, packageDir, editExecutable, electronDist }), projectDir: desktop, publish: 'never' });
console.log(`desktop: built Agent Office ${version} in desktop/out`);
