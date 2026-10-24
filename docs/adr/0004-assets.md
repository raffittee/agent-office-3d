# ADR 0004: Asset sources and pipeline

- **Status:** accepted
- **Date:** 2026-10-24
- **Evidence:** [P0-07 asset spike](../spikes/assets.md), [P0-06 renderer spike](../spikes/renderer.md)

## Context

The office needs rigged, animated characters and furniture for four themes, under CC0 or similarly permissive
licenses (CLAUDE.md › Conventions › Assets), within 15 MB per theme pack, and cheap enough to animate 30 agents at
60 fps on an integrated GPU. The user chose Quaternius (CC0) for characters during P0-08.

## Decision

1. **Characters:** Quaternius **Universal Base Characters** and **Universal Animation Library**, Standard (free)
   tiers, both CC0 1.0. The four poses the free clips lack (type, wave, sleep, raise hand) are **procedural pose
   layers** (bone overrides blended over a base clip), and are replaced with authored clips only if they look wrong.
2. **Furniture:** **Kenney Furniture Kit** (CC0) as the base set for all themes. Its materials are named by surface,
   and themes re-material them by name. Kinds it lacks use procedural defaults.
3. **Textures** (Phase 4 themes): CC0 sets only (e.g. ambientCG, Poly Haven), verified one by one.
4. **Pipeline:** `gltf-transform` (pinned dev dependency, P3-01):
   - merge each theme's kit into one GLB;
   - `optimize` with **meshopt** and no simplification;
   - strip `KHR_materials_unlit`;
   - build a 25% LOD for characters;
   - encode textures to **KTX2** with `toktx`;
   - run budget checks (triangles, joints, materials, texture size) and the `ASSETS.md` check in CI.
5. **Character budget:** one material, ≤ ~25 joints (no finger bones), LOD for overview zoom, and reduced-rate
   animation updates for small or off-screen characters.

## Consequences

- Everything is CC0: no attribution is required, but `ASSETS.md` still lists every source and license.
- A character with all clips is ~0.3 MB over the wire and the furniture kit ~0.2 MB, far under the 15 MB budget.
- 30 animated characters fit the frame budget; 60 don't without the character budget above. P3-06 has to deliver it.
- The procedural pose layers are new code in `render3d/`. The sim keeps emitting neutral `Pose` values.
- Quaternius's base characters come from itch.io, which needs a manual download (no direct link).
- Kenney's kit is from 2018 and lacks some office kinds (water cooler, whiteboard, cubicles, ping-pong). Themes fill
  those gaps with procedural or additional CC0 models.
