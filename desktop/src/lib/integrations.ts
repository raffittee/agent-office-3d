// Installing and removing the hooks from the app: runs the bundled installers (scripts/hooks-install.mjs and
// scripts/usage-install.mjs of the release package) in a child process, like `agent-office hooks install` does.
import { execFile, spawn } from 'node:child_process';
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

export function describeNode(output: string | null): IntegrationsInfo['node'] {
  if (output === null) return { ok: false, message: 'Node.js was not found on your PATH. Gemini CLI and Codex run Agent Office\'s hook scripts with it. Install Node.js 22.12 or newer from nodejs.org, then reopen this dialog. Claude Code needs nothing.' };
  const version = output.trim();
  if (!nodeVersionOk(version)) return { ok: false, message: `Node.js ${version} is too old for the hook scripts: they need 22.12 or newer (nodejs.org).` };
  return { ok: true, message: `Node.js ${version} found.` };
}

/** `node --version` as the agent CLIs would see it, or null when there is none. */
export function checkNode(timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('node', ['--version'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** Does the installer's `status` output say this integration is installed? */
export function parseInstalled(id: Integration, output: string): boolean {
  // hooks-install:  "• <file>: installed for SessionStart, …"  vs  "• <file>: not installed"
  // usage-install:  "• <file>: installed"                       vs  "• <file>: not installed"
  return id === 'usage' ? /^•[^\n]*: installed\s*$/m.test(output) : /^•[^\n]*: installed for /m.test(output);
}

export function installerArgs(id: Integration, action: IntegrationAction | 'status', port: number): { script: string; args: string[] } {
  if (id === 'usage') return { script: 'usage-install.mjs', args: [action] };
  return { script: 'hooks-install.mjs', args: [action, '--provider', id, ...(action === 'install' ? ['--port', String(port)] : [])] };
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
  const [node, ...statuses] = await Promise.all([checkNode(), ...INTEGRATIONS.map((id) => runInstaller(o, id, 'status'))]);
  const items: IntegrationStatus[] = INTEGRATIONS.map((id, i) => ({ id, installed: parseInstalled(id, statuses[i]!.output) }));
  return { node: describeNode(node), items };
}
