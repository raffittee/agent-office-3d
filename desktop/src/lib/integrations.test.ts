// The integrations runner and the pieces around it.
import { mkdtempSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CH, parseIntegration, parseIntegrationAction, parseMode } from './ipc';
import { describeNode, installerArgs, integrationsInfo, nodeVersionOk, parseInstalled, runInstaller } from './integrations';
import { createLogger } from './log';
import { readFileSync } from 'node:fs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-installer.mjs', import.meta.url));

function packageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ao-int-'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(FAKE, join(dir, 'scripts', 'hooks-install.mjs'));
  copyFileSync(FAKE, join(dir, 'scripts', 'usage-install.mjs'));
  return dir;
}

describe('ipc messages', () => {
  it('accepts only known values', () => {
    expect(parseMode('widget')).toBe('widget');
    expect(parseMode('window')).toBe('window');
    for (const bad of ['Widget', '', null, undefined, 1, {}]) expect(parseMode(bad)).toBeNull();
    expect(parseIntegration('codex')).toBe('codex');
    expect(parseIntegration('usage')).toBe('usage');
    for (const bad of ['rm -rf', '../codex', 'Codex', null, 7]) expect(parseIntegration(bad)).toBeNull();
    expect(parseIntegrationAction('install')).toBe('install');
    expect(parseIntegrationAction('uninstall')).toBe('uninstall');
    for (const bad of ['status', 'delete', null]) expect(parseIntegrationAction(bad)).toBeNull();
  });

  it('has a unique channel name for each message', () => {
    const names = Object.values(CH);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith('shell:'))).toBe(true);
  });
});

describe('node check', () => {
  it('needs 22.12 or newer', () => {
    for (const ok of ['v22.12.0', 'v22.22.0\n', '22.12.1', 'v24.0.0', 'v100.0.0']) expect(nodeVersionOk(ok), ok).toBe(true);
    for (const bad of ['v22.11.9', 'v20.19.0', 'v18.0.0', 'nonsense', '']) expect(nodeVersionOk(bad), bad).toBe(false);
  });

  it('explains each case', () => {
    expect(describeNode(null)).toMatchObject({ ok: false, message: expect.stringContaining('not found') });
    expect(describeNode('v20.1.0\n')).toMatchObject({ ok: false, message: expect.stringContaining('too old') });
    expect(describeNode('v22.22.0\n')).toEqual({ ok: true, message: 'Node.js v22.22.0 found.' });
  });
});

describe('installer commands', () => {
  it('builds the commands the CLI would run', () => {
    expect(installerArgs('gemini-cli', 'install', 4848)).toEqual({ script: 'hooks-install.mjs', args: ['install', '--provider', 'gemini-cli', '--port', '4848'] });
    expect(installerArgs('codex', 'status', 4848)).toEqual({ script: 'hooks-install.mjs', args: ['status', '--provider', 'codex'] });
    expect(installerArgs('claude-code', 'uninstall', 4848).args).toEqual(['uninstall', '--provider', 'claude-code']);
    expect(installerArgs('usage', 'install', 4848)).toEqual({ script: 'usage-install.mjs', args: ['install'] });
  });

  it('reads installed and not installed from the status text', () => {
    expect(parseInstalled('gemini-cli', '• ~/.gemini/settings.json: installed for SessionStart, BeforeAgent\nAgent Office at http://127.0.0.1:4848: running.')).toBe(true);
    expect(parseInstalled('gemini-cli', '• ~/.gemini/settings.json: not installed')).toBe(false);
    expect(parseInstalled('codex', '• ~/.codex/hooks.json: not installed\n= something')).toBe(false);
    expect(parseInstalled('usage', '• ~/.claude/settings.json: installed')).toBe(true);
    expect(parseInstalled('usage', '• ~/.claude/settings.json: not installed')).toBe(false);
    expect(parseInstalled('usage', '')).toBe(false);
  });
});

describe('running the installers', () => {
  it('runs one and collects its output', async () => {
    const dir = packageDir();
    try {
      const r = await runInstaller({ execPath: process.execPath, packageDir: dir, port: 4900 }, 'gemini-cli', 'install');
      expect(r.ok).toBe(true);
      expect(r.output).toContain('install gemini-cli');
      expect(r.output).toContain('--port 4900');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports failures with the installer’s message', async () => {
    const dir = packageDir();
    try {
      const r = await runInstaller({ execPath: process.execPath, packageDir: dir, port: 4848, env: { FAKE_FAIL: '1' } }, 'gemini-cli', 'install');
      expect(r.ok).toBe(false);
      expect(r.output).toContain('EACCES');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says so when the installer is missing', async () => {
    const r = await runInstaller({ execPath: process.execPath, packageDir: join(tmpdir(), 'ao-nothing-here'), port: 4848 }, 'codex', 'status');
    expect(r.ok).toBe(false);
  });

  it('collects the status of every integration', async () => {
    const dir = packageDir();
    try {
      const info = await integrationsInfo({ execPath: process.execPath, packageDir: dir, port: 4848 });
      expect(info.items).toEqual([
        { id: 'claude-code', installed: false },
        { id: 'gemini-cli', installed: true },
        { id: 'codex', installed: false },
        { id: 'usage', installed: true },
      ]);
      expect(typeof info.node.ok).toBe('boolean');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('log', () => {
  it('appends dated lines, one per message, and rotates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-log-'));
    try {
      const file = join(dir, 'logs', 'desktop.log');
      const log = createLogger(file, () => new Date('2026-11-08T10:00:00Z'));
      log.info('started on 4848');
      log.error('first line\nsecond line');
      expect(readFileSync(file, 'utf8')).toBe('2026-11-08T10:00:00.000Z INFO started on 4848\n2026-11-08T10:00:00.000Z ERROR first line | second line\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
