// Night rim light (P10-19): a soft fresnel glow on the silhouette of a character, so people separate from the dark
// floor after dark. It is a few lines in the material's own fragment shader (a uniform `uRim`, 0 = off), so it costs
// no extra draw call and no light. Shared by the rigged characters (rig.ts) and the capsule people (characters.ts).
import * as THREE from 'three';

/** A moonlit blue-white: it reads against the warm lamp light of a lit room and the deep blue of a dark one. */
const RIM_COLOR = 'vec3(0.66, 0.76, 1.0)';

/** The glow at the edges of a surface: `uRim` is the strength; the exponent keeps it to the outline. */
export const RIM_FRAG = /* glsl */ `
#include <emissivemap_fragment>
{
  vec3 rimView = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
  float rimF = pow(1.0 - clamp(dot(normalize(normal), rimView), 0.0, 1.0), 2.2);
  totalEmissiveRadiance += ${RIM_COLOR} * (uRim * rimF);
}
`;

/** A uniform holder the owner updates: `rim.value = 0.4`. */
export interface RimUniform {
  value: number;
}

/** The night rim strength for a night amount (`LightLevels.glassGlow`, 0..1). Pure (tested). */
export function rimAt(glow: number): number {
  const g = Number.isFinite(glow) ? Math.max(0, Math.min(1, glow)) : 0;
  return g * 0.5;
}

/** Adds the rim term to a Lambert material's shader, after any patch the material already has. */
export function addRim(material: THREE.MeshLambertMaterial, uRim: RimUniform): void {
  const prior = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prior.call(material, shader, renderer);
    shader.uniforms.uRim = uRim;
    shader.fragmentShader = 'uniform float uRim;\n' + shader.fragmentShader.replace('#include <emissivemap_fragment>', RIM_FRAG);
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|rim`;
}
