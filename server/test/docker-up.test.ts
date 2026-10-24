// P8-05: the Docker mount plan only ever mounts the folders the office reads, read-only, at the host's paths.
import { describe, expect, it } from 'vitest';
import { overrideYaml, planMounts } from '../../scripts/docker-up';

describe('docker-up', () => {
  it('mounts only the read subfolders, read-only, never a whole config folder', () => {
    const plan = planMounts({ home: '/home/dev', claudeDirs: ['/home/dev/.claude', '/home/dev/.claude-work'], codexDirs: ['/home/dev/.codex'], exists: (p) => !p.includes('archived_sessions') });
    expect(plan.mounts).toEqual([
      '/home/dev/.claude/projects:/home/dev/.claude/projects:ro',
      '/home/dev/.claude/sessions:/home/dev/.claude/sessions:ro',
      '/home/dev/.claude-work/projects:/home/dev/.claude-work/projects:ro',
      '/home/dev/.claude-work/sessions:/home/dev/.claude-work/sessions:ro',
      '/home/dev/.codex/sessions:/home/dev/.codex/sessions:ro',
      '/home/dev/.codex/thread-writer-locks:/home/dev/.codex/thread-writer-locks:ro',
      '/home/dev/.gemini/tmp:/home/dev/.gemini/tmp:ro',
      '/home/dev/.agent-office/usage:/data/usage:ro',
    ]);
    for (const m of plan.mounts) {
      expect(m.endsWith(':ro')).toBe(true);
      expect(m).not.toMatch(/credentials|auth\.json|config\.toml|oauth_creds|\.claude:|\.codex:/);
    }
    expect(plan.env).toEqual({ HOME: '/home/dev', AGENT_OFFICE_CLAUDE_DIRS: '/home/dev/.claude,/home/dev/.claude-work', AGENT_OFFICE_CODEX_DIRS: '/home/dev/.codex' });
    const yaml = overrideYaml(plan);
    expect(yaml).toContain('      - "/home/dev/.claude/projects:/home/dev/.claude/projects:ro"');
    expect(yaml).toContain('      HOME: "/home/dev"');
  });
});
