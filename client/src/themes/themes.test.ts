// The theme runtime's pure parts (P4-02, P4-08): resolving packs, kit styles, decor, model fitting, and a live
// restyle that keeps the simulation's state.
import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot, RoomInfo } from '../../../shared/protocol';
import { validateTheme, type ThemePack } from '../../../shared/theme';
import industrialJson from '../../../themes/industrial/theme.json';
import modernJson from '../../../themes/modern/theme.json';
import startupJson from '../../../themes/startup/theme.json';
import traditionalJson from '../../../themes/traditional/theme.json';
import { assembleBuilding } from '../core/layout/building';
import { columnsFor } from '../core/layout/geometry';
import { layoutProjectRoom } from '../core/layout/room';
import { roomTheme as defaultRoomTheme } from '../core/room-theme';
import { DEFAULT_WORLD_OPTIONS } from '../core/options';
import { Sim } from '../core/sim/sim';
import { FURNITURE, FURNITURE_KINDS } from '../core/vocab';
import { decorFor, type FullWall } from '../render3d/decor';
import { furnitureParts } from '../render3d/kit';
import { fitModel, modelYaw } from '../render3d/models-fit';
import { TILE_M } from '../render3d/units';
import { floorSurface, mix, resolveLook, shade } from './look';

const packs = [modernJson, industrialJson, traditionalJson, startupJson] as unknown as ThemePack[];
const looks = packs.map(resolveLook);
const byId = (id: string) => looks.find((l) => l.id === id)!;

describe('resolveLook', () => {
  it('the bundled packs are valid', () => {
    for (const p of packs) expect(validateTheme(p, new Set(FURNITURE_KINDS)), p.id).toEqual([]);
  });

  it('a minimal pack falls back to the built-in look everywhere', () => {
    const look = resolveLook({ id: 'x', name: 'X', schema: 1, layout: { template: 'corridor' }, palette: { base: '#ffffff', accent: '#000000' } });
    expect(look.wallHeight).toBe(2.8);
    expect(look.roomTheme(3)).toEqual(defaultRoomTheme(3));
    expect(look.floor('room', 'marble')).toEqual({ color: '#e8e4dc', pattern: 'marble' });
    expect(look.floor('lounge', 'carpet', '#123456').color).toBe('#123456');
    expect(look.kit.color('desk', 'top')).toBeUndefined();
    expect(look.kit.procedural('desk')).toBeUndefined();
  });

  it('modern keeps the default room palettes (the look closest to the original)', () => {
    for (let s = 0; s < 12; s++) expect(byId('modern').roomTheme(s)).toEqual(defaultRoomTheme(s));
  });

  it('surfaces map from the area kind and take the preset pattern', () => {
    expect(floorSurface('room')).toBe('floor');
    expect(floorSurface('corridor')).toBe('corridorFloor');
    expect(floorSurface('reception')).toBe('coreFloor');
    const ind = byId('industrial');
    expect(ind.floor('room', 'marble')).toEqual({ color: '#9a9993', pattern: 'concrete' });
    expect(ind.floor('lounge', 'carpet').pattern).toBe('wood');
    // the street and the grass outside aren't themed
    expect(ind.floor('corridor', 'grass').color).toBe('#8fbf6a');
    expect(ind.wall('reception', { base: '#ffffff' }).pattern).toBe('brick');
    expect(ind.wall('room', { base: '#ffffff', exterior: true }).color).toBe('#9a5a44');
    expect(ind.roomTheme(0).wall.pattern).toBe('brick');
  });

  it('per-room variation (P4-08): neighbouring seeds differ, and the same seed always looks the same', () => {
    for (const look of looks) {
      for (let s = 0; s < 30; s++) {
        expect(look.roomTheme(s), look.id).toEqual(look.roomTheme(s));
        expect(look.roomTheme(s).accent === look.roomTheme(s + 1).accent && look.roomTheme(s).carpet === look.roomTheme(s + 1).carpet, `${look.id} ${s}`).toBe(false);
      }
    }
    const st = byId('startup').roomTheme(0);
    expect(st.chairVariant).toBe('#ff4f8b');
  });

  it('lighting and practicals', () => {
    expect(byId('industrial').lighting.practical).toBe('#ffb45e');
    expect(byId('startup').lighting.practical).toBe('#ff4f8b');
    expect(byId('modern').lighting.intensity).toBe(1.9);
  });

  it('color helpers', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(shade('#808080', -1)).toBe('#000000');
    expect(shade('#808080', 1)).toBe('#ffffff');
  });
});

describe('kit styles', () => {
  it('every kind has a procedural default inside its footprint, with roles on every part', () => {
    for (const kind of FURNITURE_KINDS) {
      if (FURNITURE[kind].mount !== 'floor') continue;
      for (const look of looks) {
        const parts = furnitureParts(kind, FURNITURE[kind].variants?.[0], look.kit);
        const fp = FURNITURE[kind].footprint;
        expect(parts.length, kind).toBeGreaterThan(0);
        for (const p of parts) {
          expect(p.role, `${look.id} ${kind}`).toBeDefined();
          expect(p.x0, kind).toBeGreaterThanOrEqual(-0.001);
          expect(p.x1, kind).toBeLessThanOrEqual(fp.w * TILE_M + 0.001);
          expect(p.z1, kind).toBeLessThanOrEqual(Math.max(1, fp.h) * TILE_M + 0.001);
          expect(p.color, kind).toMatch(/^#[0-9a-f]{6}$/i);
        }
      }
    }
  });

  it('themes recolor by role; a room\'s hex variant wins over the theme', () => {
    const ind = byId('industrial');
    expect(furnitureParts('desk', 'wood', ind.kit).find((p) => p.role === 'top')!.color).toBe('#a77b4f');
    expect(furnitureParts('desk', '#123456', ind.kit).find((p) => p.role === 'top')!.color).toBe('#123456');
    expect(furnitureParts('office_chair', '#abcdef', ind.kit).filter((p) => p.role === 'seat').every((p) => p.color === '#abcdef')).toBe(true);
    expect(furnitureParts('office_chair', 'blue', ind.kit).find((p) => p.role === 'seat')!.color).toBe('#5a3e2b');
  });

  it('procedural alternatives apply only to kinds they fit, and desks keep their monitor', () => {
    const style = (look: string) => ({ color: () => undefined, procedural: () => look as never });
    for (const look of ['trestle', 'cubicle', 'pallet']) {
      const desk = furnitureParts('desk', undefined, style(look));
      expect(desk.some((p) => p.role === 'screen' && p.y1 > 1.1), look).toBe(true);
    }
    // not applicable → the default look
    expect(furnitureParts('fridge', undefined, style('cubicle'))).toEqual(furnitureParts('fridge'));
    expect(furnitureParts('bookshelf', undefined, style('pipe-shelf')).some((p) => p.color === '#2b2d30')).toBe(true);
    expect(furnitureParts('sofa', 'down', style('tufted')).length).toBeGreaterThan(furnitureParts('sofa', 'down').length - 1);
  });
});

describe('decor', () => {
  const rooms = [0, 1, 2].map((slot) => layoutProjectRoom({ id: `/p/${slot}`, slot, seed: slot }, defaultRoomTheme(slot)));
  const b = assembleBuilding(columnsFor([0, 1, 2]), rooms);
  const wall: FullWall = { axis: 'x', a0: 16, a1: 24, plane: 1, normal: 1, busy: [[18, 19.5]] };

  it('never reaches a walkable floor: wall decor hugs the wall, the rest hangs above head height', () => {
    for (const look of looks) {
      for (const area of [...b.core, b.corridor, ...rooms]) {
        for (const d of decorFor(area, [wall], look.decor, { wallHeight: look.wallHeight, accent: '#ff0000', practical: '#ffffff' })) {
          const hugsWall = d.z0 >= wall.plane - 0.001 && d.z1 <= wall.plane + 0.3 && d.x0 >= wall.a0 && d.x1 <= wall.a1;
          expect(hugsWall || d.y0 >= 2.0, `${look.id} ${area.id}`).toBe(true);
          expect(d.y1).toBeLessThanOrEqual(look.wallHeight + 0.001);
        }
      }
    }
  });

  it('wall decor in the 1–2.2 m band leaves wall items free', () => {
    const boxes = decorFor(rooms[0]!, [wall], [{ kind: 'certificates', on: 'everywhere', density: 1 }, { kind: 'neon', on: 'everywhere', density: 1 }], { wallHeight: 3, accent: '#ff0000', practical: '#ffffff' });
    expect(boxes.length).toBeGreaterThan(0);
    for (const d of boxes) expect(d.x1 <= 18 - 0.1 + 1e-6 || d.x0 >= 19.5 + 0.1 - 1e-6).toBe(true);
  });

  it('"on" picks the areas', () => {
    const spec = [{ kind: 'pendant_bulbs', on: 'rooms', density: 1 }] as const;
    expect(decorFor(rooms[0]!, [], spec, { wallHeight: 3, accent: '#f00000', practical: '#ffffff' }).length).toBe(6); // 3 desks × (cord + bulb)
    expect(decorFor(b.corridor, [], spec, { wallHeight: 3, accent: '#f00000', practical: '#ffffff' })).toEqual([]);
  });
});

describe('model fitting', () => {
  const unit = { min: { x: -0.5, y: 0, z: -0.25 }, max: { x: 0.5, y: 0.8, z: 0.25 } };

  it('fills the footprint, centred and standing on the floor', () => {
    const f = fitModel(unit, 'desk', 0);
    expect(f.scale).toBeCloseTo(1); // 1 m × 0.5 m desk footprint
    expect(f.x).toBeCloseTo(0.5);
    expect(f.z).toBeCloseTo(0.25);
    expect(f.y).toBeCloseTo(0);
    const lifted = fitModel({ min: { x: 0, y: -1, z: 0 }, max: { x: 2, y: 1, z: 1 } }, 'desk', 0, 0.5);
    expect(lifted.scale).toBeCloseTo(0.25);
    expect(lifted.y).toBeCloseTo(0.25);
  });

  it('turns models to face the way the placement does', () => {
    expect(modelYaw('desk', undefined)).toBe(0);
    expect(modelYaw('desk_back', undefined)).toBe(180);
    expect(modelYaw('office_chair', 'blue')).toBe(180);
    expect(modelYaw('armchair', 'right')).toBe(90);
    expect(modelYaw('sofa', 'up', 15)).toBe(195);
    // a quarter turn swaps the extents: a 1 × 0.5 model in a 0.5 × 0.5 footprint
    expect(fitModel(unit, 'armchair', 90).scale).toBeCloseTo(0.5);
  });
});

describe('live restyle (P4-02)', () => {
  const T0 = 1_700_000_000_000;
  const room = (id: string, slot: number): RoomInfo => ({ id, name: id, path: id, slot, seed: slot * 99 + 7, createdAt: T0 });
  const agent = (id: string, roomId: string): AgentInfo => ({
    id,
    kind: 'main',
    provider: 'claude-code',
    roomId,
    name: id,
    look: 'f',
    role: 'Main agent',
    sessionId: `s-${id}`,
    account: 'default',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: T0,
    lastEventAt: T0,
    statusSince: T0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: id.length * 1234567,
  });
  const snap: OfficeSnapshot = {
    rev: 1,
    serverTime: T0,
    rooms: [room('/a', 0), room('/b', 1), room('/c', 2)],
    agents: [agent('ana', '/a'), agent('bob', '/b'), agent('cy', '/c'), agent('dee', '/a')],
    accounts: [],
    meta: { demo: true, sources: [], providers: [], startedAt: T0, version: 't' },
  };

  it('switching themes keeps everyone at their desk and re-lays the rooms with the new walls and palettes', () => {
    let look = byId('modern');
    const sim = new Sim({ options: () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }), roomTheme: (s) => look.roomTheme(s), template: look.template });
    let now = T0;
    sim.applySnapshot(snap, now);
    for (let i = 0; i < 30; i++) sim.update(1 / 30, (now += 33));
    const before = new Map([...sim.chars.values()].map((c) => [c.id, { spot: c.atSpot, home: c.homeSpot, x: c.x, y: c.y, pose: c.pose }]));
    for (const id of ['startup', 'industrial', 'traditional', 'modern']) {
      look = byId(id);
      const version = sim.layoutVersion;
      sim.restyle(look.template);
      expect(sim.layoutVersion).toBeGreaterThan(version);
      expect(sim.building.template).toBe(look.template);
      for (const r of sim.rooms.values()) expect(r.theme).toEqual(look.roomTheme(r.seed));
      for (let i = 0; i < 3; i++) sim.update(1 / 30, (now += 33));
      for (const c of sim.chars.values()) {
        const b = before.get(c.id)!;
        expect({ spot: c.atSpot, home: c.homeSpot, pose: c.pose }, `${id} ${c.id}`).toEqual({ spot: b.spot, home: b.home, pose: b.pose });
        expect(Math.hypot(c.x - b.x, c.y - b.y), `${id} ${c.id}`).toBeLessThan(1);
      }
    }
  });
});
