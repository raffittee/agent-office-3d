// Ported from habblaud server/sources/tail.ts (MIT, © 2026 Márcio Junior)
// Incremental reading of append-only files (JSONL): returns only the new complete lines, keeps the partial line for
// the next round (up to MAX_LINE_BYTES) and detects truncation/rotation. Shared by every adapter that tails files.
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { log } from '../log';

export interface TailRead {
  lines: string[];
  /** The file was truncated or replaced: reading started over. */
  reset: boolean;
  /** The file doesn't exist (yet, or anymore). */
  missing: boolean;
  /** There are unread bytes left (the per-read limit was hit). */
  more: boolean;
}

const NL = 0x0a;
/** How much of the file's start to keep, to confirm a replacement only the birthtime points at (see `replaced`). */
const HEAD_BYTES = 256;
/**
 * Ceiling for one JSONL line. In real Claude Code and Codex conversations the largest line was 5.8 MiB (a large
 * tool_result, which must be read whole to become an activity). 8 MiB covers it; above that, the line is discarded up
 * to the `\n`.
 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Warns once per file that a line went over the ceiling and was skipped. Never logs the line. */
export function warnOversizedLine(path: string): void {
  const mb = MAX_LINE_BYTES / (1024 * 1024);
  log.warnOnce(`oversize-line:${path}`, `A line over ${mb} MiB in ${path} was skipped up to the next line break.`);
}

/**
 * An incomplete line in pieces: joined only when a `\n` shows up. Each read copies only the new piece; above `max`,
 * drops what it has and discards up to the next line break.
 */
export class LineBuffer {
  private pieces: Buffer[] = [];
  private bytes = 0;
  private skipping = false;

  constructor(private readonly max = MAX_LINE_BYTES) {}

  reset(): void {
    this.pieces = [];
    this.bytes = 0;
    this.skipping = false;
  }

  /** Consumes `chunk` and returns the closed lines, without the `\n`. */
  push(chunk: Buffer): { lines: Buffer[]; discarded: number } {
    const lines: Buffer[] = [];
    let discarded = 0;
    let i = 0;
    while (i < chunk.length) {
      if (this.skipping) {
        const nl = chunk.indexOf(NL, i);
        if (nl === -1) return { lines, discarded };
        this.skipping = false;
        i = nl + 1;
        continue;
      }
      const nl = chunk.indexOf(NL, i);
      if (nl === -1) {
        const rest = chunk.length - i;
        if (rest > 0 && this.bytes + rest > this.max) {
          this.pieces = [];
          this.bytes = 0;
          this.skipping = true;
          discarded++;
        } else if (rest > 0) {
          this.pieces.push(Buffer.from(chunk.subarray(i)));
          this.bytes += rest;
        }
        return { lines, discarded };
      }
      const total = this.bytes + (nl - i);
      if (total > this.max) discarded++;
      else if (total > 0) lines.push(this.take(chunk.subarray(i, nl)));
      this.pieces = [];
      this.bytes = 0;
      i = nl + 1;
    }
    return { lines, discarded };
  }

  /** What's left without a `\n` at the end of the file; null when empty or when the line went over the ceiling. */
  flush(): Buffer | null {
    if (this.skipping || this.bytes === 0) return null;
    const out = this.pieces.length === 1 ? this.pieces[0]! : Buffer.concat(this.pieces);
    this.pieces = [];
    this.bytes = 0;
    return out;
  }

  private take(tail: Buffer): Buffer {
    if (this.pieces.length === 0) return tail;
    if (tail.length === 0) return this.pieces.length === 1 ? this.pieces[0]! : Buffer.concat(this.pieces);
    return Buffer.concat([...this.pieces, tail]);
  }
}

/** The first `max` bytes of the file, in a positional read (doesn't move the incremental offset). */
function readHead(fd: number, max: number): Buffer {
  const buf = Buffer.alloc(max);
  return max > 0 ? buf.subarray(0, readSync(fd, buf, 0, max, 0)) : buf;
}

export class FileTail {
  /** Next byte to read. */
  offset = 0;
  size = 0;
  mtimeMs = 0;
  /** A line without `\n` yet. Above MAX_LINE_BYTES the rest is discarded up to the line break. */
  private pending = new LineBuffer();
  private ino: number | undefined;
  /** When the file was created (0 when the file system doesn't say). */
  private birthtimeMs = 0;
  /** The start of the file (up to HEAD_BYTES); null = not read yet. */
  private head: Buffer | null = null;
  private readonly maxChunk: number;

  constructor(
    readonly path: string,
    opts: { maxChunk?: number } = {},
  ) {
    this.maxChunk = opts.maxChunk ?? 8 * 1024 * 1024;
  }

  /**
   * Positions the read at the last `maxBytes` of the file, aligned at the start of the following line (the cut line
   * is discarded). Returns the chosen offset (0 = the whole file).
   */
  seekTail(maxBytes: number): number {
    this.pending.reset();
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      this.offset = 0;
      return 0;
    }
    try {
      const st = fstatSync(fd);
      this.ino = st.ino;
      this.birthtimeMs = st.birthtimeMs;
      this.size = st.size;
      this.mtimeMs = st.mtimeMs;
      this.head = readHead(fd, Math.min(st.size, HEAD_BYTES));
      if (st.size <= maxBytes) {
        this.offset = 0;
        return 0;
      }
      // Look for the first line break from (window start - 1).
      let pos = st.size - maxBytes - 1;
      const buf = Buffer.allocUnsafe(64 * 1024);
      while (pos < st.size) {
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        const i = buf.subarray(0, n).indexOf(NL);
        if (i !== -1) {
          this.offset = pos + i + 1;
          return this.offset;
        }
        pos += n;
      }
      this.offset = st.size;
      return this.offset;
    } finally {
      closeSync(fd);
    }
  }

  /** Positions at the end of the file (only what is written from now on is read). */
  seekEnd(): void {
    this.pending.reset();
    this.head = null;
    try {
      const st = statSync(this.path);
      this.ino = st.ino;
      this.birthtimeMs = st.birthtimeMs;
      this.size = st.size;
      this.mtimeMs = st.mtimeMs;
      this.offset = st.size;
    } catch {
      this.offset = 0;
    }
  }

  /**
   * Was the file replaced by another? A different inode is enough, but the file system may reuse a deleted file's
   * number (ext4): so when both sides report a creation time, it counts too. On Linux without statx (WSL1, old
   * seccomp) Node reports the ctime instead, which changes on every write: a birthtime change only counts when the
   * start of the file changed too. The same goes for the mtime: rewriting the file in the same inode doesn't change
   * the inode or the birthtime, and with the same size (or larger) `size < offset` doesn't catch it either. Appending
   * lines changes the mtime without touching the start, so only a change at the start counts as a replacement.
   */
  private replaced(fd: number, st: { ino: number; birthtimeMs: number; mtimeMs: number }): boolean {
    if (this.ino === undefined) return false;
    if (st.ino !== this.ino) return true;
    const born = this.birthtimeMs > 0 && st.birthtimeMs > 0 && st.birthtimeMs !== this.birthtimeMs;
    const written = st.mtimeMs !== this.mtimeMs;
    if (!born && !written) return false;
    return !!this.head && !readHead(fd, this.head.length).equals(this.head);
  }

  read(): TailRead {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], reset: false, missing: true, more: false };
      throw err;
    }
    try {
      const st = fstatSync(fd);
      let reset = false;
      if (this.replaced(fd, st) || st.size < this.offset) {
        this.offset = 0;
        this.pending.reset();
        this.head = null;
        reset = true;
      }
      this.ino = st.ino;
      this.birthtimeMs = st.birthtimeMs;
      this.size = st.size;
      this.mtimeMs = st.mtimeMs;
      // The start is re-read only while the file is shorter than HEAD_BYTES.
      const headLen = Math.min(st.size, HEAD_BYTES);
      if (!this.head || this.head.length < headLen) this.head = readHead(fd, headLen);
      const avail = st.size - this.offset;
      if (avail <= 0) return { lines: [], reset, missing: false, more: false };
      const len = Math.min(avail, this.maxChunk);
      const chunk = Buffer.allocUnsafe(len);
      const n = readSync(fd, chunk, 0, len, this.offset);
      this.offset += n;
      const fed = this.pending.push(chunk.subarray(0, n));
      if (fed.discarded) warnOversizedLine(this.path);
      const lines: string[] = [];
      for (const buf of fed.lines) {
        const line = buf.toString('utf8').replace(/\r$/, '');
        if (line.trim()) lines.push(line);
      }
      return { lines, reset, missing: false, more: avail > len };
    } finally {
      closeSync(fd);
    }
  }
}
