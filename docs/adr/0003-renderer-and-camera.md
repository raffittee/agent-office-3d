# ADR 0003: Renderer, camera and cutaway

- **Status:** accepted
- **Date:** 2026-10-24
- **Evidence:** [P0-06 renderer spike](../spikes/renderer.md)

## Context

The office is a Three.js scene of up to ~15 rooms and ~30 agents (CLAUDE.md budget: 60 fps at 1080p on an integrated
GPU, under 300 draw calls). Two decisions were open: the default camera (orthographic isometric or perspective)
and how walls in front of rooms get out of the way (cutaway). We measured both on the target hardware class (Intel
UHD Graphics, 1920×1080).

## Decision

1. **WebGL2 through Three.js `WebGLRenderer`** (D3), with `CSS2DRenderer` for name labels and bubbles. WebGPU is
   not needed for this scene size.
2. **Default camera: orthographic isometric.** Pitch 35.264°, yaw 45° + k·90°, rotation in animated 90° steps,
   zoom and pan. The default framing fits ~4–6 rooms, with "fit office" on demand. **Perspective is available only
   as an optional follow-cam** for a single agent.
3. **Cutaway: `cut`.** Walls facing the camera are cut to ~0.4 m; `hide` (removed) is a user setting. `fade` is not
   offered. Walls are re-laid only when the set of camera-facing sides changes.
4. **Batching:** merged floors; one `InstancedMesh` per wall type and furniture kind; at most 2 draw calls per
   character (one skinned mesh, one material); character shadows are instanced blob decals.
5. **Quality tiers** chosen from measured frame time: low (no MSAA or shadows), medium (MSAA, static shadow map, no
   post-fx; default on integrated GPUs), high (adds theme post-fx). A theme's `postfx` is a request the renderer
   may downgrade.

## Consequences

- At default settings the GPU spends ~11–14 ms per frame on this hardware (MSAA ~5 ms, shadows 0–3.5 ms). 60 fps
  holds, with only ~3–5 ms of headroom. Post-fx must stay optional, and Phase 3 assets must respect the
  per-character draw-call limit.
- Orthographic projection makes picking, label placement and room framing simpler, and keeps far rooms readable.
  The trade-off is less depth, which the optional perspective follow-cam offsets.
- 90° rotation steps keep the cutaway cheap and predictable: at most 4 wall layouts.
- Label decluttering (P2-08) is required: labels collide at overview zoom.
- Performance budgets are measured as GPU-synced frame cost ("burst ms"). Headless rAF fps is capped at ~55 Hz and
  hides headroom.
