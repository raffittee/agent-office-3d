// How the app reacts when the server it started dies: restart a few times with a growing pause, then give up.

export interface RestartOptions {
  /** Most exits allowed inside the window before giving up. */
  max: number;
  windowMs: number;
  baseDelayMs: number;
}

export const DEFAULT_RESTART: RestartOptions = { max: 3, windowMs: 60_000, baseDelayMs: 500 };

export type RestartAction = { action: 'restart'; delayMs: number } | { action: 'give-up' };

/** `exits` are the times (ms) the server died, oldest first, including the one just now. */
export function nextAction(exits: readonly number[], now: number, o: RestartOptions = DEFAULT_RESTART): RestartAction {
  const recent = exits.filter((t) => now - t <= o.windowMs).length;
  if (recent > o.max) return { action: 'give-up' };
  return { action: 'restart', delayMs: o.baseDelayMs * 2 ** Math.max(0, recent - 1) };
}
