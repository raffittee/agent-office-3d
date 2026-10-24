// A rigged character model's profile: what the asset pipeline (scripts/assets/) writes next to the GLB, and what the
// 3D renderer reads to drive it. Model-agnostic: bone and clip names differ between models, so they are mapped here.

/** The bones the renderer moves for procedural poses (type, raise hand, sleep…) and attaches items to. */
export type RigBone =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'upperArmL'
  | 'lowerArmL'
  | 'handL'
  | 'upperArmR'
  | 'lowerArmR'
  | 'handR'
  | 'upperLegL'
  | 'lowerLegL'
  | 'upperLegR'
  | 'lowerLegR';

/** Base animation clips the renderer layers poses on. Only idle, walk and sit are required. */
export type RigClip = 'idle' | 'walk' | 'run' | 'sit' | 'wave' | 'yes' | 'no' | 'thumbsUp' | 'dance' | 'jump';

export interface CharacterProfile {
  /** File name of the GLB next to this profile. */
  file: string;
  /** Asset id in ASSETS.md. */
  asset: string;
  /** The model's height (m) at scale 1, and the scale that makes it ~1.6 m tall in the office. */
  height: number;
  scale: number;
  /** Seated: how far (m) the hips sit behind/above the seat point, at the profile's scale. */
  seat: { back: number; up: number };
  /** Clip names in the GLB. `sit` is played once and held at its last frame. */
  clips: Partial<Record<RigClip, string>> & { idle: string; walk: string; sit: string };
  /** Clips that play once and hold their last frame. */
  holdClips?: RigClip[];
  bones: Record<RigBone, string>;
  /** Bone local axes differ between models: which local axis bends a limb forward (pitch) for this rig. */
  axes?: { pitch: 'x' | 'y' | 'z'; sign: 1 | -1 };
  /** Material slots baked into the `_TINT` mask: recolored per character by its seed. */
  tintSlots: string[];
}
