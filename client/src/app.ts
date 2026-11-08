// Ported from habblaud client/src/app.ts (MIT, © 2026 Márcio Junior)
// The client app: store (data) → world (canvas) → UI (panels).
import { OfficeStore } from './net/store';
import { parseQuality } from './render3d/scene';
import { createWorld, DEFAULT_WORLD_SETTINGS } from './render3d/world';
import { themes } from './themes/registry';
import { createUI, savedSettings } from './ui';
import { parseShell } from './ui/shell';

export function start(): void {
  const params = new URLSearchParams(location.search);
  const store = new OfficeStore({ mock: params.has('mock') });
  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const labels = document.getElementById('labels') as HTMLElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  const settings = savedSettings(DEFAULT_WORLD_SETTINGS);
  // ?theme=<id> opens the office in that theme (links, screenshots)
  const theme = params.get('theme');
  // ?quality=low|medium|high wins; the desktop widget is small, so it renders lighter (pixel ratio 1, no multisampling,
  // no shadows); otherwise the setting, where 'auto' is medium
  const picked = settings.graphics === 'low' || settings.graphics === 'medium' || settings.graphics === 'high' ? settings.graphics : 'medium';
  const quality = parseQuality(location.search) ?? (parseShell(location.search) === 'widget' ? 'low' : picked);
  const world = createWorld(canvas, labels, store, theme ? { ...settings, theme } : settings, quality);
  createUI(uiRoot, store, world);
  store.connect();

  // Handy for debugging from the browser console.
  Object.assign(window, { agentOffice: { store, world, themes } });
}
