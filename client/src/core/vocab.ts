// Ported from habblaud client/src/art/api.ts (MIT, © 2026 Márcio Junior)
// The vocabulary shared by the simulation, the renderer and theme packs: directions, poses, held items, furniture
// kinds and their footprints, floor kinds, wall styles and screen modes. The sim places things and moves people using
// these words; a theme decides only how each one looks. Changes here are additive: never rename or remove a kind.
//
// Units: the sim works in "world units" on a 2D tile grid, 1 tile = TILE units (Habblaud's pixel scale, kept so the
// ported numbers stay as they are). +x is east, +y is south. The 3D renderer maps (x, y) to (x, z) in metres.

export const TILE = 16;

export type Dir = 'down' | 'up' | 'left' | 'right';

/** Character poses. Seated ones (sit, type, sleep, wait) assume the character is on a seat. */
export type Pose =
  | 'stand'
  | 'walk'
  | 'run'
  | 'sit'
  | 'type' // seated, typing
  | 'sleep' // seated, dozing
  | 'drink' // standing, cup to the mouth (held 'coffee' or 'water')
  | 'use' // standing, operating a machine
  | 'raise_hand' // asking for attention; standing or seated
  | 'talk'
  | 'stretch'
  | 'read'
  | 'play' // ping-pong
  | 'wait' // seated, waiting for something to finish (a shell)
  | 'cheer'
  | 'laugh'
  | 'game'
  | 'rps'
  | 'groom'
  | 'sulk';

export type HeldItem =
  | 'none'
  | 'coffee'
  | 'water'
  | 'papers'
  | 'laptop'
  | 'book'
  | 'box'
  | 'paddle'
  | 'popcorn'
  | 'controller'
  | 'rock'
  | 'paper'
  | 'scissors'
  | 'phone'
  | 'lipstick'
  | 'comb';

/** Small status icons shown above a character. */
export type IconName =
  | 'alert'
  | 'question'
  | 'zzz'
  | 'check'
  | 'heart'
  | 'coffee'
  | 'music'
  | 'idea'
  | 'sweat'
  | 'star'
  | 'lightning'
  | 'chat'
  | 'box'
  | 'wave'
  | 'hourglass'
  | 'hourglass_flip'
  | 'cobweb'
  | 'storm'
  | 'coin'
  | 'sparkle'
  | 'trophy'
  | 'hand_rock'
  | 'hand_paper'
  | 'hand_scissors';

export type FurnitureKind =
  // project rooms
  | 'desk' // 2x1, monitor facing south; the person sits south of it, facing up (back to the camera)
  | 'desk_back' // 2x1, the same desk seen from the other side; the person sits north of it, facing down
  | 'office_chair_front' // 1x1 seat facing down (pairs with desk_back)
  | 'office_chair' // 1x1 seat facing up
  | 'bookshelf' // 2x1 against the north wall
  | 'filing_cabinet'
  | 'printer'
  | 'trash_bin'
  | 'plant_small' // variants: fern | succulent | flower
  | 'plant_tall' // variants: palm | ficus | monstera | bonsai
  | 'glass_partition' // variants: h (east-west) | v (north-south) | end
  | 'binder_shelf'
  | 'meeting_table' // 3x2
  | 'stool' // seat, any direction
  | 'floor_lamp'
  | 'water_cooler' // used from the south, facing up
  // mounted on a wall
  | 'whiteboard' // 3 tiles, kanban board
  | 'window' // 2 tiles
  | 'clock'
  | 'poster' // variants: code | coffee | rocket | cat | bug | ship_it
  | 'painting' // 2 tiles
  | 'tv' // 2 tiles
  | 'light_switch' // variants: on | off
  | 'elevator' // 2 tiles; states 0..4 = closed .. fully open
  | 'door_frame' // 2 tiles, over a doorway in a north wall face
  | 'sign' // 3 tiles, the room's name
  | 'mirror'
  | 'shelf_wall' // 2 tiles
  // kitchen
  | 'counter' // variants: plain | drawers
  | 'counter_sink'
  | 'coffee_machine' // used from the south; states: 0 idle, 1 brewing
  | 'microwave'
  | 'fridge'
  | 'vending_machine'
  | 'cafe_table'
  | 'cafe_chair' // seat; variant = the direction the sitter faces
  // lounge
  | 'sofa' // 3x1 seat; variants: down | up
  | 'armchair' // seat; variant = direction
  | 'coffee_table' // 2x1
  | 'pingpong_table' // 3x2, players at the west and east ends
  | 'beanbag' // seat; variants: red | blue | yellow | green
  | 'arcade'
  // restrooms
  | 'toilet_stall' // 2x2; entered from the south; states: 0 free, 1 taken
  | 'sink'
  // reception
  | 'reception_desk' // 3x1
  | 'bench'; // 2x1 seat facing down

export interface FurnitureDef {
  mount: 'floor' | 'wall';
  /** Floor: tiles taken (w x h). Wall: width in tiles along the wall (h ignored). */
  footprint: { w: number; h: number };
  /** Floor: the tiles block walking. Seats don't (people step onto them). */
  blocks: boolean;
  /** A seat (people can sit on it). */
  seat?: boolean;
  variants?: readonly string[];
  /** Number of visual states (elevator 5, toilet_stall 2…). */
  states?: number;
}

export const FURNITURE: Readonly<Record<FurnitureKind, FurnitureDef>> = {
  desk: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true, variants: ['wood', 'white', 'dark'] },
  desk_back: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true, variants: ['wood', 'white', 'dark'] },
  office_chair_front: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['black', 'blue', 'red', 'green', 'gray'] },
  office_chair: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['black', 'blue', 'red', 'green', 'gray'] },
  bookshelf: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true },
  filing_cabinet: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  printer: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  trash_bin: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  plant_small: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['fern', 'succulent', 'flower'] },
  plant_tall: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['palm', 'ficus', 'monstera', 'bonsai'] },
  glass_partition: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['h', 'v', 'end'] },
  binder_shelf: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  meeting_table: { mount: 'floor', footprint: { w: 3, h: 2 }, blocks: true },
  stool: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true },
  floor_lamp: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  water_cooler: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  whiteboard: { mount: 'wall', footprint: { w: 3, h: 0 }, blocks: false },
  window: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  clock: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false },
  poster: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false, variants: ['code', 'coffee', 'rocket', 'cat', 'bug', 'ship_it'] },
  painting: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  tv: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  light_switch: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false, variants: ['on', 'off'] },
  elevator: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false, states: 5 },
  door_frame: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  sign: { mount: 'wall', footprint: { w: 3, h: 0 }, blocks: false },
  mirror: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false },
  shelf_wall: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  counter: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['plain', 'drawers'] },
  counter_sink: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  coffee_machine: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, states: 2 },
  microwave: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  fridge: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  vending_machine: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  cafe_table: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  cafe_chair: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['up', 'down', 'left', 'right'] },
  sofa: { mount: 'floor', footprint: { w: 3, h: 1 }, blocks: false, seat: true, variants: ['down', 'up'] },
  armchair: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['up', 'down', 'left', 'right'] },
  coffee_table: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true },
  pingpong_table: { mount: 'floor', footprint: { w: 3, h: 2 }, blocks: true },
  beanbag: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['red', 'blue', 'yellow', 'green'] },
  arcade: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  toilet_stall: { mount: 'floor', footprint: { w: 2, h: 2 }, blocks: true, states: 2 },
  sink: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  reception_desk: { mount: 'floor', footprint: { w: 3, h: 1 }, blocks: true },
  bench: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: false, seat: true },
};

export const FURNITURE_KINDS = Object.keys(FURNITURE) as FurnitureKind[];

export type FloorKind = 'carpet' | 'wood' | 'tile_check' | 'tile_white' | 'concrete' | 'marble' | 'grass' | 'sidewalk' | 'street';

export type WallPattern = 'plain' | 'stripes' | 'tiles' | 'wood_panel' | 'brick' | 'glass' | 'marble';

export interface WallStyle {
  base: string;
  /** Trim color (skirting, stripe). */
  trim?: string;
  pattern?: WallPattern;
  /** An outer wall of the building. */
  exterior?: boolean;
}

/** What a monitor or TV shows. */
export type ScreenMode =
  | 'off'
  | 'standby'
  | 'idle'
  | 'code'
  | 'terminal'
  | 'browser'
  | 'search'
  | 'chat'
  | 'docs'
  | 'tasks'
  | 'alert'
  | 'progress'
  | 'show'
  | 'game';

/** A project room's default palette (theme packs may override it in Phase 4). */
export interface RoomTheme {
  carpet: string;
  carpet2: string;
  wall: WallStyle;
  accent: string;
  deskVariant: string;
  chairVariant: string;
}
