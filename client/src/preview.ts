// The theme preview page (P4-10, /preview.html): every furniture kind of a theme side by side, with its floor, walls,
// decor, lighting and models, so pack authors see a change at a glance. `?theme=<id>` picks the pack; editing a
// theme.json under `npm run dev` hot-reloads it here too.
import './styles.css';
import * as THREE from 'three';
import { t } from '../../shared/i18n';
import { attachInput, CameraRig } from './render3d/camera';
import { buildArea, farSides, type AreaView } from './render3d/building';
import { ModelView } from './render3d/models';
import { applyLighting, createScene } from './render3d/scene';
import { TILE_M } from './render3d/units';
import { showroom } from './themes/preview-layout';
import { onThemesChanged, themeById, themes, type ThemeEntry } from './themes/registry';
import type { FurnitureKind } from './core/vocab';

const canvas = document.getElementById('world') as HTMLCanvasElement;
const labels = document.getElementById('labels') as HTMLElement;
const ui = document.getElementById('ui') as HTMLElement;
const params = new URLSearchParams(location.search);

const parts = createScene(canvas, 'medium');
const { scene, renderer } = parts;
const rig = new CameraRig();
let { layout, items } = showroom();
const bounds = { x0: 0, z0: 0, x1: layout.rect.w * TILE_M, z1: layout.rect.h * TILE_M };

let theme: ThemeEntry = themeById(params.get('theme'));
let previewKey = 0;
let view: AreaView | null = null;
let modelled: ReadonlySet<FurnitureKind> = new Set();
const models = new ModelView((ready) => {
  modelled = ready;
  rebuild();
});
scene.add(models.root);

function rebuild(): void {
  if (view) {
    scene.remove(view.group);
    view.dispose();
  }
  view = buildArea(layout, { cols: 99, far: farSides(rig.yaw), cutaway: 'cut', look: theme.look, modelled });
  scene.add(view.group);
}

function use(entry: ThemeEntry): void {
  theme = entry;
  // the showroom's wall in the theme's first room palette (same items, so the labels stay put)
  layout = showroom(entry.look.roomTheme(0).wall).layout;
  previewKey++;
  applyLighting(parts, entry.look);
  models.setTheme(entry);
  rebuild();
  select.value = entry.look.id;
  info.textContent = entry.look.pack.description ?? '';
  const url = new URL(location.href);
  url.searchParams.set('theme', entry.look.id);
  history.replaceState(null, '', url);
}

// ---- the bar: theme select and description
const bar = document.createElement('div');
bar.className = 'pv-bar';
const title = document.createElement('strong');
title.textContent = t('Theme preview');
const select = document.createElement('select');
select.setAttribute('aria-label', t('Theme'));
const fillSelect = () => {
  select.replaceChildren(
    ...themes().map((e) => {
      const o = document.createElement('option');
      o.value = e.look.id;
      o.textContent = `${e.look.name} (${e.look.id})`;
      return o;
    }),
  );
  select.value = theme.look.id;
};
fillSelect();
select.addEventListener('change', () => use(themeById(select.value)));
const info = document.createElement('span');
info.className = 'pv-info';
const back = document.createElement('a');
back.href = './';
back.textContent = t('Back to the office');
bar.append(title, select, info, back);
ui.append(bar);
const style = document.createElement('style');
style.textContent = `
.pv-bar { position: absolute; top: 12px; left: 12px; right: 12px; display: flex; gap: 12px; align-items: center; padding: 10px 14px;
  border-radius: 12px; background: var(--panel-solid); box-shadow: var(--shadow); font-size: 13px; color: var(--text); flex-wrap: wrap; }
.pv-bar select { height: 28px; border-radius: 7px; border: 1px solid var(--border); background: var(--panel-solid); color: var(--text); font: inherit; }
.pv-info { flex: 1; min-width: 200px; color: var(--muted); }
.pv-bar a { color: var(--accent); }
.pv-label { position: absolute; transform: translate(-50%, 0); padding: 1px 6px; border-radius: 6px; font: 11px/1.4 system-ui, sans-serif;
  background: rgba(20, 22, 26, 0.72); color: #fff; white-space: nowrap; pointer-events: none; }
.pv-label.is-model { background: rgba(59, 123, 216, 0.9); }
`;
document.head.append(style);

// ---- labels under each kind
const tags = items.map((it) => {
  const el = document.createElement('div');
  el.className = 'pv-label';
  el.textContent = it.kind;
  labels.append(el);
  return { it, el, p: new THREE.Vector3(it.x * TILE_M, it.wall ? 2.6 : 0.02, it.y * TILE_M + (it.wall ? 0 : 0.05)) };
});
const pt = { x: 0, y: 0 };

attachInput(canvas, rig, { click() {}, hover() {}, leave() {}, overview: () => rig.frame(bounds), escape() {} });
onThemesChanged(() => {
  fillSelect();
  use(themeById(theme.look.id));
});

let framed = false;
let last = performance.now();
let yawKey = '';
const frame = (now: number) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (parts.resize() || !framed) rig.setViewport(canvas.clientWidth, canvas.clientHeight);
  if (!framed) {
    framed = true;
    rig.insets = { top: 70, left: 0, right: 0, bottom: 0 };
    rig.frame(bounds);
    rig.zoom = rig.zoomGoal;
    rig.target.copy(rig.targetGoal);
  }
  rig.update(dt);
  // walls facing the camera are cut: rebuild when the view turns to another side
  const key = JSON.stringify(farSides(rig.yaw));
  if (key !== yawKey) {
    yawKey = key;
    rebuild();
  }
  models.syncAreas(() => [{ layout, room: null }], `preview${previewKey}`, Date.now());
  scene.updateMatrixWorld();
  renderer.render(scene, rig.camera);
  for (const { it, el, p } of tags) {
    rig.project(p, pt);
    el.style.left = `${pt.x}px`;
    el.style.top = `${pt.y}px`;
    el.classList.toggle('is-model', modelled.has(it.kind));
  }
  requestAnimationFrame(frame);
};
use(theme);
requestAnimationFrame(frame);
Object.assign(window, { agentOfficePreview: { theme: () => theme, rig } });
