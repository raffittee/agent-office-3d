// Theme packs (P4-01): the types, the required semantic kinds, and a dependency-free validator. A theme changes how
// the office looks, never how it behaves (CLAUDE.md › Theme packs). `themes/theme.schema.json` is the same contract for
// editors; `npm run theme:check` validates every pack.
//
// Pure: no Node or DOM APIs (used by the client's theme runtime and by scripts/theme-check.ts).

export const THEME_SCHEMA_VERSION = 1;

export type LayoutTemplate = 'corridor' | 'open-plan' | 'loft';
export const LAYOUT_TEMPLATES: readonly LayoutTemplate[] = ['corridor', 'open-plan', 'loft'];

/** Surfaces a theme can restyle. */
export type Surface = 'floor' | 'corridorFloor' | 'coreFloor' | 'loungeFloor' | 'restroomFloor' | 'wall' | 'exteriorWall' | 'trim' | 'ground' | 'rug';
export const SURFACES: readonly Surface[] = ['floor', 'corridorFloor', 'coreFloor', 'loungeFloor', 'restroomFloor', 'wall', 'exteriorWall', 'trim', 'ground', 'rug'];

/** Material presets the runtime knows (a texture-free look: tint, roughness and a pattern drawn procedurally). */
export type MaterialPreset = 'plain' | 'wood' | 'concrete' | 'brick' | 'carpet' | 'tile' | 'marble' | 'metal' | 'glass' | 'plaster';
export const MATERIAL_PRESETS: readonly MaterialPreset[] = ['plain', 'wood', 'concrete', 'brick', 'carpet', 'tile', 'marble', 'metal', 'glass', 'plaster'];

export interface MaterialSpec {
  preset?: MaterialPreset;
  color?: string;
  roughness?: number;
}

/** Built-in alternative looks for furniture (FurnitureSpec.procedural), drawn by render3d/kit.ts. */
export const PROCEDURALS = ['default', 'stool', 'trestle', 'cubicle', 'pallet', 'pipe-shelf', 'tufted'] as const;
export type Procedural = (typeof PROCEDURALS)[number];

/**
 * Part roles of the procedural kit: `kit` (theme-wide) and `furniture.<kind>.colors` recolor them. `body` is the main
 * surface, `top` a desk or table top, `frame` legs and metal, `seat` upholstery, `accent` small colored details.
 */
export const KIT_ROLES = ['body', 'top', 'frame', 'seat', 'accent', 'foliage', 'pot', 'screen'] as const;
export type KitRole = (typeof KIT_ROLES)[number];

/**
 * How one furniture kind looks. `model` is a glTF path inside the pack (relative to its folder); `procedural` picks a
 * built-in look with `params` (colors keyed by part: top, legs, frame, seat, accent…). Neither = the default kit look,
 * optionally recolored by `colors`.
 */
export interface FurnitureSpec {
  model?: string;
  /** Scale and yaw (degrees) applied to the model inside the footprint. */
  scale?: number;
  yaw?: number;
  variants?: string[];
  procedural?: Procedural;
  params?: Record<string, string | number | boolean>;
  colors?: Partial<Record<KitRole, string>>;
}

/**
 * Decoration generators the runtime knows. Decor is visual only: it sits on full-height walls, above desks or inside
 * blocking furniture, never on a walkable tile. Wall decor shows where the wall is full height (the far outer walls).
 */
export type DecorKind = 'pipes' | 'beams' | 'pendant_bulbs' | 'plant_wall' | 'neon' | 'certificates' | 'factory_windows' | 'string_lights' | 'fluorescent' | 'wainscot';
export const DECOR_KINDS: readonly DecorKind[] = ['pipes', 'beams', 'pendant_bulbs', 'plant_wall', 'neon', 'certificates', 'factory_windows', 'string_lights', 'fluorescent', 'wainscot'];
export type DecorPlace = 'rooms' | 'core' | 'everywhere';
export const DECOR_PLACES: readonly DecorPlace[] = ['rooms', 'core', 'everywhere'];

export interface DecorSpec {
  kind: DecorKind;
  /** Which areas get it: project rooms, the core (reception, kitchen, lounge, restrooms, corridor) or both. */
  on: DecorPlace;
  /** 0..1, how much of it. */
  density?: number;
  color?: string;
}

/** A per-room palette override, picked by room seed. */
export interface RoomVariant {
  accent: string;
  carpet?: string;
  wall?: string;
  desk?: string;
  chair?: string;
}

export interface ThemePack {
  id: string;
  name: string;
  schema: number;
  description?: string;
  /** Author and license of the pack (and of every file in it; listed in ASSETS.md too). */
  author?: string;
  license?: string;
  /** A preview image inside the pack (.png or .webp), shown by the theme picker. */
  thumbnail?: string;
  layout: { template: LayoutTemplate; wallHeight?: number; roomSize?: [number, number] };
  palette: { base: string; accent: string; background?: string; text?: string };
  materials?: Partial<Record<Surface, MaterialSpec>>;
  lighting?: {
    ambient?: string;
    ambientIntensity?: number;
    ground?: string;
    sun?: { color?: string; intensity?: number };
    practicals?: 'none' | 'edison-bulbs' | 'fluorescent' | 'neon' | 'warm';
  };
  /** Theme-wide colors for the procedural kit's part roles. */
  kit?: Partial<Record<KitRole, string>>;
  furniture?: Partial<Record<string, FurnitureSpec>>;
  decor?: DecorSpec[];
  roomVariants?: RoomVariant[];
  postfx?: { bloom?: number; ao?: boolean };
}

/**
 * The semantic furniture kinds the simulation places, so every pack can style them (P4-01). A pack may leave any of
 * them out: a missing kind falls back to the procedural default kit (render3d/kit.ts).
 */
export const REQUIRED_KINDS = [
  'desk',
  'desk_back',
  'office_chair',
  'office_chair_front',
  'meeting_table',
  'stool',
  'bookshelf',
  'coffee_machine',
  'water_cooler',
  'sofa',
  'armchair',
  'toilet_stall',
  'reception_desk',
  'whiteboard',
  'light_switch',
  'elevator',
] as const;

const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A relative path inside a pack: no '..', no leading slash, no backslashes. */
const PACK_FILE = /^(?!.*\.\.)(?!\/)[\w.-]+(\/[\w.-]+)*$/;

export interface ThemeIssue {
  path: string;
  message: string;
}

/** Validates an unknown value as a ThemePack. Returns the problems found (empty = valid). */
export function validateTheme(v: unknown, knownKinds: ReadonlySet<string> = new Set(REQUIRED_KINDS)): ThemeIssue[] {
  const out: ThemeIssue[] = [];
  const bad = (path: string, message: string) => out.push({ path, message });
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const color = (path: string, x: unknown) => {
    if (x !== undefined && (typeof x !== 'string' || !HEX.test(x))) bad(path, 'expected a #rrggbb color');
  };
  const num = (path: string, x: unknown, min: number, max: number) => {
    if (x !== undefined && (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max)) bad(path, `expected a number from ${min} to ${max}`);
  };
  const allowed = (path: string, o: Record<string, unknown>, keys: readonly string[]) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`${path}.${k}`, 'unknown field');
  };
  if (!isObj(v)) return [{ path: '', message: 'a theme must be an object' }];
  allowed('', v, ['$schema', 'id', 'name', 'schema', 'description', 'author', 'license', 'thumbnail', 'layout', 'palette', 'materials', 'lighting', 'kit', 'furniture', 'decor', 'roomVariants', 'postfx']);
  if (typeof v.id !== 'string' || !ID.test(v.id)) bad('id', 'expected lowercase letters, digits and dashes (max 40)');
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 60) bad('name', 'expected a name of 1 to 60 characters');
  for (const k of ['description', 'author', 'license'] as const) if (v[k] !== undefined && (typeof v[k] !== 'string' || (v[k] as string).length > 300)) bad(k, 'expected text (max 300 characters)');
  if (v.thumbnail !== undefined && !(typeof v.thumbnail === 'string' && PACK_FILE.test(v.thumbnail) && /\.(png|webp)$/.test(v.thumbnail))) bad('thumbnail', 'expected a .png or .webp path inside the pack');
  if (v.schema !== THEME_SCHEMA_VERSION) bad('schema', `expected ${THEME_SCHEMA_VERSION}`);
  if (!isObj(v.layout)) bad('layout', 'required');
  else {
    allowed('layout', v.layout, ['template', 'wallHeight', 'roomSize']);
    if (!LAYOUT_TEMPLATES.includes(v.layout.template as LayoutTemplate)) bad('layout.template', `expected one of ${LAYOUT_TEMPLATES.join(', ')}`);
    num('layout.wallHeight', v.layout.wallHeight, 2, 6);
    if (v.layout.roomSize !== undefined && !(Array.isArray(v.layout.roomSize) && v.layout.roomSize.length === 2 && v.layout.roomSize.every((n) => typeof n === 'number'))) bad('layout.roomSize', 'expected [width, depth]');
  }
  if (!isObj(v.palette)) bad('palette', 'required');
  else {
    allowed('palette', v.palette, ['base', 'accent', 'background', 'text']);
    if (v.palette.base === undefined) bad('palette.base', 'required');
    if (v.palette.accent === undefined) bad('palette.accent', 'required');
    for (const k of ['base', 'accent', 'background', 'text']) color(`palette.${k}`, v.palette[k]);
  }
  if (v.materials !== undefined) {
    if (!isObj(v.materials)) bad('materials', 'expected an object');
    else
      for (const [k, m] of Object.entries(v.materials)) {
        if (!SURFACES.includes(k as Surface)) bad(`materials.${k}`, `unknown surface (known: ${SURFACES.join(', ')})`);
        if (!isObj(m)) {
          bad(`materials.${k}`, 'expected an object');
          continue;
        }
        allowed(`materials.${k}`, m, ['preset', 'color', 'roughness']);
        if (m.preset !== undefined && !MATERIAL_PRESETS.includes(m.preset as MaterialPreset)) bad(`materials.${k}.preset`, `expected one of ${MATERIAL_PRESETS.join(', ')}`);
        color(`materials.${k}.color`, m.color);
        num(`materials.${k}.roughness`, m.roughness, 0, 1);
      }
  }
  if (v.lighting !== undefined) {
    if (!isObj(v.lighting)) bad('lighting', 'expected an object');
    else {
      allowed('lighting', v.lighting, ['ambient', 'ambientIntensity', 'ground', 'sun', 'practicals']);
      color('lighting.ambient', v.lighting.ambient);
      color('lighting.ground', v.lighting.ground);
      num('lighting.ambientIntensity', v.lighting.ambientIntensity, 0, 5);
      if (v.lighting.sun !== undefined) {
        if (!isObj(v.lighting.sun)) bad('lighting.sun', 'expected an object');
        else {
          allowed('lighting.sun', v.lighting.sun, ['color', 'intensity']);
          color('lighting.sun.color', v.lighting.sun.color);
          num('lighting.sun.intensity', v.lighting.sun.intensity, 0, 5);
        }
      }
      if (v.lighting.practicals !== undefined && !['none', 'edison-bulbs', 'fluorescent', 'neon', 'warm'].includes(v.lighting.practicals as string)) bad('lighting.practicals', 'unknown practicals');
    }
  }
  const roleColors = (path: string, x: unknown) => {
    if (x === undefined) return;
    if (!isObj(x)) return bad(path, 'expected an object');
    for (const [r, c] of Object.entries(x)) {
      if (!KIT_ROLES.includes(r as KitRole)) bad(`${path}.${r}`, `unknown part role (known: ${KIT_ROLES.join(', ')})`);
      color(`${path}.${r}`, c);
    }
  };
  roleColors('kit', v.kit);
  if (v.furniture !== undefined) {
    if (!isObj(v.furniture)) bad('furniture', 'expected an object');
    else
      for (const [k, f] of Object.entries(v.furniture)) {
        if (!knownKinds.has(k)) bad(`furniture.${k}`, 'unknown furniture kind');
        if (!isObj(f)) {
          bad(`furniture.${k}`, 'expected an object');
          continue;
        }
        allowed(`furniture.${k}`, f, ['model', 'scale', 'yaw', 'variants', 'procedural', 'params', 'colors']);
        if (f.model !== undefined && !(typeof f.model === 'string' && PACK_FILE.test(f.model) && /\.glb$/.test(f.model))) bad(`furniture.${k}.model`, 'expected a .glb path inside the pack');
        num(`furniture.${k}.scale`, f.scale, 0.01, 100);
        num(`furniture.${k}.yaw`, f.yaw, -360, 360);
        if (f.procedural !== undefined && !PROCEDURALS.includes(f.procedural as Procedural)) bad(`furniture.${k}.procedural`, `expected one of ${PROCEDURALS.join(', ')}`);
        if (f.variants !== undefined && !(Array.isArray(f.variants) && f.variants.every((x) => typeof x === 'string'))) bad(`furniture.${k}.variants`, 'expected a list of strings');
        if (f.params !== undefined && !isObj(f.params)) bad(`furniture.${k}.params`, 'expected an object');
        roleColors(`furniture.${k}.colors`, f.colors);
      }
  }
  if (v.decor !== undefined) {
    if (!Array.isArray(v.decor)) bad('decor', 'expected a list');
    else
      v.decor.forEach((d, i) => {
        if (!isObj(d)) return bad(`decor[${i}]`, 'expected an object');
        allowed(`decor[${i}]`, d, ['kind', 'on', 'density', 'color']);
        if (!DECOR_KINDS.includes(d.kind as DecorKind)) bad(`decor[${i}].kind`, `expected one of ${DECOR_KINDS.join(', ')}`);
        if (!DECOR_PLACES.includes(d.on as DecorPlace)) bad(`decor[${i}].on`, `expected one of ${DECOR_PLACES.join(', ')}`);
        num(`decor[${i}].density`, d.density, 0, 1);
        color(`decor[${i}].color`, d.color);
      });
  }
  if (v.roomVariants !== undefined) {
    if (!Array.isArray(v.roomVariants) || !v.roomVariants.length) bad('roomVariants', 'expected a non-empty list');
    else
      v.roomVariants.forEach((r, i) => {
        if (!isObj(r)) return bad(`roomVariants[${i}]`, 'expected an object');
        allowed(`roomVariants[${i}]`, r, ['accent', 'carpet', 'wall', 'desk', 'chair']);
        if (r.accent === undefined) bad(`roomVariants[${i}].accent`, 'required');
        for (const k of ['accent', 'carpet', 'wall', 'desk', 'chair']) color(`roomVariants[${i}].${k}`, r[k]);
      });
  }
  if (v.postfx !== undefined) {
    if (!isObj(v.postfx)) bad('postfx', 'expected an object');
    else {
      allowed('postfx', v.postfx, ['bloom', 'ao']);
      num('postfx.bloom', v.postfx.bloom, 0, 2);
      if (v.postfx.ao !== undefined && typeof v.postfx.ao !== 'boolean') bad('postfx.ao', 'expected true or false');
    }
  }
  return out;
}

/**
 * The JSON Schema of theme.json, built from the same constants as the validator so the two can't drift.
 * `themes/theme.schema.json` is this object; `npm run theme:check -- --write-schema` rewrites it, and a test compares.
 */
export function themeJsonSchema(): Record<string, unknown> {
  const hex = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
  const packFile = (ext: string) => ({ type: 'string', pattern: `^(?!.*\\.\\.)(?!/)[\\w.-]+(/[\\w.-]+)*\\.(${ext})$` });
  const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
  const num = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum });
  const roles = obj(Object.fromEntries(KIT_ROLES.map((r) => [r, hex])));
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://agent-office.local/theme.schema.json',
    title: 'Agent Office theme pack',
    ...obj(
      {
        $schema: { type: 'string' },
        id: { type: 'string', pattern: ID.source },
        name: { type: 'string', minLength: 1, maxLength: 60 },
        schema: { const: THEME_SCHEMA_VERSION },
        description: { type: 'string', maxLength: 300 },
        author: { type: 'string', maxLength: 300 },
        license: { type: 'string', maxLength: 300 },
        thumbnail: packFile('png|webp'),
        layout: obj({ template: { enum: [...LAYOUT_TEMPLATES] }, wallHeight: num(2, 6), roomSize: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } }, ['template']),
        palette: obj({ base: hex, accent: hex, background: hex, text: hex }, ['base', 'accent']),
        materials: obj(Object.fromEntries(SURFACES.map((s) => [s, obj({ preset: { enum: [...MATERIAL_PRESETS] }, color: hex, roughness: num(0, 1) })]))),
        lighting: obj({
          ambient: hex,
          ambientIntensity: num(0, 5),
          ground: hex,
          sun: obj({ color: hex, intensity: num(0, 5) }),
          practicals: { enum: ['none', 'edison-bulbs', 'fluorescent', 'neon', 'warm'] },
        }),
        kit: roles,
        furniture: {
          type: 'object',
          additionalProperties: obj({
            model: packFile('glb'),
            scale: num(0.01, 100),
            yaw: num(-360, 360),
            variants: { type: 'array', items: { type: 'string' } },
            procedural: { enum: [...PROCEDURALS] },
            params: { type: 'object' },
            colors: roles,
          }),
        },
        decor: { type: 'array', items: obj({ kind: { enum: [...DECOR_KINDS] }, on: { enum: [...DECOR_PLACES] }, density: num(0, 1), color: hex }, ['kind', 'on']) },
        roomVariants: { type: 'array', minItems: 1, items: obj({ accent: hex, carpet: hex, wall: hex, desk: hex, chair: hex }, ['accent']) },
        postfx: obj({ bloom: num(0, 2), ao: { type: 'boolean' } }),
      },
      ['id', 'name', 'schema', 'layout', 'palette'],
    ),
  };
}
