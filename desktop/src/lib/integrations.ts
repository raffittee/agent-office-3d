// Installing and removing the hooks from the app: runs the bundled installers (scripts/hooks-install.mjs and
// scripts/usage-install.mjs of the release package) in a child process, like `agent-office hooks install` does.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Integration, IntegrationAction, IntegrationResult, IntegrationsInfo, IntegrationStatus } from './ipc';
import { INTEGRATIONS } from './ipc';

/** Node.js 22.12, the version the hook scripts and the server need. */
export function nodeVersionOk(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  return major > 22 || (major === 22 && Number(m[2]) >= 12);
}

/** What the app found out about Node.js on this computer. */
export interface NodeProbe {
  /** The `node` executable found on the PATH, or null. */
  path: string | null;
  /** What `node --version` printed, or null when it couldn't be read. */
  version: string | null;
}

export function describeNode(p: NodeProbe): IntegrationsInfo['node'] {
  if (!p.path) return { ok: false, message: 'Node.js was not found on your PATH. Gemini CLI and Codex run Agent Office\'s hook scripts with it. Install Node.js 22.12 or newer from nodejs.org, then reopen this dialog. Claude Code needs nothing.' };
  if (!p.version) return { ok: true, message: `Node.js found (${p.path}), but its version could not be read. The hook scripts need 22.12 or newer.` };
  const version = p.version.trim();
  if (!nodeVersionOk(version)) return { ok: false, message: `Node.js ${version} is too old for the hook scripts: they need 22.12 or newer (nodejs.org).` };
  return { ok: true, message: `Node.js ${version} found.` };
}

/** The first `<name>` executable in the PATH folders, found by looking for the file (no process is started). */
export function findOnPath(name: string, o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {}): string | null {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? existsSync;
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  // Windows keeps the variable's name in any case (Path, PATH)
  const raw = win ? (Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '') : (env.PATH ?? '');
  const file = win ? `${name}.exe` : name;
  for (const dir of raw.split(sep)) {
    const folder = dir.trim().replace(/^"|"$/g, '');
    if (!folder) continue;
    const candidate = win ? `${folder.replace(/[\\/]+$/, '')}\\${file}` : `${folder.replace(/\/+$/, '')}/${file}`;
    if (exists(candidate)) return candidate;
  }
  return null;
}

function readVersion(nodePath: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(nodePath, ['--version'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}

/**
 * Is there a Node.js the agent CLIs would find? The file is looked up on the PATH, then asked for its version with a
 * generous timeout and one retry: right after an install, Windows scans new files and everything is slow.
 */
export async function probeNode(o: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<NodeProbe> {
  const path = findOnPath('node', o.env ? { env: o.env } : {});
  if (!path) return { path: null, version: null };
  const timeout = o.timeoutMs ?? 30_000;
  const version = (await readVersion(path, timeout)) ?? (await readVersion(path, timeout));
  return { path, version };
}

/** Does the installer's `status` output say this integration is installed? */
export function parseInstalled(id: Integration, output: string): boolean {
  // hooks-install:  "• <file>: installed for SessionStart, …"  vs  "• <file>: not installed"
  // usage-install:  "• <file>: installed"                       vs  "• <file>: not installed"
  return id === 'usage' ? /^•[^\n]*: installed\s*$/m.test(output) : /^•[^\n]*: installed for /m.test(output);
}

export function installerArgs(id: Integration, action: IntegrationAction | 'status', port: number): { script: string; args: string[] } {
  if (id === 'usage') return { script: 'usage-install.mjs', args: [action] };
  // status is only shown in the dialog: skip the `<cli> --version` probe, which can take seconds on Windows
  return { script: 'hooks-install.mjs', args: [action, '--provider', id, '--port', String(port), ...(action === 'status' ? ['--no-version-check'] : [])] };
}

export interface RunOptions {
  execPath: string;
  /** The release package folder. */
  packageDir: string;
  port: number;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Runs one installer command and collects what it prints. */
export function runInstaller(o: RunOptions, id: Integration, action: IntegrationAction | 'status'): Promise<IntegrationResult> {
  const { script, args } = installerArgs(id, action, o.port);
  return new Promise((resolve) => {
    const child = spawn(o.execPath, [join(o.packageDir, 'scripts', script), ...args], {
      env: { ...process.env, ...o.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const add = (b: Buffer) => {
      if (output.length < 20_000) output += b.toString('utf8');
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill(), o.timeoutMs ?? 30_000);
    child.once('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `Could not run the installer: ${e.message}` });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim() });
    });
  });
}

export async function integrationsInfo(o: RunOptions): Promise<IntegrationsInfo> {
  // the Node check first and alone: starting five processes at once can starve it on a small machine
  const node = await probeNode();
  const statuses = await Promise.all(INTEGRATIONS.map((id) => runInstaller(o, id, 'status')));
  const items: IntegrationStatus[] = INTEGRATIONS.map((id, i) => ({ id, installed: parseInstalled(id, statuses[i]!.output) }));
  return { node: describeNode(node), items };
}
