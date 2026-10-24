# ADR 0005: Interim character model and a model-agnostic rig

- **Status:** accepted
- **Date:** 2026-10-25
- **Amends:** [ADR 0004](0004-assets.md) (characters)

## Context

ADR 0004 picked Quaternius's Universal Base Characters and Universal Animation Library for people. The base
characters need a manual itch.io download, and the cloud environment that builds Phase 3 can't reach OpenGameArt,
itch.io, quaternius.com or kenney.nl (its network policy allows GitHub and npm only). Phase 3 still needs a rigged
character to build and verify the animation runtime against a real file. Guessing bone names or clip names for a file
nobody could open would break the "never guess a format" rule.

## Decision

1. **Ship RobotExpressive as the default character for now.** It's by Quaternius too (Tomás Laulhé), CC0 1.0 (license
   stated in the three.js repository's README for the model), reachable on GitHub, rigged, and it has the clips we
   need: Idle, Walking, Running, Sitting, Wave, Yes, No, ThumbsUp, Dance, Jump. It's fetched at a pinned three.js tag
   and checked against a pinned SHA-256.
2. **The rig runtime is model-agnostic.** Each built character comes with a profile (`shared/character-profile.ts`):
   bone names, clip names, scale, seat offset and recolorable slots. Procedural pose layers rotate bones about axes in
   the character's own space, so no per-model axis convention is needed.
3. **The human characters from ADR 0004 remain the target.** `npm run assets:fetch` already knows the Universal
   Animation Library source. Building a human character is a new entry in `scripts/assets/sources.ts`, made where the
   files can be downloaded. The build refuses a profile that names a bone or clip the file lacks.
4. **Capsule people stay available** as a setting, and as the fallback while the model loads or if it fails to.

## Consequences

- Agents look like small robots until the human pack is built. That fits the stylized low-poly direction, and every
  agent's robot is recolored from its seed.
- The pipeline (`scripts/assets/`) handles models made of rigid parts as well as skinned ones: RobotExpressive is 12
  rigid meshes on bones plus 2 skinned hands, merged into one skinned mesh with one material (1 draw call, 23 joints,
  3,237 triangles, 159 KB).
- The user's machine can reach the ADR 0004 sources. Pinning the Universal Animation Library's SHA-256 happens on
  first fetch there.
