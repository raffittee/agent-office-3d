// Runs a command again when it fails:  node desktop/tools/retry.mjs <attempts> <seconds between> -- <command> [args]
// For the steps that download from GitHub (Electron, electron-builder's helpers): GitHub's release downloads sometimes
// answer "504 Gateway Time-out", and electron-builder crashes on it. Its downloads are cached, so each attempt gets
// further than the last. A real failure fails every attempt and still ends red.
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const attempts = Number(argv[0]);
const pause = Number(argv[1]);
const command = split >= 0 ? argv.slice(split + 1) : [];
if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(pause) || !command.length) {
  console.error('Usage: node desktop/tools/retry.mjs <attempts> <seconds between attempts> -- <command> [args]');
  process.exit(2);
}

let code = 1;
for (let i = 1; i <= attempts; i++) {
  const r = spawnSync(command[0], command.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
  code = r.status ?? 1;
  if (code === 0) process.exit(0);
  if (i < attempts) {
    console.error(`\nretry: attempt ${i} of ${attempts} failed (exit ${code}); trying again in ${pause} s\n`);
    await new Promise((res) => setTimeout(res, pause * 1000));
  }
}
console.error(`\nretry: all ${attempts} attempts failed`);
process.exit(code);
