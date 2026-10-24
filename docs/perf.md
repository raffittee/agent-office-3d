# Performance (P3-06)

Budget (CLAUDE.md): **60 fps at 1080p on an integrated GPU with 30 agents and 15 rooms, under 300 draw calls.**

## How to measure

- On a real machine: `npm run build && npm start`, then open
  `http://127.0.0.1:4848/?mock=1&sessions=30&stats=1`. The top bar shows fps, JavaScript ms per frame, draw calls and
  agents. Settings → Characters switches robots ↔ simple shapes.
- In code: `agentOffice.world.stats()` in the browser console returns
  `{ fps, cpuMs, phases: { sim, sync, render, labels }, calls, triangles, agents, rooms }`.
- In CI: `npm run shot -- --sessions 30` records the same stats in `artifacts/shot.json`. It fails above 300 draw calls.

## Results (2026-10-25, cloud container, headless Chromium with SwiftShader)

The cloud container has no GPU. SwiftShader rasterizes on the CPU, using every core, so:

- **draw calls and triangles are exact**;
- `render` measures software rasterization, not the cost on a GPU;
- JavaScript timings are inflated by the rasterizer competing for CPU (treat them as upper bounds).

1920×1080, `?mock=1&seed=7&sessions=30` (38 agents with subagents, 6 project rooms), after 12 s:

| Characters | Draw calls | Triangles | sim | scene sync | render (software) | labels | JS per frame |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Robots (rigged) | 72 | 135k | 0.8 ms | 5.0 ms | 13.0 ms | 0.5 ms | 20 ms |
| Simple shapes | 39 | 41k | 0.4 ms | 1.6 ms | 3.3 ms | 0.7 ms | 7 ms |

Inside the robots' 5 ms of scene sync, timed separately per frame:

| Part | ms |
| --- | ---: |
| 38 animation mixers | 0.66 |
| Procedural pose layers | 0.19 |
| One world-matrix update for the whole scene | 1.17 |
| Building and screens sync | 0.25 |

## What the pass changed

- **Draw calls stay flat as agents are added.**
  - One merged mesh per area (solid, glass, glow).
  - One draw call per robot: the pipeline merges each model to one mesh and one material.
  - Instanced shadows, badges, lanyards, held items and capsule parts.
  - One instanced mesh for all desk screens, from a shared 512×512 canvas atlas (texture atlas).
- **Off-screen robots** aren't drawn (manual frustum culling with a margin), and their animation runs at a quarter of
  the rate.
- **One world-matrix update per frame:** the loop updates matrices once, then places attachments from the bones, and
  `render()` doesn't update them again (`scene.matrixWorldAutoUpdate = false`).
- **Pose layers** compose parent rotations from local quaternions instead of asking for world matrices (which
  recomputed every ancestor on each call). Attachments read bone positions from the fresh matrices.
- Hot paths reuse temporary vectors and matrices instead of allocating each frame.
- Rendering stops while the tab is hidden.

## Against the budget

- **Draw calls:** 72 for 38 agents and 6 rooms. 15 rooms add about 9 per room (merged area, plus instanced screens
  shared by all), about 160 in total: **within 300**.
- **Frame rate:** not measurable here. The Phase 0 renderer spike measured ~11–14 ms of GPU time for a 15-room office
  on an Intel UHD (ADR 0003). The asset spike measured 30 animated characters at ~13 ms with 2 draw calls each; ours
  use 1. **Check on the target machine** with `?stats=1`. If it falls short, the next levers are the quality tiers in
  ADR 0003 (MSAA off, DPR 1) and lowering the update rate of small on-screen robots.
