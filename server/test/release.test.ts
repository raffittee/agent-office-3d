// P8-05: the release script's pure parts.
import { describe, expect, it } from 'vitest';
import { hasChangelogSection, lockWithVersion, withVersion } from '../../scripts/release';

describe('release', () => {
  it('sets the version and keeps the rest', () => {
    expect(withVersion('{\n  "name": "x",\n  "version": "0.0.0",\n  "type": "module"\n}\n', '0.1.0')).toBe('{\n  "name": "x",\n  "version": "0.1.0",\n  "type": "module"\n}\n');
    const lock = JSON.parse(lockWithVersion(JSON.stringify({ version: '0.0.0', packages: { '': { version: '0.0.0' }, 'node_modules/a': { version: '1.0.0' } } }), '0.1.0'));
    expect(lock.version).toBe('0.1.0');
    expect(lock.packages[''].version).toBe('0.1.0');
    expect(lock.packages['node_modules/a'].version).toBe('1.0.0');
  });

  it('needs release notes first', () => {
    expect(hasChangelogSection('# Changelog\n\n## 0.1.0 — 2026-10-25\n', '0.1.0')).toBe(true);
    expect(hasChangelogSection('## [0.1.0] - 2026-10-25', '0.1.0')).toBe(true);
    expect(hasChangelogSection('## 0.1.01', '0.1.0')).toBe(false);
    expect(hasChangelogSection('## 0.2.0', '0.1.0')).toBe(false);
  });
});
