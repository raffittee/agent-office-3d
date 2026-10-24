// Third-party asset sources (every one is also listed in ASSETS.md). Downloads go to assets-src/ (git-ignored) and are
// checked against the pinned SHA-256 before the pipeline touches them.
import type { CharacterProfile } from '../../shared/character-profile';

export interface Source {
  id: string;
  url: string;
  /** Pinned SHA-256 of the download; null = not pinned yet (fetch prints it so it can be pinned). */
  sha256: string | null;
  author: string;
  license: 'CC0-1.0';
  /** For a zip: the entry to extract. */
  entry?: string;
}

export const SOURCES: Source[] = [
  {
    id: 'robot-expressive',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/r180/examples/models/gltf/RobotExpressive/RobotExpressive.glb',
    sha256: '047f5e5fb3bb6d378bd1df16ca6137f2a596c99b3a1b5690b4020c05aaf6f319',
    author: 'Tomás Laulhé (Quaternius); modifications by Don McCurdy',
    license: 'CC0-1.0',
  },
  {
    id: 'universal-animation-library',
    url: 'https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip',
    sha256: null,
    author: 'Quaternius',
    license: 'CC0-1.0',
    entry: 'Animation Library[Standard]/Godot/AnimationLibrary_Godot_Standard.glb',
  },
];

/** A character the pipeline builds: source, the joints to keep, the slots to recolor, and the runtime profile. */
export interface CharacterBuild {
  id: string;
  source: string;
  keepJoint(name: string): boolean;
  /** Height (m) the character should have in the office; the build measures the model and sets `scale`. */
  targetHeight: number;
  profile: Omit<CharacterProfile, 'file' | 'asset' | 'height' | 'scale'>;
}

const ROBOT_FINGERS = /^(Middle|Thumb|Index|Ring|Palm1|Palm3)/;

export const CHARACTERS: CharacterBuild[] = [
  {
    id: 'robot',
    source: 'robot-expressive',
    keepJoint: (name) => !ROBOT_FINGERS.test(name),
    targetHeight: 1.2,
    profile: {
      seat: { back: 0, up: 0.3 },
      clips: { idle: 'Idle', walk: 'Walking', run: 'Running', sit: 'Sitting', wave: 'Wave', yes: 'Yes', no: 'No', thumbsUp: 'ThumbsUp', dance: 'Dance', jump: 'Jump' },
      holdClips: ['sit'],
      bones: {
        hips: 'Hips',
        spine: 'Abdomen',
        chest: 'Torso',
        neck: 'Neck',
        head: 'Head',
        upperArmL: 'UpperArm.L',
        lowerArmL: 'LowerArm.L',
        handL: 'Palm2.L',
        upperArmR: 'UpperArm.R',
        lowerArmR: 'LowerArm.R',
        handR: 'Palm2.R',
        upperLegL: 'UpperLeg.L',
        lowerLegL: 'LowerLeg.L',
        upperLegR: 'UpperLeg.R',
        lowerLegR: 'LowerLeg.R',
      },
      tintSlots: ['Main'],
    },
  },
];
