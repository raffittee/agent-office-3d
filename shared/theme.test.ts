import { describe, expect, it } from 'vitest';
import { REQUIRED_KINDS, themeJsonSchema, validateTheme } from './theme';

const minimal = { id: 'mini', name: 'Mini', schema: 1, layout: { template: 'corridor' }, palette: { base: '#ffffff', accent: '#ff0000' } };

describe('validateTheme', () => {
  it('accepts a minimal pack and a full one', () => {
    expect(validateTheme(minimal)).toEqual([]);
    const full = {
      ...minimal,
      description: 'x',
      thumbnail: 'thumb.png',
      layout: { template: 'loft', wallHeight: 3.6, roomSize: [16, 12] },
      materials: { floor: { preset: 'concrete', color: '#8a8a85', roughness: 0.9 }, wall: { preset: 'brick' } },
      lighting: { ambient: '#3a3530', sun: { color: '#ffe2b8', intensity: 1.2 }, practicals: 'edison-bulbs' },
      kit: { frame: '#222222' },
      furniture: { desk: { model: 'models/desk.glb', variants: ['a'] }, office_chair: { procedural: 'stool', params: { metal: true } } },
      decor: [{ kind: 'pipes', on: 'everywhere', density: 0.4 }],
      roomVariants: [{ accent: '#c0392b' }],
      postfx: { bloom: 0.25, ao: true },
    };
    expect(validateTheme(full)).toEqual([]);
  });

  it('reports each problem with its path', () => {
    const bad = {
      id: 'Bad Id',
      name: '',
      schema: 2,
      extra: 1,
      layout: { template: 'maze', wallHeight: 99 },
      palette: { base: 'red' },
      materials: { ceiling: {}, floor: { preset: 'lava', roughness: 2 } },
      furniture: { spaceship: {}, desk: { model: '../../etc/passwd.glb', procedural: 'blob', colors: { glitter: '#ffffff', top: 'brown' } } },
      decor: [{ kind: 'fog', on: 'moon' }],
      roomVariants: [{}],
      postfx: { ao: 'yes' },
    };
    const paths = validateTheme(bad).map((i) => i.path);
    for (const p of [
      'id',
      'name',
      'schema',
      '.extra',
      'layout.template',
      'layout.wallHeight',
      'palette.accent',
      'palette.base',
      'materials.ceiling',
      'materials.floor.preset',
      'materials.floor.roughness',
      'furniture.spaceship',
      'furniture.desk.model',
      'furniture.desk.procedural',
      'furniture.desk.colors.glitter',
      'furniture.desk.colors.top',
      'decor[0].kind',
      'decor[0].on',
      'roomVariants[0].accent',
      'postfx.ao',
    ])
      expect(paths, p).toContain(p);
  });

  it('rejects non-objects and paths that leave the pack', () => {
    expect(validateTheme(null)).toHaveLength(1);
    expect(validateTheme([])).toHaveLength(1);
    for (const model of ['/abs.glb', 'a/../b.glb', 'a\\b.glb', 'model.gltf', 'model.glb.exe']) expect(validateTheme({ ...minimal, furniture: { desk: { model } } }).length, model).toBeGreaterThan(0);
  });

  it('checks furniture kinds against the given vocabulary', () => {
    const pack = { ...minimal, furniture: { pingpong_table: { colors: { body: '#00ff00' } } } };
    expect(validateTheme(pack).map((i) => i.path)).toEqual(['furniture.pingpong_table']);
    expect(validateTheme(pack, new Set([...REQUIRED_KINDS, 'pingpong_table']))).toEqual([]);
  });

  it('the JSON Schema lists the same top-level fields as the validator', () => {
    const schema = themeJsonSchema() as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required).toEqual(['id', 'name', 'schema', 'layout', 'palette']);
    for (const k of Object.keys(schema.properties)) {
      if (k === '$schema' || k === 'id' || k === 'name' || k === 'schema' || k === 'layout' || k === 'palette') continue;
      // every optional field the schema allows is accepted by the validator (not reported as unknown)
      expect(validateTheme({ ...minimal, [k]: undefined }).map((i) => i.path), k).not.toContain(`.${k}`);
    }
    expect(validateTheme({ ...minimal, nope: 1 }).map((i) => i.path)).toContain('.nope');
  });
});
