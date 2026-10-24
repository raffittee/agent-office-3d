# Codex: provider notes

**Status: not verified.** Codex isn't installed on this machine (no `codex` on PATH, no `~/.codex`), so per the
decision of 2026-10-24 the check and the fixtures moved to **P5-01**, where Codex support is built.

Until then, the facts in CLAUDE.md › Provider notes › Codex come from Habblaud (v1.0.3) and are **unverified**:

- open sessions: `<CODEX_HOME>/thread-writer-locks/<threadId>.lock`;
- rollouts: `sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`;
- hooks in `<CODEX_HOME>/hooks.json`, trusted per command hash;
- never read `auth.json` or `config.toml`.

P5-01 must install Codex, run a session, capture a sanitized lock file and rollout slice into
`test/fixtures/codex/`, and rewrite this note from the real files.
