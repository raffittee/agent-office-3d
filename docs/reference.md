# Reference implementation

| | |
| --- | --- |
| Project | [Habblaud](https://github.com/marmottajr/habblaud), MIT, © 2026 Márcio Junior |
| Path in use | `C:\Users\Rafi\Documents\Code\habblaud` (the `reference/habblaud/` fallback clone is not needed) |
| Version | v1.0.3, commit `faa1a012b5fbf632c66dc6801c5383e53a542406` (2026-10-16) |
| State | clean working tree, verified 2026-10-24 |

The checkout is **read-only** for this project. If it moves or changes, re-check the commit before porting:

```sh
git -C <path> rev-parse HEAD   # must print faa1a012…
git -C <path> status --porcelain   # must print nothing
```

## Porting checklist

1. Read the whole source file **and its tests** before porting. Port the tests too.
2. Start the file with `// Ported from habblaud <path> (MIT, © 2026 Márcio Junior)`.
3. Translate Portuguese comments and strings into English.
4. Replace the Claude-only assumptions (a missing `provider` means Claude, statuses from Claude's registry) with the
   provider-neutral protocol.
5. Strip every Habblaud World reference (below) and any Habblaud branding.

## Habblaud World code outside the excluded folders

CLAUDE.md excludes `shared/world/`, `server/world/`, `client/src/world/city/`, `client/src/world/visit*`,
`client/src/ui/world/` and `docs/world/`. World code also reaches into files we *do* port. Strip it there:

| File | What to strip |
| --- | --- |
| `client/src/world/sim/visitor.ts` | The whole file (the World visitor avatar). Do not port. |
| `client/src/world/sim/world-visit.test.ts` | The whole file. Do not port. |
| `client/src/world/sim/sim.ts` | Imports from `./visitor` (`VISITOR_LANYARD`, `stepFree`, `VisitorIntent`, …) and the visitor code paths. |
| `client/src/net/world.ts`, `world-stream.ts` (+ tests) | The whole files. `net/store.ts` is ported without them. |
| `shared/types.ts` | World-related fields and imports. |
| `server/model/office.ts` | World-related fields and hooks. |
| `server/http/app.ts` | The `/api/world/*` routes and their wiring. |
| `shared/locales/*.ts` | World strings (the locale files aren't ported: v1 ships English only). |
| `server/test/fake-world.ts` | The whole file. Do not port. |
