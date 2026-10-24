// Reading transcripts for the conversation view (P7-05): only the tail of a file (a transcript can be hundreds of MB),
// the head (to find a session's project), and listing a folder's newest files. Read-only, never throws.
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/** How much of a transcript's end is read. */
export const TAIL_BYTES = 4 * 1024 * 1024;

function readRange(file: string, start: number, length: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The last `maxBytes` of a file as whole lines; `truncated` = the file is longer (its first line read is dropped). */
export function readTail(file: string, maxBytes = TAIL_BYTES): { lines: string[]; truncated: boolean } {
  const size = statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const text = readRange(file, start, size - start);
  const lines = text.split(/\r?\n/);
  if (start > 0) lines.shift();
  return { lines, truncated: start > 0 };
}

/** The first lines of a file (up to `maxBytes`), the last partial one dropped. */
export function readHeadLines(file: string, maxBytes = 64 * 1024): string[] {
  try {
    const lines = readRange(file, 0, maxBytes).split(/\r?\n/);
    if (lines.length > 1) lines.pop();
    return lines;
  } catch {
    return [];
  }
}

/** The `cwd` (or `payload.cwd`) of the first lines that carry one: a session's project. */
export function cwdFromHead(lines: readonly string[]): string | undefined {
  for (const l of lines) {
    const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(l);
    if (m) {
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** The last segment of a path, Windows or POSIX. */
export function folderName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return name || undefined;
}

/** Files in `dir` matching `re`, with their mtimes. Never throws. */
export function filesIn(dir: string, re: RegExp): { file: string; mtime: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { file: string; mtime: number }[] = [];
  for (const n of names) {
    if (!re.test(n)) continue;
    const file = join(dir, n);
    try {
      const st = statSync(file);
      if (st.isFile()) out.push({ file, mtime: st.mtimeMs });
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

/** Sub-folders of `dir` (names). */
export function dirsIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export const stem = (file: string, ext = '.jsonl') => basename(file, ext);
