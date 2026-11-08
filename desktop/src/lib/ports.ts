// Which port the desktop app uses, and whether it starts its own server or adopts one that is already running.
import { createServer } from 'node:net';
import { probeHealth, type Health } from './health';

export const DEFAULT_PORT = 4848;
/** How many ports after the preferred one are tried. */
export const PORT_TRIES = 20;

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

export type PortState = 'agent-office' | 'free' | 'busy';

export interface PortProbe {
  health(port: number): Promise<Health | null>;
  free(port: number): Promise<boolean>;
}

const REAL_PROBE: PortProbe = { health: (p) => probeHealth(p), free: (p) => isPortFree(p) };

export async function classifyPort(port: number, probe: PortProbe = REAL_PROBE): Promise<{ state: PortState; health?: Health }> {
  const health = await probe.health(port);
  if (health) return { state: 'agent-office', health };
  return { state: (await probe.free(port)) ? 'free' : 'busy' };
}

export type ServerPlan = { kind: 'adopt'; port: number; version: string } | { kind: 'spawn'; port: number };

/**
 * The first of `preferred`, `preferred + 1`, … that either runs Agent Office already (use it) or is free (start one).
 * A port held by some other program is skipped.
 */
export async function resolveServer(preferred: number, probe: PortProbe = REAL_PROBE): Promise<ServerPlan> {
  for (let i = 0; i < PORT_TRIES; i++) {
    const port = preferred + i;
    if (port > 65535) break;
    const c = await classifyPort(port, probe);
    if (c.state === 'agent-office') return { kind: 'adopt', port, version: c.health!.version };
    if (c.state === 'free') return { kind: 'spawn', port };
  }
  throw new Error(`No free port from ${preferred} to ${Math.min(65535, preferred + PORT_TRIES - 1)}. Set AGENT_OFFICE_PORT to a free port.`);
}

/** A warning when an adopted server is not the version of this app; null when they match. */
export function versionNote(appVersion: string, serverVersion: string): string | null {
  return appVersion === serverVersion ? null : `Using the Agent Office ${serverVersion} that is already running (this app is ${appVersion}).`;
}
