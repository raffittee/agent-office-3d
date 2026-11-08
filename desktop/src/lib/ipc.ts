// The only messages between the page and the app's main process (preload.ts exposes them as window.agentOfficeShell).
// Both sides validate: the page is trusted code, but the main process never acts on an unchecked message.
import type { Mode } from './windowState';

export const CH = {
  getState: 'shell:get-state',
  setMode: 'shell:set-mode',
  togglePinned: 'shell:toggle-pinned',
  minimize: 'shell:minimize',
  hide: 'shell:hide',
  integrations: 'shell:integrations',
  runIntegration: 'shell:run-integration',
  /** main -> page: the state changed */
  state: 'shell:state',
  /** main -> page: show the integrations dialog (tray menu) */
  openIntegrations: 'shell:open-integrations',
} as const;

export interface ShellState {
  mode: Mode;
  pinned: boolean;
  clickThrough: boolean;
  version: string;
  platform: string;
}

export const INTEGRATIONS = ['claude-code', 'gemini-cli', 'codex', 'usage'] as const;
export type Integration = (typeof INTEGRATIONS)[number];
export type IntegrationAction = 'install' | 'uninstall';

export function parseMode(v: unknown): Mode | null {
  return v === 'window' || v === 'widget' ? v : null;
}

export function parseIntegration(v: unknown): Integration | null {
  return INTEGRATIONS.find((i) => i === v) ?? null;
}

export function parseIntegrationAction(v: unknown): IntegrationAction | null {
  return v === 'install' || v === 'uninstall' ? v : null;
}

export interface IntegrationStatus {
  id: Integration;
  installed: boolean;
}

export interface IntegrationsInfo {
  /** Is `node` on the PATH and new enough? Gemini CLI and Codex run our hook scripts with it. */
  node: { ok: boolean; message: string };
  items: IntegrationStatus[];
}

export interface IntegrationResult {
  ok: boolean;
  /** What the installer printed, for the dialog. */
  output: string;
}
