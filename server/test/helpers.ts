// Ported from habblaud server/test/fixtures.ts (MIT, © 2026 Márcio Junior)
// Small helpers shared by server tests.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A temporary folder for one test (removed with `cleanup`). */
export function tempDir(prefix = 'agent-office-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
