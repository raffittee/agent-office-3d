// Ported from habblaud server/sources/registry.test.ts (MIT, © 2026 Márcio Junior)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/helpers';
import { compareVersions, filetimeToMs, parseRegistryEntry, ProcStartChecker, registryStatus, RegistryReader } from './registry';

const FIXTURES = resolve(__dirname, '../../../test/fixtures/claude-code');

const entry = (pid: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ pid, sessionId: `s-${pid}`, cwd: '/projects/app', startedAt: 1, kind: 'interactive', status: 'idle', ...extra });

describe('session registry', () => {
  let tmp: ReturnType<typeof tempDir>;
  let sessions: string;
  beforeEach(() => {
    tmp = tempDir();
    sessions = join(tmp.dir, 'sessions');
    mkdirSync(sessions);
  });
  afterEach(() => tmp.cleanup());

  it('maps busy/idle/waiting/shell', () => {
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'busy' }))!)).toEqual({ status: 'working' });
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'idle' }))!)).toEqual({ status: 'idle' });
    // Idle with a background shell running (Claude Code 2.1.292+).
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'shell' }))!)).toEqual({ status: 'shell' });
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'waiting', waitingFor: 'input needed' }))!)).toEqual({
      status: 'waiting',
      waiting: { reason: 'question', text: 'answer a question' },
    });
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'waiting', waitingFor: 'Allow Bash(rm -rf x)?' }))!)).toEqual({
      status: 'waiting',
      waiting: { reason: 'permission', text: 'approve a permission' },
    });
    expect(registryStatus(parseRegistryEntry(entry(1, { status: undefined }))!)).toEqual({});
  });

  it('compares Claude Code versions', () => {
    expect(compareVersions('2.1.292', '2.1.292')).toBe(0);
    expect(compareVersions('2.1.300', '2.1.292')).toBeGreaterThan(0);
    expect(compareVersions('2.1.29', '2.1.292')).toBeLessThan(0);
    expect(compareVersions('2.2.0-beta', '2.1.999')).toBeGreaterThan(0);
  });

  it('rejects entries without the essential fields', () => {
    expect(parseRegistryEntry('{"pid":1}')).toBeUndefined();
    expect(parseRegistryEntry('not json')).toBeUndefined();
    expect(parseRegistryEntry(entry(7, { agent: 'reviewer' }))).toMatchObject({ pid: 7, sessionId: 's-7', agent: 'reviewer' });
  });

  it('reads the real 2.1.30x files, procStart included (P0-05)', () => {
    const busy = parseRegistryEntry(readFileSync(join(FIXTURES, 'registry-busy.json'), 'utf8'))!;
    expect(busy).toMatchObject({ pid: 42756, status: 'busy', version: '2.1.309', procStart: '134372522336881641', entrypoint: 'claude-vscode' });
    // procStart is a FILETIME: it lands within seconds of startedAt.
    expect(Math.abs(filetimeToMs(busy.procStart!)! - busy.startedAt!)).toBeLessThan(10_000);
    expect(parseRegistryEntry(readFileSync(join(FIXTURES, 'registry-idle.json'), 'utf8'))).toMatchObject({ status: 'idle' });
    expect(parseRegistryEntry(entry(1, { procStart: 'not a number' }))?.procStart).toBeUndefined();
  });

  it('lists live sessions, never opens .key files and checks the PID outside Docker', () => {
    writeFileSync(join(sessions, '10.json'), entry(10));
    writeFileSync(join(sessions, '11.json'), entry(11));
    // A .key file that isn't even readable as text: opening it would show in the results.
    writeFileSync(join(sessions, '10.abcdef.key'), '{"pid":99,"sessionId":"secret","cwd":"/x"}');
    writeFileSync(join(sessions, 'notes.json'), entry(12));
    const alive = new Set([10]);
    const reader = new RegistryReader(tmp.dir, { checkPid: true, isAlive: (e) => alive.has(e.pid) });
    expect(reader.poll().entries.map((e) => e.pid)).toEqual([10]);
    const docker = new RegistryReader(tmp.dir, { checkPid: false });
    expect(docker.poll().entries.map((e) => e.pid).sort()).toEqual([10, 11]);
  });

  it('invalid JSON (a write in progress) keeps the last good version', () => {
    const file = join(sessions, '20.json');
    writeFileSync(file, entry(20, { status: 'busy' }));
    const reader = new RegistryReader(tmp.dir, { checkPid: false });
    expect(reader.poll().entries[0]!.status).toBe('busy');
    writeFileSync(file, '{"pid":20,"sessionId":"s-20","cw');
    expect(reader.poll().entries[0]!.status).toBe('busy');
    writeFileSync(file, entry(20, { status: 'idle', extra: 'x' }));
    expect(reader.poll().entries[0]!.status).toBe('idle');
    rmSync(file);
    expect(reader.poll().entries).toEqual([]);
  });

  it('a missing sessions/ folder is reported as a source with a problem', () => {
    const reader = new RegistryReader(join(tmp.dir, 'none'), { checkPid: false });
    expect(reader.poll()).toMatchObject({ ok: false, entries: [] });
  });
});

describe.runIf(process.platform === 'win32')('ProcStartChecker (Windows)', () => {
  it('asks once per (pid, procStart); a different start means the PID was reused', async () => {
    let calls = 0;
    const checker = new ProcStartChecker(async () => {
      calls++;
      return '200';
    });
    expect(checker.matches(5, '100')).toBe(true); // pending: alive until the answer arrives
    await new Promise((ok) => setTimeout(ok, 0));
    expect(checker.matches(5, '100')).toBe(false);
    expect(checker.matches(5, '200')).toBe(true);
    await new Promise((ok) => setTimeout(ok, 0));
    expect(checker.matches(5, '200')).toBe(true);
    expect(checker.matches(5, undefined)).toBe(true);
    expect(calls).toBe(2);
  });

  it('an unknown answer (no such process, access denied) leaves the decision to the PID probe', async () => {
    const checker = new ProcStartChecker(async () => undefined);
    checker.matches(6, '100');
    await new Promise((ok) => setTimeout(ok, 0));
    expect(checker.matches(6, '100')).toBe(true);
  });
});
