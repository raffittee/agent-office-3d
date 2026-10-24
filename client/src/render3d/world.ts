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
import { onThemesChanged, themeById, type ThemeEntry } from '../themes/registry';
import type { SoundCue } from '../audio/scheduler';
import { SoundCues, type SoundView } from '../core/sound-cues';
import { EffectsView } from './effects';
import { ModelView } from './models';
import { loadRigModel, RigView } from './rig';
import { ambientAt, approachAmbient, effectiveHour, parseHourParam, type Ambient, type DaylightMode } from '../core/daylight';
import { applyDaylight, applyLighting, createScene, type Quality } from './scene';
import { ScreenView } from './screens';
import { mx, mz, tm } from './units';

export type Selection = { type: 'agent'; id: string } | { type: 'room'; id: string } | null;

export interface WorldSettings extends WorldOptions {
  cutaway: Cutaway;
  /** Rigged models (when loaded) or the simple capsule people. */
  characters: 'rigged' | 'capsule';
  /** The theme pack id (P4-09); '' = the server's default. */
  theme: string;
  /** Day and night (P6-02): follow the local time, or always day / night. */
  daylight: DaylightMode;
}

export const DEFAULT_WORLD_SETTINGS: WorldSettings = { ...DEFAULT_WORLD_OPTIONS, cutaway: 'cut', characters: 'rigged', theme: '', daylight: 'auto' };

/** Where the pipeline's character assets are served from, and the default character. */
const CHARACTER_BASE = 'assets/characters';
const CHARACTER_ID = 'robot';

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
  /** The theme in use. */
  theme(): ThemeEntry;
  /** Frame stats for the debug readout and the smoke test. */
  stats(): { fps: number; cpuMs: number; phases: { sim: number; sync: number; render: number; labels: number }; calls: number; triangles: number; agents: number; rooms: number };
  /** Ambient sound cues (P6-05): keys, elevator dings, games. The UI decides whether they play. */
  onSound(cb: (cue: SoundCue) => void): () => void;
  readonly sim: Sim;
  destroy(): void;
}

/** Pick radius around a character's body (CSS px). */
const PICK_PX = 26;

export function createWorld(canvas: HTMLCanvasElement, overlayParent: HTMLElement, store: OfficeStore, initial: Partial<WorldSettings> = {}, quality: Quality = 'medium'): WorldApi {
  let options: WorldSettings = { ...DEFAULT_WORLD_SETTINGS, ...initial };
  const parts = createScene(canvas, quality);
  const { renderer, scene } = parts;
  // world matrices are updated once per frame in the loop (before attachments), not again inside render()
  scene.matrixWorldAutoUpdate = false;
  // ---- theme: the pack picked in settings, else the server's default (AGENT_OFFICE_THEME), else the built-in default
  let theme = themeById(options.theme || store.snapshot?.meta.theme);
  const sim = new Sim({ options: () => options, roomTheme: (seed) => theme.look.roomTheme(seed), template: theme.look.template });
  const building = new BuildingView(theme.look);
  const models = new ModelView((ready) => building.setLook(theme.look, ready));
  const chars = new CharacterView();
  const cues = new SoundCues(sim);
  const soundCbs = new Set<(c: SoundCue) => void>();
  const soundPt = { x: 0, y: 0 };
  const soundV = new THREE.Vector3();
  const soundView: SoundView = {
    visible(x, y) {
      rig2d.project(soundV.set(mx(x), 0.8, mz(y)), soundPt);
      return soundPt.x > -40 && soundPt.y > -40 && soundPt.x < canvas.clientWidth + 40 && soundPt.y < canvas.clientHeight + 40;
    },
    pan(x, y) {
      rig2d.project(soundV.set(mx(x), 0.8, mz(y)), soundPt);
      const half = Math.max(1, canvas.clientWidth / 2);
      return Math.max(-0.7, Math.min(0.7, ((soundPt.x - half) / half) * 0.7));
    },
    // closer zoom, louder: ~40 px per metre is the overview, ~160 a close-up
    near: () => Math.max(0.45, Math.min(1, 0.3 + rig2d.pxPerMetre / 230)),
  };
  const screens = new ScreenView();
  const effects = new EffectsView();
  scene.add(building.root, models.root, chars.root, screens.mesh, effects.root);
  const applyTheme = (next: ThemeEntry) => {
    theme = next;
    applyLighting(parts, next.look);
    ambientAt_ = 0;
    models.setTheme(next);
    building.setLook(next.look, models.ready);
    // the sim keeps everyone where they are: rooms only get new palettes and walls
    sim.restyle(next.look.template);
  };
  applyLighting(parts, theme.look);
  models.setTheme(theme);
  // ---- day and night: ?hour=21:30 forces an hour (screenshots, checking a theme at night)
  const hourOverride = parseHourParam(location.search);
  const targetAmbient = () => ambientAt(effectiveHour(options.daylight, hourOverride, new Date()));
  let ambient: Ambient = targetAmbient();
  let ambientAt_ = 0;
  const updateDaylight = (t: number) => {
    if (t - ambientAt_ < 250) return;
    ambientAt_ = t;
    // eases over about a second when the setting changes; the clock itself moves slowly anyway
    ambient = approachAmbient(ambient, targetAmbient(), 0.3);
    applyDaylight(parts, theme.look, ambient);
    building.setAmbient(ambient.night, ambient.inside);
  };
  const offThemes = onThemesChanged(() => applyTheme(themeById(theme.look.id)));
  const rig2d = new CameraRig();
  const overlay = new Overlay(overlayParent);
  canvas.tabIndex = 0;
  // rigged characters replace the capsules once their model has loaded
  let rig: RigView | null = null;
  loadRigModel(CHARACTER_BASE, CHARACTER_ID)
    .then((model) => {
      rig = new RigView(model);
      rig.providerColors = chars.providerColors;
      scene.add(rig.root);
    })
    .catch((err: unknown) => console.warn('[world] rigged characters unavailable, using capsules', err));
  const useRig = () => !!rig && options.characters === 'rigged';
  const view = () => (useRig() ? rig! : chars);

  let selection: Selection = null;
  const selectCbs = new Set<(s: Selection) => void>();
  const hoverCbs = new Set<(h: { id: string; x: number; y: number } | null) => void>();
  let framed = false;
  let fps = 0;
  /** Smoothed JavaScript time per frame (sim, scene sync, render submission, labels), in ms. */
  let cpuMs = 0;
  /** Smoothed time per phase (ms): the sim, scene sync (meshes, rigs, screens), render submission, labels. */
  const phases = { sim: 0, sync: 0, render: 0, labels: 0 };
  const ema = (k: keyof typeof phases, v: number) => (phases[k] = phases[k] ? phases[k] * 0.95 + v * 0.05 : v);

  // ---- data
  const applyProviders = () => {
    const colors = new Map((store.snapshot?.meta.providers ?? []).map((p) => [p.id, p.color]));
    chars.providerColors = colors;
    if (rig) rig.providerColors = colors;
    overlay.providerColors = colors;
    chars.repaint();
  };
  let providersKey = '';
  const onSnapshot = () => {
    const snap = store.snapshot;
    if (!snap) return;
    // no theme picked here: follow the server's default
    if (!options.theme && snap.meta.theme && snap.meta.theme !== theme.look.id) {
      const next = themeById(snap.meta.theme);
      if (next.look.id !== theme.look.id) applyTheme(next);
    }
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
    else if (!sel) rig2d.follow = null;
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
        view().headPoint(c, tmpV);
        tmpV.y *= h;
        rig2d.project(tmpV, pt);
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
    const g = rig2d.groundAt(x, y);
    if (!g) return null;
    for (const r of sim.rooms.values()) {
      if (!r.present || r.ghost) continue;
      const rect = r.layout.rect;
      if (g.x >= tm(rect.x) && g.x < tm(rect.x + rect.w) && g.z >= tm(rect.y) && g.z < tm(rect.y + rect.h)) return r.id;
    }
    return null;
  };

  const followAgent = (id: string) => {
    rig2d.follow = () => {
      const c = sim.chars.get(id);
      return c ? { x: mx(c.x), z: mz(c.y) } : null;
    };
  };

  const offInput = attachInput(canvas, rig2d, {
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
    const t0 = performance.now();
    const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
    last = t;
    if (dt > 0) fps = fps ? fps * 0.95 + (1 / dt) * 0.05 : 1 / dt;
    const now = Date.now();
    if (parts.resize() || !framed) rig2d.setViewport(canvas.clientWidth, canvas.clientHeight);
    const tSim = performance.now();
    sim.update(dt, now);
    ema('sim', performance.now() - tSim);
    if (!framed && sim.initialized) {
      framed = true;
      const b = building.bounds(sim);
      rig2d.frame(b);
      rig2d.zoom = rig2d.zoomGoal;
      rig2d.target.copy(rig2d.targetGoal);
    }
    rig2d.update(dt);
    updateDaylight(t);
    const tSync = performance.now();
    building.sync(sim, rig2d.yaw, options.cutaway, now);
    models.sync(sim, now);
    screens.sync(sim, now);
    const onScreen = (c: { x: number; y: number }) => {
      tmpV.set(mx(c.x), 0.8, mz(c.y));
      rig2d.project(tmpV, pt);
      return pt.x > -80 && pt.y > -80 && pt.x < canvas.clientWidth + 80 && pt.y < canvas.clientHeight + 80;
    };
    if (useRig()) {
      rig!.root.visible = true;
      chars.root.visible = false;
      rig!.sync(sim.chars.values(), dt, onScreen);
      // one world-matrix update per frame: the attachments read bone positions from it, and render() skips its own
      scene.updateMatrixWorld();
      rig!.attach();
    } else {
      if (rig) rig.root.visible = false;
      chars.root.visible = true;
      chars.sync(sim.chars.values(), dt);
    }
    effects.sync(sim, view(), now, dt);
    sim.effects.length = 0;
    if (soundCbs.size && sim.initialized) cues.update(now, soundView, (c) => soundCbs.forEach((cb) => cb(c)));
    if (!useRig()) scene.updateMatrixWorld();
    const tRender = performance.now();
    ema('sync', tRender - tSync);
    renderer.render(scene, rig2d.camera);
    const tLabels = performance.now();
    ema('render', tLabels - tRender);
    overlay.update(sim.chars.values(), sim.rooms.values(), view(), rig2d, options, selection?.type === 'agent' ? selection.id : null, now);
    ema('labels', performance.now() - tLabels);
    const spent = performance.now() - t0;
    cpuMs = cpuMs ? cpuMs * 0.95 + spent * 0.05 : spent;
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
      rig2d.focus(mx(c.x), mz(c.y), Math.min(rig2d.zoomGoal, 16));
      if (opts?.follow ?? options.followSelected) followAgent(id);
    },
    focusRoom(id) {
      const r = sim.rooms.get(id);
      if (!r) return;
      const rect = r.layout.rect;
      rig2d.frame({ x0: tm(rect.x), z0: tm(rect.y), x1: tm(rect.x + rect.w), z1: tm(rect.y + rect.h) });
    },
    overview() {
      rig2d.frame(building.bounds(sim));
    },
    zoomBy: (f) => rig2d.zoomBy(f),
    rotate: (s) => rig2d.rotate(s),
    getOptions: () => ({ ...options }),
    setOptions(o) {
      const themeChanged = o.theme !== undefined && o.theme !== options.theme;
      options = { ...options, ...o };
      if (themeChanged) {
        const next = themeById(options.theme || store.snapshot?.meta.theme);
        if (next.look.id !== theme.look.id) applyTheme(next);
      }
      if (o.followSelected === false) rig2d.follow = null;
      if (o.followSelected && selection?.type === 'agent') followAgent(selection.id);
    },
    screenPositionOf(agentId) {
      const c = sim.chars.get(agentId);
      if (!c || c.inside || c.gone) return null;
      rig2d.project(view().headPoint(c, tmpV), pt);
      const r = canvas.getBoundingClientRect();
      if (pt.x < 0 || pt.y < 0 || pt.x > r.width || pt.y > r.height) return null;
      return { x: pt.x + r.left, y: pt.y + r.top };
    },
    setViewInsets(insets) {
      rig2d.insets = { ...rig2d.insets, ...insets };
    },
    theme: () => theme,
    onSound(cb) {
      soundCbs.add(cb);
      return () => soundCbs.delete(cb);
    },
    stats: () => ({ fps: Math.round(fps), cpuMs: +cpuMs.toFixed(2), phases: { sim: +phases.sim.toFixed(2), sync: +phases.sync.toFixed(2), render: +phases.render.toFixed(2), labels: +phases.labels.toFixed(2) }, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, agents: sim.chars.size, rooms: [...sim.rooms.values()].filter((r) => !r.ghost).length }),
    destroy() {
      stop();
      offSnap();
      offThemes();
      offInput();
      document.removeEventListener('visibilitychange', onVisibility);
      overlay.dispose();
      building.dispose();
      models.dispose();
      effects.dispose();
      screens.dispose();
      chars.dispose();
      parts.dispose();
    },
  };
  return api;
}
