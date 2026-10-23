# Changes log (overnight Phase 0 run)

A running log of what was done while you were away, what was decided on your behalf, and what needs your eyes.
Newest task at the bottom. Branch: `phase-0` (pushed to `origin`; `main` is untouched).

## Decisions you made before signing off

| Open decision | Answer |
| --- | --- |
| Final name | **Agent Office** (env prefix `AGENT_OFFICE_` unchanged) |
| Default camera | **Orthographic isometric**, perspective as a setting (P0-06 confirms with numbers) |
| Character assets | **Quaternius CC0** (P0-07 verifies clips and licenses) |
| UI languages | **English only** for v1, all strings through `t()` |
| Packaging | **Single npm package**, folder rules enforced by `test/boundaries.test.ts` |
| Codex fixtures | **Deferred to P5-01** (Codex isn't installed on this machine) |

## Decisions I made on your behalf

- **Work on a branch.** All Phase 0 commits are on `phase-0`, pushed to `origin`. Merge it into `main` when you're
  happy (or tell me to).
- **Copyright line** in `LICENSE` reads "the Agent Office contributors". Change it to your name if you prefer.
- **README.** Your GitHub "Initial commit" README ("My virtual space for my agents") was replaced by a fuller stub.
  The old text is still in commit `8b74886`.
- **CI runs on every push** (not only `main`), on Ubuntu and Windows, Node 22.12, so the branch gets checked.

## Task log

### P0-01 Name & repo — done

- Added `LICENSE` (MIT), `NOTICE.md` (Habblaud's MIT notice, non-affiliation statement), `README.md`, `.gitignore`.
- `.claude/settings.local.json` (your local Claude permissions) is git-ignored.

### P0-02 Tooling scaffold — done

- `package.json`: `"type": "module"`, `engines.node >= 22.12`, **no runtime dependencies**, dev tools pinned exactly
  (TypeScript 7.0.2, Vite 8.3.5, Vitest 5.0.5, esbuild 0.28.2, tsx 4.23.15, `@types/node` 22.20.5 so typecheck
  catches APIs newer than our Node floor).
- `tsconfig.json` (client + shared, DOM) and `server/tsconfig.json` (Node side, no DOM).
- `npm run dev`: one server on `127.0.0.1:4848` with Vite in middleware mode (HMR). `npm run build`: Vite client +
  esbuild server bundle. `npm start` runs the bundle.
- Skeleton server: `/api/health` only (the rest is P1-05). Smoke-tested both dev and built servers; both bind to
  `127.0.0.1` only.
- `test/boundaries.test.ts` enforces CLAUDE.md's folder rules: no runtime deps, exact pins, server imports only
  `node:*`/relative, `shared/` and `client/src/core/` never import `three`, hook shims import only `node:*`.
- `.gitattributes` forces LF (shims and fixtures must be byte-identical across OSes).
- Checks: `npm run typecheck`, `npm test` (9 tests), `npm run build` all pass locally on Windows / Node 26.7.
