// Ported from habblaud server/model/model.test.ts and room-aliases.test.ts (MIT, © 2026 Márcio Junior)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAME_POOL, nameKey, pickName } from '../../shared/names';
import { setQuiet } from '../log';
import { tempDir } from '../test/helpers';
import { NameStore } from './names';
import { RoomAliases } from './room-aliases';
import { SlotAllocator, normalizeCwd, roomDisplayNames } from './rooms';

setQuiet(true);

describe('SlotAllocator', () => {
  it('lowest free slot, stable while the room exists', () => {
    const s = new SlotAllocator(30_000);
    s.sync(['a', 'b', 'c'], 0);
    expect(['a', 'b', 'c'].map((id) => s.slotOf(id))).toEqual([0, 1, 2]);
    s.sync(['c', 'a', 'b'], 1);
    expect(s.slotOf('c')).toBe(2);
  });

  it('a freed slot is reused only after the cooldown', () => {
    const s = new SlotAllocator(30_000);
    s.sync(['a', 'b'], 0);
    s.sync(['b'], 1_000);
    s.sync(['b', 'c'], 2_000);
    expect(s.slotOf('c')).toBe(2);
    s.sync(['b', 'c', 'd'], 31_000);
    expect(s.slotOf('d')).toBe(0);
  });
});

describe('rooms', () => {
  it('normalizes POSIX paths', () => {
    expect(normalizeCwd('/a//b/')).toBe('/a/b');
    expect(normalizeCwd('/')).toBe('/');
  });

  it('normalizes Windows paths case-insensitively (VS Code writes c:\\, the desktop app C:\\)', () => {
    expect(normalizeCwd('c:\\Users\\dev\\code\\Project')).toBe('c:/users/dev/code/project');
    expect(normalizeCwd('C:\\Users\\dev\\code\\Project\\')).toBe('c:/users/dev/code/project');
    expect(normalizeCwd('C:/Users/dev//code/project')).toBe('c:/users/dev/code/project');
    expect(normalizeCwd('C:\\')).toBe('c:/');
    expect(normalizeCwd('\\\\server\\share\\repo')).toBe('//server/share/repo');
  });

  it('disambiguates repeated folder names with the parent folder', () => {
    const names = roomDisplayNames(
      new Map([
        ['1', '/p/company/applications/app'],
        ['2', '/p/other/app'],
        ['3', '/p/agent-office'],
      ]),
    );
    expect([...names.values()]).toEqual(['applications/app', 'other/app', 'agent-office']);
  });

  it('display names use the original path (not the lower-cased key)', () => {
    const names = roomDisplayNames(new Map([['c:/users/dev/code/myapp', 'C:\\Users\\dev\\code\\MyApp']]));
    expect(names.get('c:/users/dev/code/myapp')).toBe('MyApp');
  });
});

describe('RoomAliases', () => {
  it('default, alias per folder (slashes and case do not matter), empty goes back to the default, persists', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'rooms.json');
      const assets = String.raw`C:\Users\x\.agent-office\assets`;
      const dash = String.raw`C:\repos\dash`;
      const a = new RoomAliases(file);
      a.setDefault(assets, 'Workshop');
      expect(a.get('c:/users/x/.agent-office/assets/')).toBe('Workshop');
      expect(a.set(dash, '  Dash   board  ')).toBe('Dash board');
      expect(a.set(assets, 'Studio')).toBe('Studio');
      const b = new RoomAliases(file);
      b.load();
      expect(b.get('c:/repos/dash')).toBe('Dash board');
      b.setDefault(assets, 'Workshop');
      expect(b.set(assets, '')).toBe('Workshop');
      expect(b.get('/other')).toBeUndefined();
    } finally {
      tmp.cleanup();
    }
  });
});

describe('names', () => {
  it('the pool has no duplicates (ignoring case and Unicode form)', () => {
    const keys = NAME_POOL.map((p) => nameKey(p.name));
    expect(new Set(keys).size).toBe(keys.length);
    expect(NAME_POOL.length).toBe(120);
  });

  it('pickName is deterministic, avoids used names and adds a number when the pool runs out', () => {
    expect(pickName('session-1', new Set())).toEqual(pickName('session-1', new Set()));
    const first = pickName('session-1', new Set());
    expect(pickName('session-1', new Set([first.name])).name).not.toBe(first.name);
    const all = new Set(NAME_POOL.map((p) => p.name));
    expect(pickName('session-1', all).name).toMatch(/ 2$/);
  });

  it('NameStore: unique among the present and persisted across restarts', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'data', 'names.json');
      const a = new NameStore(file);
      const used = new Set<string>();
      const first = a.assign('sess-1', used);
      used.add(first.name);
      const second = a.assign('sess-2', used);
      expect(second.name).not.toBe(first.name);
      expect(NAME_POOL.some((p) => p.name === first.name && p.look === first.look)).toBe(true);
      a.flush();
      expect((JSON.parse(readFileSync(file, 'utf8')) as { names: Record<string, { name: string }> }).names['sess-1']!.name).toBe(first.name);

      const b = new NameStore(file);
      b.load();
      expect(b.assign('sess-1', new Set()).name).toBe(first.name);
      // A stored name that collides with someone present gets replaced.
      expect(b.assign('sess-1', new Set([first.name])).name).not.toBe(first.name);
    } finally {
      tmp.cleanup();
    }
  });

  it('NameStore: entries unused for 60 days are dropped on flush', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'names.json');
      let clock = 1_700_000_000_000;
      const s = new NameStore(file, { now: () => clock });
      s.remember('old', { name: 'Otto', look: 'm' });
      clock += 59 * 86_400_000;
      s.remember('used', { name: 'Nina', look: 'f' });
      clock += 2 * 86_400_000;
      s.flush();
      expect(s.get('old')).toBeUndefined();
      expect(s.get('used')?.name).toBe('Nina');
    } finally {
      tmp.cleanup();
    }
  });
});
