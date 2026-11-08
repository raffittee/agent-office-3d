// Window glass (P10-20): reflects the sky's environment map (render3d/sky.ts), catches the sun as a soft diagonal glint
// that slides across the panes as the sun crosses the sky, and glows warm after dark when the room behind it is lit.
// One material per area (its glow depends on the room's light); the sun's uniforms are shared by all of them.
import * as THREE from 'three';
import { sunAt, type Ambient, type LightLevels } from '../core/daylight';

/** Uniforms every pane shares: the sun's glint color (already scaled by its strength), its phase and direction. */
export const glassShared = {
  uGlint: { value: new THREE.Color(0, 0, 0) },
  uGlintPhase: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
};

const WARM = new THREE.Color('#ffc98a');

/** The glint's phase for an hour: one sweep per pane period over the day. Pure (tested). */
export function glintPhase(hour: number): number {
  const s = sunAt(hour);
  return s.azimuth / Math.PI;
}

/** Updates the shared sun uniforms from the ambient and the light levels. */
export function updateGlass(a: Ambient, levels: LightLevels, sunColor: THREE.Color, sunDir: THREE.Vector3): void {
  glassShared.uGlint.value.copy(sunColor).multiplyScalar(levels.glint * 2.1);
  glassShared.uGlintPhase.value = glintPhase(a.hour);
  glassShared.uSunDir.value.copy(sunDir).normalize();
}

const VERT_HEAD = /* glsl */ `
varying vec3 vGW;
varying vec3 vGN;
`;

const FRAG_HEAD = /* glsl */ `
uniform vec3 uGlint;
uniform float uGlintPhase;
uniform vec3 uSunDir;
uniform vec3 uGlow;
varying vec3 vGW;
varying vec3 vGN;
`;

// A diagonal band across each pane (period ~2.9 m), plus a thin second streak: the classic stylized glass shine.
// Only faces turned towards the sun catch it; the glint and the glow also make the pane more opaque, so they read.
const FRAG_GLINT = /* glsl */ `
#include <emissivemap_fragment>
{
  vec3 gn = normalize(vGN);
  float facing = smoothstep(-0.1, 0.6, dot(gn, normalize(vec3(uSunDir.x, 0.25, uSunDir.z))));
  float gd = dot(vGW, vec3(0.62, 0.78, 0.62)) * 0.35 - uGlintPhase;
  float gf = fract(gd) - 0.5;
  float band = exp(-gf * gf * 60.0) + 0.6 * exp(-(gf - 0.16) * (gf - 0.16) * 900.0);
  vec3 glint = uGlint * band * facing;
  totalEmissiveRadiance += glint + uGlow;
  diffuseColor.a = min(1.0, diffuseColor.a + dot(glint, vec3(0.33)) * 0.6 + dot(uGlow, vec3(0.33)) * 0.5);
}
`;

export interface GlassMaterial extends THREE.MeshStandardMaterial {
  /** This pane's glow (the room behind it, lit after dark). */
  glow: THREE.Color;
}

/** A pane material: reflective, slightly blue, transparent. `env` is the sky's environment map (null on low quality). */
export function createGlassMaterial(env: THREE.Texture | null): GlassMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    roughness: 0.06,
    metalness: 0.35,
    envMap: env,
    envMapIntensity: 1.15,
  }) as GlassMaterial;
  const glow = new THREE.Color(0, 0, 0);
  m.glow = glow;
  const uGlow = { value: glow };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, glassShared, { uGlow });
    shader.vertexShader = VERT_HEAD + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vGW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n vGN = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = FRAG_HEAD + shader.fragmentShader.replace('#include <emissivemap_fragment>', FRAG_GLINT);
  };
  m.customProgramCacheKey = () => 'agent-office-glass';
  return m;
}

/** Sets a pane's glow: warm, for a lit room after dark (`light` 0..1, `share` how much of it shows through). */
export function setGlassGlow(m: GlassMaterial, levels: LightLevels, light: number, share = 1): void {
  m.glow.copy(WARM).multiplyScalar(levels.glassGlow * Math.max(0, Math.min(1, light)) * 0.55 * share);
}
