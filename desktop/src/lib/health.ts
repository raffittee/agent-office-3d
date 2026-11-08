// What the desktop app needs to know about a server on a port: is it Agent Office, and which version.

export interface Health {
  version: string;
  demo: boolean;
}

/** `/api/health` of Agent Office, or null for anything else (another program, an error page, bad JSON). */
export function parseHealth(value: unknown): Health | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.ok !== true || typeof v.version !== 'string' || !Array.isArray(v.providers)) return null;
  return { version: v.version, demo: v.demo === true };
}

export async function probeHealth(port: number, fetchImpl: typeof fetch = fetch, timeoutMs = 1500): Promise<Health | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return parseHealth(await res.json());
  } catch {
    return null;
  }
}
