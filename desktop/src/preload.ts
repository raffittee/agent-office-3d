// Runs in the page before it loads, with no Node access (sandbox). It exposes the few things the app's own page may ask
// of the main process as window.agentOfficeShell; everything is re-validated on the other side.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CH, type Integration, type IntegrationAction, type IntegrationResult, type IntegrationsInfo, type ShellState } from './lib/ipc';
import type { Mode } from './lib/windowState';

function listen<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('agentOfficeShell', {
  getState: (): Promise<ShellState | null> => ipcRenderer.invoke(CH.getState),
  setMode: (mode: Mode): Promise<void> => ipcRenderer.invoke(CH.setMode, mode),
  togglePinned: (): Promise<void> => ipcRenderer.invoke(CH.togglePinned),
  minimize: (): Promise<void> => ipcRenderer.invoke(CH.minimize),
  close: (): Promise<void> => ipcRenderer.invoke(CH.hide),
  integrations: (): Promise<IntegrationsInfo | null> => ipcRenderer.invoke(CH.integrations),
  runIntegration: (id: Integration, action: IntegrationAction): Promise<IntegrationResult | null> => ipcRenderer.invoke(CH.runIntegration, id, action),
  onState: (cb: (state: ShellState) => void) => listen<ShellState>(CH.state, cb),
  onOpenIntegrations: (cb: () => void) => listen<void>(CH.openIntegrations, () => cb()),
});
