// `npm run theme:check` (P4-01): validates every pack in themes/ — theme.json against the schema, the id against the
// folder, referenced files exist inside the pack, the pack's size budget (15 MB), and the schema file is current.
// `--write-schema` rewrites themes/theme.schema.json from shared/theme.ts. test/themes.test.ts runs the same checks.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { themeJsonSchema, validateTheme, type ThemePack } from '../../shared/theme';
import { FURNITURE_KINDS } from '../../client/src/core/vocab';

export const PACK_BUDGET_BYTES = 15 * 1024 * 1024;

export interface PackReport {
  dir: string;
  id?: string;
  bytes: number;
  problems: string[];
}

function sizeOf(dir: string): number {
  let total = 0;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    total += st.isDirectory() ? sizeOf(p) : st.size;
  }
  return total;
}

export function schemaText(): string {
  return `${JSON.stringify(themeJsonSchema(), null, 2)}\n`;
}

/** Checks one pack folder. */
export function checkPack(dir: string): PackReport {
  const folder = dir.split(/[\\/]/).pop()!;
  const report: PackReport = { dir: folder, bytes: sizeOf(dir), problems: [] };
  const file = join(dir, 'theme.json');
  if (!existsSync(file)) {
    report.problems.push('theme.json is missing');
    return report;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    report.problems.push(`theme.json is not valid JSON: ${(e as Error).message}`);
    return report;
  }
  for (const i of validateTheme(raw, new Set(FURNITURE_KINDS))) report.problems.push(`${i.path || '(root)'}: ${i.message}`);
  if (report.problems.length) return report;
  const pack = raw as ThemePack;
  report.id = pack.id;
  if (pack.id !== folder) report.problems.push(`id "${pack.id}" must match the folder name "${folder}"`);
  const files = [...Object.values(pack.furniture ?? {}).map((f) => f?.model), pack.thumbnail].filter((f): f is string => !!f);
  for (const f of files) if (!existsSync(join(dir, f))) report.problems.push(`${f}: file not found in the pack`);
  if (report.bytes > PACK_BUDGET_BYTES) report.problems.push(`the pack is ${(report.bytes / 1048576).toFixed(1)} MB (budget 15 MB)`);
  return report;
}

/** Checks every pack under `root` (default: themes/). */
export function checkPacks(root = resolve('themes')): PackReport[] {
  return readdirSync(root)
    .filter((n) => statSync(join(root, n)).isDirectory())
    .sort()
    .map((n) => checkPack(join(root, n)));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve('themes');
  const schemaFile = join(root, 'theme.schema.json');
  let failed = false;
  if (process.argv.includes('--write-schema')) {
    writeFileSync(schemaFile, schemaText());
    console.log('wrote themes/theme.schema.json');
  } else if (!existsSync(schemaFile) || readFileSync(schemaFile, 'utf8').replace(/\r\n/g, '\n') !== schemaText()) {
    console.error('themes/theme.schema.json is out of date: run npm run theme:check -- --write-schema');
    failed = true;
  }
  for (const r of checkPacks(root)) {
    const size = `${(r.bytes / 1024).toFixed(0)} KB`;
    if (r.problems.length) {
      failed = true;
      console.error(`✗ ${r.dir} (${size})`);
      for (const p of r.problems) console.error(`    ${p}`);
    } else console.log(`✓ ${r.dir} (${size})`);
  }
  process.exit(failed ? 1 : 0);
}
