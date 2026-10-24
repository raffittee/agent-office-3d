// A theme pack resolved for the renderer and the sim (P4-02). Pure: no three, no DOM. Everything a theme can change goes
// through here — colors, surface patterns, room palettes, kit styles, lighting and decor — and every field falls back
// to the built-in look, so a pack only states what it changes.
import type { DecorSpec, FurnitureSpec, KitRole, LayoutTemplate, MaterialPreset, Surface, ThemePack } from '../../../shared/theme';
import type { AreaKind } from '../core/layout/types';
import { roomTheme as defaultRoomTheme } from '../core/room-theme';
import type { FloorKind, FurnitureKind, RoomTheme, WallPattern, WallStyle } from '../core/vocab';
import type { KitStyle } from '../render3d/kit';

/** How a surface is drawn: a flat color plus a procedural pattern (no textures). */
export type SurfacePattern = 'plain' | 'tile' | 'wood' | 'carpet' | 'concrete' | 'marble' | 'brick';

export interface SurfaceLook {
  color: string;
  pattern: SurfacePattern;
}

export const DEFAULT_FLOOR: Record<FloorKind, string> = {
  carpet: '#c9d1dc',
  wood: '#c79a6b',
  tile_check: '#e7e2d8',
  tile_white: '#e9eef0',
  concrete: '#c4c2bd',
  marble: '#e8e4dc',
  grass: '#8fbf6a',
  sidewalk: '#cfcac0',
  street: '#6b6e73',
};

const FLOOR_PATTERN: Record<FloorKind, SurfacePattern> = {
  carpet: 'carpet',
  wood: 'wood',
  tile_check: 'tile',
  tile_white: 'tile',
  concrete: 'concrete',
  marble: 'marble',
  grass: 'plain',
  sidewalk: 'tile',
  street: 'plain',
};

const PRESET_PATTERN: Record<MaterialPreset, SurfacePattern> = {
  plain: 'plain',
  plaster: 'plain',
  glass: 'plain',
  metal: 'plain',
  wood: 'wood',
  concrete: 'concrete',
  brick: 'brick',
  carpet: 'carpet',
  tile: 'tile',
  marble: 'marble',
};

const PRESET_COLOR: Partial<Record<MaterialPreset, string>> = {
  wood: '#b78a5c',
  concrete: '#9d9b96',
  brick: '#a5573f',
  carpet: '#8a96a6',
  tile: '#e6e3dc',
  marble: '#ece8e0',
  metal: '#8d949c',
  plaster: '#efebe4',
};

/** The wall pattern of the sim's vocabulary for a material preset. */
const PRESET_WALL: Partial<Record<MaterialPreset, WallPattern>> = { brick: 'brick', wood: 'wood_panel', tile: 'tiles', marble: 'marble', glass: 'glass' };

/** Which surface an area's floor is. */
export function floorSurface(kind: AreaKind): Surface {
  switch (kind) {
    case 'room':
      return 'floor';
    case 'corridor':
      return 'corridorFloor';
    case 'lounge':
      return 'loungeFloor';
    case 'restroom':
      return 'restroomFloor';
    default:
      return 'coreFloor';
  }
}

// ---- color helpers (hex in, hex out)

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${((c(r) << 16) | (c(g) << 8) | c(b)).toString(16).padStart(6, '0')}`;
}

/** Mixes two colors (t = 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** Lightens (k > 0) or darkens (k < 0) a color. */
export function shade(color: string, k: number): string {
  return k >= 0 ? mix(color, '#ffffff', k) : mix(color, '#000000', -k);
}

export interface LightingLook {
  sky: string;
  ground: string;
  intensity: number;
  sun: string;
  sunIntensity: number;
  /** The color of practical lights (lamps, bulbs, screens' glow). */
  practical: string;
}

/** A theme, resolved. */
export interface Look {
  id: string;
  name: string;
  pack: ThemePack;
  template: LayoutTemplate;
  wallHeight: number;
  background: string;
  groundColor: string;
  rugTint: string | null;
  lighting: LightingLook;
  decor: DecorSpec[];
  /** A room's palette from its seed (feeds the sim's layout: rug and wall colors, desk and chair variants). */
  roomTheme(seed: number): RoomTheme;
  /** The floor of an area. */
  floor(area: AreaKind, kind: FloorKind, tint?: string): SurfaceLook;
  /** A wall's base color and pattern (rooms carry their own palette in the style; core areas take the theme's wall). */
  wall(area: AreaKind, style: WallStyle): SurfaceLook & { trim: string };
  /** How the theme restyles the procedural kit. */
  kit: KitStyle;
  /** A furniture kind's spec (model, procedural…), if the pack sets one. */
  furniture(kind: FurnitureKind): FurnitureSpec | undefined;
}

const PRACTICAL: Record<string, string> = { none: '#fff1c9', 'edison-bulbs': '#ffb45e', fluorescent: '#eef6ff', neon: '#ff5fd2', warm: '#ffd9a0' };

/** Resolves a validated pack. */
export function resolveLook(pack: ThemePack): Look {
  const m = pack.materials ?? {};
  const surface = (s: Surface, fallback: SurfaceLook): SurfaceLook => {
    const spec = m[s];
    if (!spec) return fallback;
    const pattern = spec.preset ? PRESET_PATTERN[spec.preset] : fallback.pattern;
    return { color: spec.color ?? (spec.preset ? PRESET_COLOR[spec.preset] : undefined) ?? fallback.color, pattern };
  };
  const wallSpec = m.wall;
  const wallColor = wallSpec?.color ?? (wallSpec?.preset ? PRESET_COLOR[wallSpec.preset] : undefined);
  const wallPattern = wallSpec?.preset ? PRESET_WALL[wallSpec.preset] ?? 'plain' : undefined;
  const trim = m.trim?.color;
  const variants = pack.roomVariants ?? [];
  const kitColors = pack.kit ?? {};
  const furniture = pack.furniture ?? {};
  const practicals = pack.lighting?.practicals ?? 'none';

  return {
    id: pack.id,
    name: pack.name,
    pack,
    template: pack.layout.template,
    wallHeight: pack.layout.wallHeight ?? 2.8,
    background: pack.palette.background ?? '#dfe3e8',
    groundColor: m.ground?.color ?? '#cbc6bc',
    rugTint: m.rug?.color ?? null,
    lighting: {
      sky: pack.lighting?.ambient ?? '#ffffff',
      ground: pack.lighting?.ground ?? '#b9b2a6',
      intensity: pack.lighting?.ambientIntensity ?? 1.9,
      sun: pack.lighting?.sun?.color ?? '#fff3df',
      sunIntensity: pack.lighting?.sun?.intensity ?? 1.6,
      practical: practicals === 'neon' ? pack.palette.accent : PRACTICAL[practicals] ?? PRACTICAL.none!,
    },
    decor: pack.decor ?? [],
    roomTheme(seed: number): RoomTheme {
      const base = defaultRoomTheme(seed);
      const n = variants.length;
      const v = n ? variants[((Math.floor(seed) % n) + n) % n]! : null;
      const wall = v?.wall ?? wallColor ?? base.wall.base;
      const carpet = v?.carpet ?? (v ? mix(v.accent, '#ffffff', 0.55) : base.carpet);
      return {
        carpet,
        carpet2: v ? shade(carpet, -0.06) : base.carpet2,
        wall: { base: wall, trim: trim ?? (v || wallColor ? shade(wall, -0.3) : base.wall.trim ?? shade(wall, -0.3)), pattern: wallPattern ?? base.wall.pattern ?? 'plain' },
        accent: v?.accent ?? base.accent,
        deskVariant: v?.desk ?? base.deskVariant,
        chairVariant: v?.chair ?? base.chairVariant,
      };
    },
    floor(area, kind, tint) {
      const fallback: SurfaceLook = { color: kind === 'carpet' && tint ? tint : DEFAULT_FLOOR[kind], pattern: FLOOR_PATTERN[kind] };
      // grass and the street outside stay what they are
      if (kind === 'grass' || kind === 'street') return fallback;
      return surface(floorSurface(area), fallback);
    },
    wall(area, style) {
      const exterior = style.exterior ? m.exteriorWall : undefined;
      let color = style.base;
      let pattern: SurfacePattern = style.pattern === 'brick' ? 'brick' : 'plain';
      if (exterior) {
        color = exterior.color ?? (exterior.preset ? PRESET_COLOR[exterior.preset] : undefined) ?? color;
        if (exterior.preset) pattern = PRESET_PATTERN[exterior.preset];
      } else if (area !== 'room' && wallSpec) {
        // project rooms already carry the theme's wall in their palette (roomTheme); the core takes it here
        color = wallColor ?? color;
        if (wallSpec.preset) pattern = PRESET_PATTERN[wallSpec.preset];
      }
      return { color, pattern, trim: trim ?? style.trim ?? shade(color, -0.25) };
    },
    kit: {
      color(kind, role: KitRole) {
        return furniture[kind]?.colors?.[role] ?? kitColors[role];
      },
      procedural(kind) {
        return furniture[kind]?.procedural;
      },
    },
    furniture(kind) {
      return furniture[kind];
    },
  };
}
