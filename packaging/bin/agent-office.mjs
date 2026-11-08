#!/usr/bin/env node
// Agent Office command line, as shipped in the release package. Plain Node, no dependencies.
//
//   agent-office start [--open] [--demo] [--interactive]   run the office (open the browser with --open)
//   agent-office hooks install|uninstall|status --provider claude-code|gemini-cli|codex
//   agent-office hooks uninstall --all                     remove the hooks of every provider
//   agent-office usage install|uninstall|status            Claude Code plan-usage tap
//   agent-office version | help
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDERS = ['claude-code', 'gemini-cli', 'codex'];

const USAGE = `Agent Office: a 3D office that shows what your AI coding agents are doing.

Usage:
  agent-office start [--open] [--demo] [--interactive]
  agent-office hooks <install|uninstall|status> --provider <claude-code|gemini-cli|codex> [--profile light|full]
  agent-office hooks uninstall --all
  agent-office usage <install|uninstall|status>
  agent-office version

Environment: AGENT_OFFICE_PORT (default 4848), AGENT_OFFICE_HOST, AGENT_OFFICE_DATA_DIR, AGENT_OFFICE_INTERACTIVE.
Docs: README.md, docs/interactive.md, docs/security.md.`;

function version() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

function nodeOk() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}

/** Runs one of the bundled installers in its own process; returns its exit code. */
function runScript(name, args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', `${name}.mjs`), ...args], { stdio: 'inherit' });
  return r.status ?? 1;
}

async function openWhenReady() {
  const port = process.env.AGENT_OFFICE_PORT?.trim() || '4848';
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${url}api/health`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => console.log(`Open ${url} in your browser.`)).unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log(version());
    return 0;
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (!nodeOk()) {
    console.error(`Agent Office needs Node.js 22.12 or newer (this is ${process.versions.node}). Get it at https://nodejs.org`);
    return 1;
  }
  if (cmd === 'start') {
    // the server reads its flags (--demo, --interactive) from process.argv and starts listening when imported
    if (rest.includes('--open')) void openWhenReady();
    await import(pathToFileURL(join(ROOT, 'dist', 'server', 'index.js')).href);
    return null; // keep running
  }
  if (cmd === 'hooks') {
    if (rest[0] === 'uninstall' && rest.includes('--all')) {
      let code = 0;
      for (const provider of PROVIDERS) {
        console.log(`# ${provider}`);
        code = runScript('hooks-install', ['uninstall', '--provider', provider]) || code;
      }
      console.log('# usage tap');
      return runScript('usage-install', ['uninstall']) || code;
    }
    return runScript('hooks-install', rest);
  }
  if (cmd === 'usage') return runScript('usage-install', rest);
  console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
  return 2;
}

main().then(
  (code) => {
    if (code !== null) process.exitCode = code;
  },
  (err) => {
    console.error(`agent-office: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
