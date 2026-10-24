// The 3D world: store → sim (core/) → building, characters and labels (Three.js + DOM overlay), with the camera
// rig, picking and the API the UI panels use. Pauses while the tab is hidden and fast-forwards the sim on return.
import * as THREE from 'three';
import { DEFAULT_WORLD_OPTIONS, type WorldOptions } from '../core/options';
import { Sim } from '../core/sim/sim';
import type { OfficeStore } from '../net/store';
import { BuildingView, type Cutaway } from './building';
import { attachInput, CameraRig, type ViewInsets } from './camera';
import { CharacterView } from './characters';
import { Overlay } from './overlay';
import { createScene, type Quality } from './scene';
import { mx, mz, tm } from './units';

export type Selection = { type: 'agent'; id: string } | { type: 'room'; id: string } | null;

export interface WorldSettings extends WorldOptions {
  cutaway: Cutaway;
}

export const DEFAULT_WORLD_SETTINGS: WorldSettings = { ...DEFAULT_WORLD_OPTIONS, cutaway: 'cut' };

export interface WorldApi {
  select(sel: Selection, opts?: { focus?: boolean }): void;
  getSelection(): Selection;
  onSelect(cb: (sel: Selection) => void): () => void;
  /** The agent under the pointer, with its viewport position (for a tooltip), or null. */
  onHover(cb: (hit: { id: string; x: number; y: number } | null) => void): () => void;
  focusAgent(id: string, opts?: { follow?: boolean }): void;
  focusRoom(id: string): void;
  overview(): void;
  zoomBy(factor: number): void;
  rotate(steps: number): void;
  getOptions(): WorldSettings;
  setOptions(o: Partial<WorldSettings>): void;
  /** Viewport position just above an agent's head, or null when it isn't on screen. */
  screenPositionOf(agentId: string): { x: number; y: number } | null;
  setViewInsets(insets: Partial<ViewInsets>): void;
  /** Frame stats for the debug readout and the smoke test. */
  stats(): { fps: number; calls: number; triangles: number; agents: number; rooms: number };
  readonly sim: Sim;
  destroy(): void;
}

/** Pick radius around a character's body (CSS px). */
const PICK_PX = 26;

export function createWorld(canvas: HTMLCanvasElement, overlayParent: HTMLElement, store: OfficeStore, initial: Partial<WorldSettings> = {}, quality: Quality = 'medium'): WorldApi {
  let options: WorldSettings = { ...DEFAULT_WORLD_SETTINGS, ...initial };
  const parts = createScene(canvas, quality);
  const { renderer, scene } = parts;
  const sim = new Sim({ options: () => options });
  const building = new BuildingView();
  const chars = new CharacterView();
  scene.add(building.root, chars.root);
  const rig = new CameraRig();
  const overlay = new Overlay(overlayParent);
  canvas.tabIndex = 0;

  let selection: Selection = null;
  const selectCbs = new Set<(s: Selection) => void>();
  const hoverCbs = new Set<(h: { id: string; x: number; y: number } | null) => void>();
  let framed = false;
  let fps = 0;

  // ---- data
  const applyProviders = () => {
    const colors = new Map((store.snapshot?.meta.providers ?? []).map((p) => [p.id, p.color]));
    chars.providerColors = colors;
    overlay.providerColors = colors;
    chars.repaint();
  };
  let providersKey = '';
  const onSnapshot = () => {
    const snap = store.snapshot;
    if (!snap) return;
    sim.applySnapshot(snap, Date.now());
    const key = snap.meta.providers.map((p) => `${p.id}:${p.color}`).join();
    if (key !== providersKey) {
      providersKey = key;
      applyProviders();
    }
    if (selection?.type === 'agent' && !snap.agents.some((a) => a.id === selection!.id) && !sim.chars.has(selection.id)) setSelection(null);
  };
  const offSnap = store.on('snapshot', onSnapshot);
  if (store.snapshot) onSnapshot();

  // ---- selection and picking
  const setSelection = (sel: Selection) => {
    const same = JSON.stringify(sel) === JSON.stringify(selection);
    selection = sel;
    if (sel?.type === 'agent' && options.followSelected) followAgent(sel.id);
    else if (!sel) rig.follow = null;
    if (!same) selectCbs.forEach((cb) => cb(sel));
  };

  const tmpV = new THREE.Vector3();
  const pt = { x: 0, y: 0 };
  const pick = (x: number, y: number): string | null => {
    let best: string | null = null;
    let bestD = PICK_PX;
    for (const c of sim.chars.values()) {
      if (c.gone || c.inside || c.alpha < 0.3) continue;
      // test the head and the middle of the body
      for (const h of [1, 0.55]) {
        chars.headPoint(c, tmpV);
        tmpV.y *= h;
        rig.project(tmpV, pt);
        const d = Math.hypot(pt.x - x, pt.y - y);
        if (d < bestD) {
          bestD = d;
          best = c.id;
        }
      }
    }
    return best;
  };
  const roomAt = (x: number, y: number): string | null => {
    const g = rig.groundAt(x, y);
    if (!g) return null;
    for (const r of sim.rooms.values()) {
      if (!r.present || r.ghost) continue;
      const rect = r.layout.rect;
      if (g.x >= tm(rect.x) && g.x < tm(rect.x + rect.w) && g.z >= tm(rect.y) && g.z < tm(rect.y + rect.h)) return r.id;
    }
    return null;
  };

  const followAgent = (id: string) => {
    rig.follow = () => {
      const c = sim.chars.get(id);
      return c ? { x: mx(c.x), z: mz(c.y) } : null;
    };
  };

  const offInput = attachInput(canvas, rig, {
    click(x, y) {
      const id = pick(x, y);
      if (id) setSelection({ type: 'agent', id });
      else {
        const room = roomAt(x, y);
        setSelection(room ? { type: 'room', id: room } : null);
      }
    },
    hover(x, y) {
      const id = pick(x, y);
      canvas.style.cursor = id ? 'pointer' : '';
      hoverCbs.forEach((cb) => cb(id ? { id, x, y } : null));
    },
    leave() {
      hoverCbs.forEach((cb) => cb(null));
    },
    overview: () => api.overview(),
    escape: () => setSelection(null),
  });

  // ---- loop
  let raf = 0;
  let last = performance.now();
  let running = false;
  const frame = (t: number) => {
    raf = 0;
    if (!running) return;
    const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
    last = t;
    if (dt > 0) fps = fps ? fps * 0.95 + (1 / dt) * 0.05 : 1 / dt;
    const now = Date.now();
    if (parts.resize() || !framed) rig.setViewport(canvas.clientWidth, canvas.clientHeight);
    sim.update(dt, now);
    if (!framed && sim.initialized) {
      framed = true;
      const b = building.bounds(sim);
      rig.frame(b);
      rig.zoom = rig.zoomGoal;
      rig.target.copy(rig.targetGoal);
    }
    rig.update(dt);
    building.sync(sim, rig.yaw, options.cutaway, now);
    chars.sync(sim.chars.values(), dt);
    sim.effects.length = 0;
    renderer.render(scene, rig.camera);
    overlay.update(sim.chars.values(), sim.rooms.values(), chars, rig, options, selection?.type === 'agent' ? selection.id : null, now);
    raf = requestAnimationFrame(frame);
  };
  const start = () => {
    if (running) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  const onVisibility = () => {
    if (document.hidden) stop();
    else {
      // everyone jumps to where they were going while the tab was hidden
      if (sim.initialized) sim.fastForward(Date.now());
      start();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();

  const api: WorldApi = {
    sim,
    select(sel, opts) {
      setSelection(sel);
      if (opts?.focus && sel?.type === 'agent') api.focusAgent(sel.id);
      if (opts?.focus && sel?.type === 'room') api.focusRoom(sel.id);
    },
    getSelection: () => selection,
    onSelect(cb) {
      selectCbs.add(cb);
      return () => void selectCbs.delete(cb);
    },
    onHover(cb) {
      hoverCbs.add(cb);
      return () => void hoverCbs.delete(cb);
    },
    focusAgent(id, opts) {
      const c = sim.chars.get(id);
      if (!c) return;
      rig.focus(mx(c.x), mz(c.y), Math.min(rig.zoomGoal, 16));
      if (opts?.follow ?? options.followSelected) followAgent(id);
    },
    focusRoom(id) {
      const r = sim.rooms.get(id);
      if (!r) return;
      const rect = r.layout.rect;
      rig.frame({ x0: tm(rect.x), z0: tm(rect.y), x1: tm(rect.x + rect.w), z1: tm(rect.y + rect.h) });
    },
    overview() {
      rig.frame(building.bounds(sim));
    },
    zoomBy: (f) => rig.zoomBy(f),
    rotate: (s) => rig.rotate(s),
    getOptions: () => ({ ...options }),
    setOptions(o) {
      options = { ...options, ...o };
      if (o.followSelected === false) rig.follow = null;
      if (o.followSelected && selection?.type === 'agent') followAgent(selection.id);
    },
    screenPositionOf(agentId) {
      const c = sim.chars.get(agentId);
      if (!c || c.inside || c.gone) return null;
      rig.project(chars.headPoint(c, tmpV), pt);
      const r = canvas.getBoundingClientRect();
      if (pt.x < 0 || pt.y < 0 || pt.x > r.width || pt.y > r.height) return null;
      return { x: pt.x + r.left, y: pt.y + r.top };
    },
    setViewInsets(insets) {
      rig.insets = { ...rig.insets, ...insets };
    },
    stats: () => ({ fps: Math.round(fps), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, agents: sim.chars.size, rooms: [...sim.rooms.values()].filter((r) => !r.ghost).length }),
    destroy() {
      stop();
      offSnap();
      offInput();
      document.removeEventListener('visibilitychange', onVisibility);
      overlay.dispose();
      building.dispose();
      chars.dispose();
      parts.dispose();
    },
  };
  return api;
}
