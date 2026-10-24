// Theme packs (P4-01): every pack under themes/ passes theme:check, and the schema file is current.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REQUIRED_KINDS } from '../shared/theme';
import { FURNITURE_KINDS } from '../client/src/core/vocab';
import { checkPacks, schemaText } from '../scripts/themes/check';

describe('theme packs', () => {
  const reports = checkPacks();

  it('the four built-in themes exist', () => {
    const ids = reports.map((r) => r.id);
    for (const id of ['modern', 'industrial', 'traditional', 'startup']) expect(ids).toContain(id);
  });

  it('every pack is valid and within budget', () => {
    for (const r of reports) expect(r.problems, r.dir).toEqual([]);
  });

  it('themes/theme.schema.json is generated from shared/theme.ts', () => {
    expect(readFileSync('themes/theme.schema.json', 'utf8').replace(/\r\n/g, '\n')).toBe(schemaText());
  });

  it('the required kinds are furniture kinds the sim knows', () => {
    for (const k of REQUIRED_KINDS) expect(FURNITURE_KINDS).toContain(k);
  });
});

describe('theme:new', () => {
  it('scaffolds a valid pack, from the starter or from another theme, and refuses bad ids and existing folders', async () => {
    const { mkdtempSync, rmSync, cpSync, readFileSync: read } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { scaffold } = await import('../scripts/themes/new');
    const { checkPack } = await import('../scripts/themes/check');
    const root = mkdtempSync(join(tmpdir(), 'themes-'));
    try {
      cpSync('themes/cabin', join(root, 'cabin'), { recursive: true });
      const a = scaffold(root, 'my-theme', 'My Theme');
      expect(checkPack(a).problems).toEqual([]);
      const b = scaffold(root, 'my-cabin', 'My Cabin', 'cabin');
      expect(checkPack(b).problems).toEqual([]);
      const pack = JSON.parse(read(join(b, 'theme.json'), 'utf8'));
      expect(pack.id).toBe('my-cabin');
      expect(JSON.stringify(pack)).not.toContain('.glb');
      expect(() => scaffold(root, 'my-theme', 'Again')).toThrow(/exists/);
      expect(() => scaffold(root, '../evil', 'Evil')).toThrow(/valid id/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
