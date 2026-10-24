// `npm run theme:new -- <id> [--name "My Theme"] [--from <theme>]` (P4-10): scaffolds themes/<id>/ with a theme.json
// that sets every section, so authors edit values instead of looking up field names. `--from` copies another pack's
// settings (not its files) as the starting point. Then: `npm run dev`, open /preview.html?theme=<id> (or Settings →
// Theme), edit the JSON (it hot-reloads) and run `npm run theme:check`. Step-by-step guide: docs/themes.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateTheme, type ThemePack } from '../../shared/theme';

export const STARTER: Omit<ThemePack, 'id' | 'name'> = {
  schema: 1,
  description: 'Describe the look in one or two sentences (shown as a tooltip in the theme picker).',
  author: 'Your name',
  license: 'CC0-1.0',
  layout: { template: 'corridor', wallHeight: 2.8 },
  palette: { base: '#eef1f4', accent: '#3f7fd8', background: '#dfe3e8' },
  materials: {
    floor: { preset: 'wood', color: '#c79a6b' },
    corridorFloor: { preset: 'concrete', color: '#c4c2bd' },
    coreFloor: { preset: 'tile', color: '#e7e2d8' },
    loungeFloor: { preset: 'carpet', color: '#9fb0c4' },
    restroomFloor: { preset: 'tile', color: '#e9eef0' },
    wall: { preset: 'plaster', color: '#f2efe9' },
    exteriorWall: { preset: 'plaster', color: '#e4e0d8' },
    trim: { color: '#8a8f96' },
    ground: { color: '#cbc6bc' },
  },
  lighting: { ambient: '#ffffff', ground: '#b9b2a6', ambientIntensity: 1.9, sun: { color: '#fff3df', intensity: 1.6 }, practicals: 'warm' },
  kit: { top: '#c79a6b', frame: '#3a3d42', seat: '#3d6fb6' },
  furniture: {
    desk: { procedural: 'default' },
    sofa: { colors: { seat: '#5d7895' } },
  },
  decor: [{ kind: 'plant_wall', on: 'core', density: 0.4 }],
  roomVariants: [{ accent: '#3f7fd8' }, { accent: '#ec8a3c' }, { accent: '#4cae6a' }, { accent: '#8d66cf' }],
};

export function scaffold(root: string, id: string, name: string, from?: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error(`"${id}" isn't a valid id: use lowercase letters, digits and dashes`);
  const dir = join(root, id);
  if (existsSync(dir)) throw new Error(`themes/${id} already exists`);
  let base: Omit<ThemePack, 'id' | 'name'> = STARTER;
  if (from) {
    const file = join(root, from, 'theme.json');
    if (!existsSync(file)) throw new Error(`no theme "${from}" to start from`);
    const src = JSON.parse(readFileSync(file, 'utf8')) as ThemePack;
    // models and the thumbnail are files of the other pack: leave them out
    const furniture = Object.fromEntries(Object.entries(src.furniture ?? {}).map(([k, f]) => [k, { ...f, model: undefined }]).filter(([, f]) => Object.values(f as object).some((v) => v !== undefined)));
    base = { ...src, thumbnail: undefined, furniture } as Omit<ThemePack, 'id' | 'name'>;
  }
  // id and name first in the file; the source pack's own are dropped
  const { id: _id, name: _name, $schema: _schema, ...rest } = base as ThemePack & { $schema?: string };
  const pack = { $schema: '../theme.schema.json', id, name, ...rest };
  const issues = validateTheme(JSON.parse(JSON.stringify(pack)));
  if (issues.length) throw new Error(`the starter isn't valid: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
  mkdirSync(join(dir, 'models'), { recursive: true });
  writeFileSync(join(dir, 'theme.json'), `${JSON.stringify(pack, null, 2)}\n`);
  return dir;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(`--${k}`);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const name = opt('name');
  const from = opt('from');
  const id = args[0];
  if (!id) {
    console.error('usage: npm run theme:new -- <id> [--name "My Theme"] [--from <theme>]');
    process.exit(1);
  }
  try {
    const dir = scaffold(resolve('themes'), id, name ?? id.replace(/(^|-)(\w)/g, (_, s: string, c: string) => `${s ? ' ' : ''}${c.toUpperCase()}`), from);
    console.log(`created ${dir}/theme.json
next:
  1. npm run dev, then open http://127.0.0.1:4848/preview.html?theme=${id}
  2. edit themes/${id}/theme.json (it reloads as you save); put models in themes/${id}/models/
  3. npm run theme:check
guide: docs/themes.md`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
