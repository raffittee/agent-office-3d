// Ported from habblaud client/src/app.ts (MIT, © 2026 Márcio Junior)
// The client app: store (data) → world (canvas) → UI (panels).
import { OfficeStore } from './net/store';
import { createWorld, DEFAULT_WORLD_SETTINGS } from './render3d/world';
import { createUI, savedSettings } from './ui';

export function start(): void {
  const params = new URLSearchParams(location.search);
  const store = new OfficeStore({ mock: params.has('mock') });
  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const labels = document.getElementById('labels') as HTMLElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  const world = createWorld(canvas, labels, store, savedSettings(DEFAULT_WORLD_SETTINGS));
  createUI(uiRoot, store, world);
  store.connect();

  // Handy for debugging from the browser console.
  Object.assign(window, { agentOffice: { store, world } });
}
