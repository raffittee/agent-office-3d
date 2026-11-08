# ADR 0009: Rendering tiers, tone mapping and day/night light

- **Status:** accepted
- **Date:** 2026-11-08
- **Amends:** [ADR 0003](0003-renderer-and-camera.md) (renderer); changes "post-fx are not drawn in v1" for the `high` tier
- **Plan:** [docs/plans/graphics-and-boss.md](../plans/graphics-and-boss.md)

## Context

The first look was flat: Lambert materials under a fill light and a sun with no shadows, no tone mapping, and a grey
background. Day looked overcast. Night turned every light down at once (fill ×0.5, sun ×0.28, dark rooms at 18%), so
the office was close to unreadable. The windows were flat pale panels.

## Decision

1. **Quality tiers** (`?quality=` or Settings → Graphics quality; the desktop widget is always `low`):
   `low` has no shadows and no environment map (the old look plus tone mapping); `medium` (default) adds a 2048 px
   sun shadow refreshed every second frame and the sky reflections; `high` uses a 4096 px shadow refreshed every frame.
   SSAO, bloom and SMAA stay planned for `high` (P10-04) and are not built yet.
2. **Tone mapping:** Khronos PBR Neutral, with an exposure per hour. It keeps the theme's colors as authored and rolls
   bright areas off softly. Light tints (dawn, dusk, moon) change the hue of a light, not its brightness
   (`keepLuminance`).
3. **Day and night are light levels, not dimming** (`core/daylight.ts`, pure and tested): by day a strong sun over a
   softer fill; at night a dim fill and moon, a higher exposure, and a per-material *gain* so lit rooms keep
   `nightBrightness` (default 85%, Settings: 40–100%) of their daytime brightness. Floors the tests pin: lit rooms at
   night ≥ 85% (at the default) and unlit ≥ 45% of a lit room's daytime brightness; unlit rooms lose only ~10% by day.
4. **Sun path:** east at sunrise, west at sunset, on the camera's side, at about 55° at noon. A higher sun makes
   shadows so short that the isometric camera never sees them.
5. **Sky and windows:** one sky model (`render3d/sky.ts`: gradient background, a small environment map rebuilt only when
   the sky changes, at most every 2 s). Window glass (`render3d/glass.ts`) reflects it, shows a sun glint that follows
   the sun, and glows warm when its room is lit after dark.
6. **Materials:** the building and furniture stay **Lambert** (vertex colors) for now. Moving them to a light
   Standard/PBR material would add shader cost on every area mesh without a visible gain until the kit has bevels and
   baked AO (P10-05), so it moves there. The glass is already Standard.

## Consequences

- Shadows cost about 20–40 draw calls and double the triangles (35 → 54 draw calls, 40k → 79k triangles for 12
  sessions, `docs/perf.md`). `low` is as cheap as before. The cloud renders in software, so frame times need the user's
  GPU.
- `npm run shot -- --golden` renders four hours and fails when the mean brightness of the building drops below a floor,
  so a later change can't make the office dark again without a test failing.
- The theme's `lighting` values are now midday values that the renderer scales (documented in `docs/themes.md`).
- Open: lamp light pools and a rim light on characters at night (P10-19), post-fx on `high` (P10-04), PBR materials
  (P10-05).
