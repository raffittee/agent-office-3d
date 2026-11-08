// The renderer and the scene (P2-05, P10-03): color management and tone mapping, the fill light and the sun (with
// shadows from medium quality up), the sky, and resizing with a capped device pixel ratio.
import * as THREE from 'three';
import { ambientAt, lightLevelsAt, sunAt, type Ambient, type LightLevels } from '../core/daylight';
import type { Look } from '../themes/look';
import { Sky } from './sky';

export type Quality = 'low' | 'medium' | 'high';

export interface SceneParts {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: Sky;
  quality: Quality;
  /** Whether the sun casts shadows (medium and high). */
  shadows: boolean;
  /** Fits the drawing buffer to the canvas' CSS size; returns true if it changed. */
  resize(): boolean;
  /** Fits the sun's shadow to the building (metres, ground rectangle) and aims the sun at its centre. */
  setBounds(b: { x0: number; z0: number; x1: number; z1: number }, height: number): void;
  /** Once per frame, before rendering: refreshes the shadow map at the quality's rate and the sky. */
  beforeRender(now: number): void;
  dispose(): void;
}

/** The device pixel ratio actually used: capped so a 4K or phone screen doesn't triple the fill cost. */
export function cappedDpr(dpr: number, quality: Quality): number {
  const cap = quality === 'high' ? 2 : quality === 'medium' ? 1.5 : 1;
  return Math.max(1, Math.min(dpr || 1, cap));
}

/** `?quality=low|medium|high` in the URL, or null. */
export function parseQuality(search: string | null | undefined): Quality | null {
  const q = new URLSearchParams(search ?? '').get('quality');
  return q === 'low' || q === 'medium' || q === 'high' ? q : null;
}

/** Shadow map size and refresh interval (frames) per quality; low has no shadows. Pure (tested). */
export function shadowSpec(quality: Quality): { size: number; every: number } | null {
  if (quality === 'low') return null;
  return quality === 'high' ? { size: 4096, every: 1 } : { size: 2048, every: 2 };
}

export function createScene(canvas: HTMLCanvasElement, quality: Quality = 'medium'): SceneParts {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance', alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Khronos PBR Neutral: keeps the theme's colors as authored up to bright highlights, then rolls them off softly
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  const spec = shadowSpec(quality);
  if (spec) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
  }

  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight('#ffffff', '#b9b2a6', 1.9);
  const sun = new THREE.DirectionalLight('#fff3df', 1.6);
  sun.position.set(-20, 40, 30);
  if (spec) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(spec.size, spec.size);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.035;
    sun.shadow.radius = 2;
  }
  scene.add(hemi, sun, sun.target);
  const sky = new Sky(renderer, quality !== 'low');
  scene.background = sky.background;

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

  const bounds = { x0: 0, z0: 0, x1: 1, z1: 1, h: 3 };
  const lastSun = new THREE.Vector3(Infinity, 0, 0);
  let frame = 0;
  return {
    renderer,
    scene,
    sun,
    hemi,
    sky,
    quality,
    shadows: !!spec,
    resize,
    setBounds(b, height) {
      bounds.x0 = b.x0;
      bounds.z0 = b.z0;
      bounds.x1 = b.x1;
      bounds.z1 = b.z1;
      bounds.h = height;
      sun.target.position.set((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
      sun.target.updateMatrixWorld();
      lastSun.set(Infinity, 0, 0);
    },
    beforeRender(now) {
      sky.update(now);
      if (!spec) return;
      // the sun moved (time of day, a new building size): refit its shadow camera
      if (lastSun.distanceToSquared(sun.position) > 1e-4) {
        lastSun.copy(sun.position);
        fitSunShadow(sun, bounds);
        renderer.shadowMap.needsUpdate = true;
      }
      if (++frame % spec.every === 0) renderer.shadowMap.needsUpdate = true;
    },
    dispose() {
      sky.dispose();
      renderer.dispose();
    },
  };
}

const corner = new THREE.Vector3();
const lightView = new THREE.Matrix4();

/** Fits the sun's orthographic shadow camera tightly around the building's box, seen from the sun. */
export function fitSunShadow(sun: THREE.DirectionalLight, b: { x0: number; z0: number; x1: number; z1: number; h: number }): void {
  const cam = sun.shadow.camera;
  sun.updateMatrixWorld();
  sun.target.updateMatrixWorld();
  cam.position.copy(sun.position);
  cam.lookAt(sun.target.position);
  cam.updateMatrixWorld();
  lightView.copy(cam.matrixWorld).invert();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const x of [b.x0 - 1, b.x1 + 1])
    for (const y of [0, b.h + 0.5])
      for (const z of [b.z0 - 1, b.z1 + 1]) {
        corner.set(x, y, z).applyMatrix4(lightView);
        minX = Math.min(minX, corner.x);
        maxX = Math.max(maxX, corner.x);
        minY = Math.min(minY, corner.y);
        maxY = Math.max(maxY, corner.y);
        minZ = Math.min(minZ, corner.z);
        maxZ = Math.max(maxZ, corner.z);
      }
  cam.left = minX;
  cam.right = maxX;
  cam.bottom = minY;
  cam.top = maxY;
  // the camera looks down −z in its own space
  cam.near = Math.max(0.1, -maxZ - 1);
  cam.far = -minZ + 1;
  cam.updateProjectionMatrix();
}

/** Applies a theme's lighting rig and background at midday (P4-02; the preview page). */
export function applyLighting(parts: SceneParts, look: Look): void {
  const a = ambientAt(12);
  applyDaylight(parts, look, a, lightLevelsAt(a, { hemi: look.lighting.intensity, sun: look.lighting.sunIntensity }));
}

const NIGHT_SKY = new THREE.Color('#7e8fd0');
const DAWN_SUN = new THREE.Color('#ffb070');
const MOON = new THREE.Color('#9fb4ff');
const DAY_TOP = new THREE.Color('#9fc2ea');
const NIGHT_TOP = new THREE.Color('#0d1430');
const NIGHT_HORIZON = new THREE.Color('#2a3566');
const DUSK_TOP = new THREE.Color('#5b5d9e');
const tmpA = new THREE.Color();
const tmpL = new THREE.Color();

/** Relative luminance of a (linear) color. */
function luminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Scales `c` so it has the luminance of `like`: a tint changes the hue of a light, the levels set its brightness. */
export function keepLuminance(c: THREE.Color, like: THREE.Color): THREE.Color {
  const l = luminance(c);
  return l > 1e-6 ? c.multiplyScalar(luminance(like) / l) : c.copy(like);
}
const tmpB = new THREE.Color();
const tmpD = new THREE.Vector3();

/**
 * Day and night (P6-02, P10-19) over the theme's lighting. By day a strong sun over a softer fill (shadows and
 * contrast); the sun warms at dawn and dusk and crosses the sky from east to west; after dark a dim moon and fill, a
 * higher exposure, and rooms lit by their lamps (`LightLevels` gains, applied by the building). The sky gradient and
 * the reflections follow the same keys, so the outside, the light and the windows agree.
 */
export function applyDaylight(parts: SceneParts, look: Look, a: Ambient, levels: LightLevels): void {
  const l = look.lighting;
  const n = a.night;
  keepLuminance(parts.hemi.color.set(l.sky).lerp(NIGHT_SKY, n * 0.7), tmpL.set(l.sky));
  keepLuminance(parts.hemi.groundColor.set(l.ground).lerp(NIGHT_SKY, n * 0.4), tmpL.set(l.ground));
  parts.hemi.intensity = l.intensity * levels.hemi;
  tmpA.set(l.sun).lerp(DAWN_SUN, a.warm * 0.7).lerp(MOON, n);
  keepLuminance(parts.sun.color.copy(tmpA), tmpL.set(l.sun));
  parts.sun.intensity = l.sunIntensity * levels.sun;
  parts.renderer.toneMappingExposure = levels.exposure;
  // the sun's path: east (+x) at sunrise, high over the south at noon, west (−x) at sunset; it stands a little to the
  // camera's side, so shadows fall where they can be seen. The moon stands high in the south-west.
  const sun = sunAt(a.hour);
  const target = parts.sun.target.position;
  if (sun.up && n < 0.95) {
    const el = 0.2 + 0.8 * sun.elevation;
    parts.sun.position.set(target.x + Math.cos(sun.azimuth) * 42, target.y + 14 + el * 42, target.z + 14 + 8 * (1 - sun.elevation));
  } else parts.sun.position.set(target.x - 20, target.y + 45, target.z + 25);
  // the sky: a clear blue by day, warm at the horizon at dawn and dusk, deep blue at night
  const out = tmpB.setRGB(a.outside[0] / 255, a.outside[1] / 255, a.outside[2] / 255, THREE.SRGBColorSpace);
  const c = parts.sky.colors;
  c.horizon.set(look.background).multiply(out).lerp(NIGHT_HORIZON, n * 0.85);
  c.top.copy(DAY_TOP).lerp(DUSK_TOP, a.warm * 0.6).lerp(NIGHT_TOP, n);
  c.ground.set(look.groundColor).multiplyScalar(0.8 - 0.6 * n);
  c.sunDir.copy(tmpD.subVectors(parts.sun.position, target).normalize());
  c.sunColor.copy(parts.sun.color);
  c.sun = levels.glint;
}
