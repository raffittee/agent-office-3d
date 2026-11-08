// The installer configuration: per-user, hardened, with the release package bundled outside the asar.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs data module, no types
import { builderConfig } from '../../tools/builder-config.mjs';

const config = builderConfig({ version: '1.2.3', packageDir: '/x/release/agent-office-1.2.3' });

describe('installer config', () => {
  it('installs per user, without an administrator prompt', () => {
    expect(config.nsis).toMatchObject({ oneClick: true, perMachine: false, allowElevation: false, deleteAppDataOnUninstall: false });
    expect(config.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(config.win.artifactName).toBe('Agent-Office-Setup-${version}.${ext}');
  });

  it('bundles the release package as real files', () => {
    expect(config.extraResources).toEqual([{ from: '/x/release/agent-office-1.2.3', to: 'package' }]);
    expect(config.extraMetadata).toEqual({ version: '1.2.3', main: 'dist/main.cjs' });
  });

  it('ships the compiled app and assets but not sources, maps or the installer script', () => {
    expect(config.files).toEqual(expect.arrayContaining(['dist/**/*', 'assets/**/*', '!dist/**/*.map']));
    expect(config.files.some((f: string) => f.startsWith('src'))).toBe(false);
    expect(config.files).toContain('!assets/installer.nsh');
  });

  it('removes the hooks when uninstalling, but not on an upgrade', () => {
    const nsh = readFileSync(fileURLToPath(new URL('../../assets/installer.nsh', import.meta.url)), 'utf8');
    expect(nsh).toContain('${ifNot} ${isUpdated}');
    for (const provider of ['gemini-cli', 'codex', 'claude-code']) expect(nsh).toContain(`uninstall --provider ${provider}`);
    expect(nsh).toContain('usage-install.mjs" uninstall');
    expect(nsh).toContain('ELECTRON_RUN_AS_NODE');
  });
});
