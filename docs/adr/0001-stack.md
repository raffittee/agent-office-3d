# ADR 0001: Stack and repository layout

- **Status:** accepted
- **Date:** 2026-10-24

## Context

Agent Office has a local Node server that watches agent CLIs and a browser client that renders a 3D office. It runs
on developers' machines (Windows, macOS, Linux), next to the agents it observes, and must be safe and light.
Habblaud, the reference, uses the same split.

## Decision

- **Language:** TypeScript (strict, ESM). Target Node **≥ 22.12**; CI runs on 22.12. The client targets evergreen
  browsers with WebGL2.
- **Server:** `node:http`, `node:fs` and SSE, with **zero runtime dependencies**. In development it is run by `tsx`;
  for `npm start` it is bundled into one ESM file by esbuild.
- **Client:** Vite (in middleware mode inside the server for `npm run dev`, one port, `127.0.0.1:4848`), Three.js
  (ADR 0003), vanilla TypeScript DOM panels. No UI framework.
- **Tests:** Vitest. Pure modules are unit-tested with fixtures; `playwright-core` is used for screenshots and smoke
  tests.
- **One npm package** (no workspaces). Folder rules are enforced by two tsconfigs (client + shared with DOM; server
  without DOM) and by `test/boundaries.test.ts`:
  - no runtime `dependencies`;
  - every version pinned exactly;
  - server imports only `node:*` and relative paths;
  - `shared/` and `client/src/core/` never import `three`;
  - hook shims import only `node:*`.
- **CI:** GitHub Actions on every push, Ubuntu and Windows, Node 22.12: `typecheck`, `test`, `build`.
- **Line endings:** LF everywhere (`.gitattributes`), so hook shims and fixtures are byte-identical across OSes.
- **Pinned versions (2026-10-24):** TypeScript 7.0.2, Vite 8.3.5, Vitest 5.0.5, esbuild 0.28.2, tsx 4.23.15,
  Three.js 0.186.1, playwright-core 1.64.1, `@types/node` 22.20.5 (so typecheck catches APIs newer than the Node
  floor).

## Consequences

- Installing Agent Office pulls nothing at runtime, and the server's attack surface is Node itself plus our code.
- Everything the server needs from a library (YAML, globbing, HTTP routing) is written by hand or avoided.
- Windows is a first-class platform. That matters because agent CLIs behave differently there (Gemini runs hooks
  through PowerShell, P0-04).
- Dev tooling is upgraded deliberately: exact pins mean no surprise upgrades.
