// npm run assets:fetch [-- <source id>…]
// Downloads the third-party sources into assets-src/<id>/ (git-ignored) and checks each against its pinned SHA-256.
// Downloads are untrusted data: nothing here runs them; build.ts only parses them as glTF.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { SOURCES } from './sources';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SRC_DIR = join(root, 'assets-src');

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The local path of a source's file once fetched. */
export function sourcePath(id: string): string {
  const s = SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown source ${id}`);
  return join(SRC_DIR, id, basename(s.entry ?? new URL(s.url).pathname));
}

async function fetchOne(id: string): Promise<void> {
  const s = SOURCES.find((x) => x.id === id)!;
  process.stdout.write(`${id}: ${s.url}\n`);
  const res = await fetch(s.url);
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const hash = sha256(data);
  if (s.sha256 && hash !== s.sha256) throw new Error(`${id}: SHA-256 ${hash} doesn't match the pinned ${s.sha256}; not using it`);
  if (!s.sha256) process.stdout.write(`  not pinned yet: sha256 ${hash} (pin it in scripts/assets/sources.ts)\n`);
  let file = data;
  if (s.entry) {
    const entries = unzipSync(data, { filter: (f) => f.name === s.entry });
    const got = entries[s.entry];
    if (!got) throw new Error(`${id}: ${s.entry} not found in the zip`);
    file = got;
  }
  const out = sourcePath(id);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, file);
  process.stdout.write(`  → ${out} (${(file.length / 1024).toFixed(0)} KB)\n`);
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const list = ids.length ? ids : SOURCES.map((s) => s.id);
  let failed = 0;
  for (const id of list) {
    try {
      await fetchOne(id);
    } catch (err) {
      failed++;
      process.stderr.write(`  ${(err as Error).message}\n`);
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
