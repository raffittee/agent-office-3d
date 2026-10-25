# Contributing

Thanks for helping. The short version: keep logic pure and tested, keep vendor code in its adapter, and never weaken
the local-only, read-only rules.

## Setup

```bash
npm ci
npm run demo                 # the office with simulated agents, live reload
npm run typecheck && npm test && npm run build   # what CI runs (plus a screenshot smoke test)
```

Node 22.12 or newer. The server has **no runtime dependencies**; the client pins exact versions.

## Where things go

| Folder | What lives there |
| --- | --- |
| `shared/` | Pure TypeScript for both sides: the protocol, the reducer, activities, masking. No Node or DOM APIs. |
| `server/` | Node: HTTP and SSE, ingest, the interactive features, and `adapters/<provider>/` (the only place that knows a vendor's formats). |
| `hooks/` | Standalone shims the CLIs run: `node:*` imports only, never break the agent. |
| `client/src/core/` | The pure simulation (layout, nav, sim, social). Must not import `three` or the DOM layers. |
| `client/src/render3d/`, `client/src/ui/` | Three.js and the DOM panels: thin layers over `core/`. |
| `themes/<id>/` | Theme packs (JSON, small models). See [docs/themes.md](docs/themes.md). |
| `sdk/`, `plugins/` | Emitters for custom agents; the Claude Code messages plugin. |

`test/boundaries.test.ts` enforces these rules.

## Rules of thumb

- **Pure first.** Anything with logic gets a pure function and a unit test with fixtures. Three.js and DOM code stays
  thin.
- **Never guess a format.** New provider data comes with a real, sanitized sample in `test/fixtures/<provider>/`.
- **Additive protocol changes only.** Never rename or remove a field in `shared/protocol.ts`.
- **Security is not optional.** Read [docs/security.md](docs/security.md):
  - Agent folders are read-only, and credential files are never opened.
  - Mask and cut text with `maskSecrets` and `truncate` before it leaves the server.
  - Session-touching routes go behind the interactive gate in `server/http/app.ts`, and get a row in
    `test/interactive-routes.test.ts`.
- **Text through `t()`**, in English.
- **Assets:** CC0 or similar, listed in [ASSETS.md](ASSETS.md), compressed.
- **Performance budget:** 60 fps on an integrated GPU with 30 agents, under 300 draw calls
  ([docs/perf.md](docs/perf.md)).

## Adding a provider

Follow [docs/providers/adding-a-provider.md](docs/providers/adding-a-provider.md): capture fixtures, write the
adapter (`ProviderAdapter`), the tool table in `shared/tools/`, and, if the CLI has hooks, a shim and an installer
target.

## Commits and pull requests

- One task (from [TASKS.md](TASKS.md)) per commit when possible; tick its box with a one-line note.
- Add a dated entry to [CHANGES.md](CHANGES.md) in plain words: what changed for someone using the office.
- Record decisions as short ADRs in `docs/adr/`.
- Code ported from Habblaud starts with `// Ported from habblaud <path> (MIT, © 2026 Márcio Junior)`. Never port
  or contact Habblaud World, and don't use Habblaud's brand.
