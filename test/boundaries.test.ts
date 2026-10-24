// Folder rules from CLAUDE.md that a single package can't enforce by itself:
// - the server has zero runtime dependencies (package.json has no "dependencies"; server code imports only node:*,
//   relative paths and dev-only tooling);
// - shared/ and client/src/core/ never import three or node:*;
// - hook shims import only node:*;
// - every package version is pinned exactly.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

function files(dir: string, exts: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, dir));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const rel = join(dir, name);
    if (name === 'node_modules') continue;
    if (statSync(join(root, rel)).isDirectory()) out.push(...files(rel, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(rel);
  }
  return out;
}

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

export function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

function violations(dir: string, exts: string[], allowed: (spec: string, file: string) => boolean): string[] {
  const bad: string[] = [];
  for (const f of files(dir, exts)) {
    for (const spec of importsOf(readFileSync(join(root, f), 'utf8'))) {
      if (!allowed(spec, f)) bad.push(`${relative(root, join(root, f))}: ${spec}`);
    }
  }
  return bad;
}

const isRelative = (s: string) => s.startsWith('./') || s.startsWith('../');
const isTest = (f: string) => /\.test\.ts$/.test(f);

describe('import parser', () => {
  it('finds static, side-effect, re-export and dynamic imports', () => {
    const src = `import a from 'x';\nimport { b } from "./y";\nimport 'z';\nexport * from '../w';\nconst v = await import('vite');\nimport type { T } from 'three';`;
    expect(importsOf(src)).toEqual(['x', './y', 'z', '../w', 'vite', 'three']);
  });
});

describe('folder boundaries', () => {
  it('package.json has no runtime dependencies and pins exact versions', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    expect(pkg.dependencies ?? {}).toEqual({});
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    }
  });

  it('server imports only node:*, relative paths and dev-only tooling', () => {
    const bad = violations('server', ['.ts'], (s, f) =>
      s.startsWith('node:') || isRelative(s) || (isTest(f) && s === 'vitest') || (f.endsWith('index.ts') && s === 'vite'),
    );
    expect(bad).toEqual([]);
  });

  it('shared/ imports nothing but relative paths (tests may also use vitest and node:*)', () => {
    expect(violations('shared', ['.ts'], (s, f) => isRelative(s) || (isTest(f) && (s === 'vitest' || s.startsWith('node:'))))).toEqual([]);
  });

  it('client/src/core/ never imports three, the DOM layers or node:*', () => {
    const bad = violations('client/src/core', ['.ts'], (s, f) => {
      if (isTest(f) && s === 'vitest') return true;
      if (!isRelative(s)) return false;
      return !/(^|\/)(render3d|ui|themes)(\/|$)/.test(s);
    });
    expect(bad).toEqual([]);
  });

  it('hook shims import only node:* (and the shared kit next to them)', () => {
    expect(violations('hooks', ['.mjs', '.js'], (s) => s.startsWith('node:') || /^\.\/[\w-]+\.mjs$/.test(s))).toEqual([]);
  });
});
