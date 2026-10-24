// Ported from habblaud server/config.ts (MIT, © 2026 Márcio Junior)
// Server configuration from the environment (AGENT_OFFICE_*; see CLAUDE.md › Conventions › Configuration).
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllowedHosts } from './http/guard';

export interface Config {
  host: string;
  port: number;
  /** `--dev`: Vite in middleware mode on the same server (HMR). */
  dev: boolean;
  /** Start the demo simulator (AGENT_OFFICE_DEMO=1). */
  demo: boolean;
  /** Running in a container: the agents' PIDs are the host's and can't be probed (AGENT_OFFICE_IN_DOCKER or /.dockerenv). */
  inDocker: boolean;
  home: string;
  /** Where Agent Office keeps its own state (names, room aliases, hook config). */
  dataDir: string;
  /** Extra names accepted in Host/Origin (AGENT_OFFICE_ALLOWED_HOSTS); localhost and IPs always are. */
  allowedHosts: Set<string>;
  /** Project root (where package.json is); dist/client is served from here. */
  rootDir: string;
  version: string;
  /** The default theme pack id (AGENT_OFFICE_THEME); the browser falls back to its built-in default if unknown. */
  theme?: string;
  /** Asked for the session-touching features (AGENT_OFFICE_INTERACTIVE=1 or --interactive); see `interactive()`. */
  interactiveRequested: boolean;
}

/** The session-touching features are on only when asked for AND bound to loopback (CLAUDE.md, security). */
export function interactive(c: Pick<Config, 'interactiveRequested' | 'host'>): boolean {
  return c.interactiveRequested && isLoopbackBind(c.host);
}

export const DEFAULT_PORT = 4848;
export const DEFAULT_HOST = '127.0.0.1';

/** A theme pack id (AGENT_OFFICE_THEME): lowercase letters, digits and dashes; anything else is ignored. */
export function parseTheme(raw: string | undefined): string | undefined {
  const v = raw?.trim().toLowerCase();
  return v && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v) ? v : undefined;
}

export function isTruthy(v: string | undefined): boolean {
  return !!v && /^(1|true|yes|on)$/i.test(v.trim());
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`AGENT_OFFICE_PORT must be 1-65535, got "${raw}"`);
  return n;
}

/**
 * A listen address only this computer can reach: 127.0.0.0/8, `::1` (with or without brackets) or `localhost`.
 * `0.0.0.0`, `::`, LAN IPs and other names don't count. Session-touching features (Phase 7) require it.
 */
export function isLoopbackBind(value: string | undefined): boolean {
  let v = value?.trim().toLowerCase() ?? '';
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  if (v === 'localhost') return true;
  const family = isIP(v);
  if (family === 4) return v.startsWith('127.');
  if (family !== 6) return false;
  try {
    return new URL(`http://[${v}]/`).hostname === '[::1]';
  } catch {
    return false;
  }
}

/** Walks up from `from` to the project's package.json. */
export function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name === 'agent-office') return dir;
      } catch {
        // unreadable package.json: keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from, '..');
}

function readVersion(rootDir: string): string {
  try {
    const v = (JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): Config {
  const home = env.HOME || env.USERPROFILE || homedir();
  const rootDir = findRoot(dirname(fileURLToPath(import.meta.url)));
  return {
    host: env.AGENT_OFFICE_HOST?.trim() || DEFAULT_HOST,
    port: parsePort(env.AGENT_OFFICE_PORT),
    dev: argv.includes('--dev'),
    demo: isTruthy(env.AGENT_OFFICE_DEMO) || argv.includes('--demo'),
    interactiveRequested: isTruthy(env.AGENT_OFFICE_INTERACTIVE) || argv.includes('--interactive'),
    inDocker: isTruthy(env.AGENT_OFFICE_IN_DOCKER) || (process.platform === 'linux' && existsSync('/.dockerenv')),
    home,
    dataDir: resolve(env.AGENT_OFFICE_DATA_DIR?.trim() || join(home, '.agent-office')),
    allowedHosts: parseAllowedHosts(env.AGENT_OFFICE_ALLOWED_HOSTS),
    rootDir,
    version: readVersion(rootDir),
    ...(parseTheme(env.AGENT_OFFICE_THEME) ? { theme: parseTheme(env.AGENT_OFFICE_THEME) } : {}),
  };
}
