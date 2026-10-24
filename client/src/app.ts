// Ported from habblaud client/src/app.ts (MIT, © 2026 Márcio Junior)
// The client app: store (data) → world (canvas) → UI (panels).
import { startDebugPage } from './debug/page';
import { OfficeStore } from './net/store';

export function start(): void {
  const params = new URLSearchParams(location.search);
  const store = new OfficeStore({ mock: params.has('mock') });
  const uiRoot = document.getElementById('ui') as HTMLElement;

  // Until P2-10 brings the panels, the debug list is the UI.
  const debug = document.createElement('div');
  uiRoot.append(debug);
  startDebugPage(debug, store);

  store.connect();

  // Handy for debugging from the browser console.
  Object.assign(window, { agentOffice: { store } });
}
