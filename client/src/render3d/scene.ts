// The renderer and the scene (P2-05): color management, lights, resizing with a capped device pixel ratio.
import * as THREE from 'three';
import { sunAt, type Ambient } from '../core/daylight';
import type { Look } from '../themes/look';

export type Quality = 'low' | 'medium' | 'high';

export interface SceneParts {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  /** Fits the drawing buffer to the canvas' CSS size; returns true if it changed. */
  resize(): boolean;
  dispose(): void;
}

/** The device pixel ratio actually used: capped so a 4K or phone screen doesn't triple the fill cost. */
export function cappedDpr(dpr: number, quality: Quality): number {
  const cap = quality === 'high' ? 2 : quality === 'medium' ? 1.5 : 1;
  return Math.max(1, Math.min(dpr || 1, cap));
}

export function createScene(canvas: HTMLCanvasElement, quality: Quality = 'medium'): SceneParts {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance', alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor('#dfe3e8');

  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight('#ffffff', '#b9b2a6', 1.9);
  const sun = new THREE.DirectionalLight('#fff3df', 1.6);
  sun.position.set(-20, 40, 30);
  scene.add(hemi, sun, sun.target);

  let w = 0;
  let h = 0;
  let dpr = 0;
  const resize = (): boolean => {
    const cw = Math.max(1, canvas.clientWidth);
    const ch = Math.max(1, canvas.clientHeight);
    const d = cappedDpr(window.devicePixelRatio, quality);
    if (cw === w && ch === h && d === dpr) return false;
    w = cw;
    h = ch;
    dpr = d;
    renderer.setPixelRatio(d);
    renderer.setSize(cw, ch, false);
    return true;
  };
  resize();

  return {
    renderer,
    scene,
    sun,
    hemi,
    resize,
    dispose() {
      renderer.dispose();
    },
  };
}

/** Applies a theme's lighting rig and background (P4-02). */
export function applyLighting(parts: SceneParts, look: Look): void {
  const l = look.lighting;
  parts.hemi.color.set(l.sky);
  parts.hemi.groundColor.set(l.ground);
  parts.hemi.intensity = l.intensity;
  parts.sun.color.set(l.sun);
  parts.sun.intensity = l.sunIntensity;
  parts.renderer.setClearColor(look.background);
}

const NIGHT_SKY = new THREE.Color('#7e8fd0');
const NIGHT_BACKGROUND = new THREE.Color('#141a2b');
const DAWN_SUN = new THREE.Color('#ffb070');
const MOON = new THREE.Color('#9fb4ff');
const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

/**
 * Day and night (P6-02) over the theme's lighting: the fill light cools and dims at night, the sun warms at dawn and
 * dusk and crosses the sky from east to west, a moon takes over after dark, and the background follows the sky.
 * Lamps, screens and lit rooms (emissive "glow" parts) don't dim, so they read as practical lights at night.
 */
export function applyDaylight(parts: SceneParts, look: Look, a: Ambient): void {
  const l = look.lighting;
  const n = a.night;
  parts.hemi.color.set(l.sky).lerp(NIGHT_SKY, n * 0.7);
  parts.hemi.groundColor.set(l.ground).multiplyScalar(1 - 0.5 * n);
  parts.hemi.intensity = l.intensity * (1 - 0.5 * n);
  tmpA.set(l.sun).lerp(DAWN_SUN, a.warm * 0.7);
  parts.sun.color.copy(tmpA.lerp(MOON, n));
  parts.sun.intensity = l.sunIntensity * (1 - 0.72 * n);
  // the sun's path: east (+x) at sunrise, over the south, west (−x) at sunset; the moon stands high in the south-west
  const sun = sunAt(a.hour);
  const target = parts.sun.target.position;
  if (sun.up && n < 0.95) {
    const el = 0.25 + 0.75 * sun.elevation;
    parts.sun.position.set(target.x + Math.cos(sun.azimuth) * 40, target.y + 15 + el * 40, target.z + 30);
  } else parts.sun.position.set(target.x - 20, target.y + 45, target.z + 25);
  tmpB.setRGB(a.outside[0] / 255, a.outside[1] / 255, a.outside[2] / 255, THREE.SRGBColorSpace);
  tmpA.set(look.background).multiply(tmpB).lerp(NIGHT_BACKGROUND, n * 0.75);
  parts.renderer.setClearColor(tmpA);
}
