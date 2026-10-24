// Server configuration from the environment. P1-05 extends this (data dir, demo, theme).

export interface Config {
  host: string;
  port: number;
  /** `--dev`: Vite in middleware mode on the same server (HMR). */
  dev: boolean;
}

export const DEFAULT_PORT = 4848;
export const DEFAULT_HOST = '127.0.0.1';

export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`AGENT_OFFICE_PORT must be 1-65535, got "${raw}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): Config {
  return {
    host: env.AGENT_OFFICE_HOST?.trim() || DEFAULT_HOST,
    port: parsePort(env.AGENT_OFFICE_PORT),
    dev: argv.includes('--dev'),
  };
}
