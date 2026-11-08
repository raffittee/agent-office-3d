// The release package's pure parts: version rules, the manifest, the release notes from CHANGELOG.md, and what goes in.
import { describe, expect, it } from 'vitest';
import { COPY, changelogSection, isPrerelease, isVersion, packageManifest, packageName, releaseNotes, releaseTag } from '../../scripts/package';

const CHANGELOG = `# Changelog

Intro.

## 0.2.0 — 2026-11-01

### New

- Something new.

## 0.1.0 — 2026-10-25

First release.

### Known limits

- A limit.
`;

describe('package', () => {
  it('names the package and tag from the version', () => {
    expect(packageName('0.1.0')).toBe('agent-office-0.1.0');
    expect(releaseTag('0.1.0')).toBe('v0.1.0');
    expect(isVersion('1.2.3')).toBe(true);
    expect(isVersion('1.2.3-rc.1')).toBe(true);
    expect(isVersion('1.2')).toBe(false);
    expect(isVersion('v1.2.3')).toBe(false);
    expect(isPrerelease('0.2.0-rc.1')).toBe(true);
    expect(isPrerelease('0.2.0')).toBe(false);
  });

  it('writes a minimal manifest the server and the CLI can read', () => {
    const m = JSON.parse(packageManifest({ description: 'd', license: 'MIT', engines: { node: '>=22.12' }, extra: 'x' } as never, '0.3.0'));
    expect(m).toMatchObject({ name: 'agent-office', version: '0.3.0', type: 'module', license: 'MIT', engines: { node: '>=22.12' }, bin: { 'agent-office': 'bin/agent-office.mjs' } });
    expect(m.devDependencies).toBeUndefined();
    expect(m.extra).toBeUndefined();
  });

  it("takes a version's notes from the changelog, up to the next version", () => {
    expect(changelogSection(CHANGELOG, '0.1.0')).toBe('First release.\n\n### Known limits\n\n- A limit.');
    expect(changelogSection(CHANGELOG, '0.2.0')).toBe('### New\n\n- Something new.');
    expect(changelogSection(CHANGELOG, '0.3.0')).toBeNull();
    // 0.1.0 must not match 0.1.01 or 10.1.0
    expect(changelogSection('## 10.1.0 — x\n\nbody\n', '0.1.0')).toBeNull();
    expect(changelogSection('## 0.1.0\r\n\r\nbody\r\n', '0.1.0')).toBe('body');
    expect(changelogSection('## 0.1.0 — x\n\n## 0.0.9\n\nold\n', '0.1.0')).toBeNull();
  });

  it('adds install steps to the release notes', () => {
    const notes = releaseNotes('0.1.0', 'Body.');
    expect(notes.startsWith('Body.\n')).toBe(true);
    expect(notes).toContain('agent-office-0.1.0.zip');
    expect(notes).toContain('agent-office-0.1.0.tar.gz');
    expect(notes).toContain('Agent-Office-Setup-0.1.0.exe');
    expect(notes).toContain('SHA256SUMS');
  });

  it('ships only what runs: no sources, tests or credentials', () => {
    const froms = COPY.map((c) => c.from);
    for (const bad of ['server', 'client', 'shared', 'scripts', 'test', 'node_modules', '.env', 'reference', 'assets-src', 'spikes']) expect(froms).not.toContain(bad);
    expect(froms).toEqual(expect.arrayContaining(['dist/server', 'dist/client', 'hooks', 'LICENSE', 'NOTICE.md']));
    const plugins = COPY.find((c) => c.from === 'plugins')!;
    expect(plugins.skip!('agent-office-messages/tests/x.test.ts')).toBe(true);
    expect(plugins.skip!('agent-office-messages/hooks/register.ts')).toBe(false);
    expect(COPY.find((c) => c.from === 'dist/server')!.skip!('index.js.map')).toBe(true);
    expect(COPY.find((c) => c.from === 'hooks')!.skip!('shim.test.ts')).toBe(true);
  });
});
