# Assets

Every third-party asset used by Agent Office: models, animations, textures, sounds. Only CC0 or similarly permissive
licenses (CLAUDE.md › Conventions › Assets). Add a row **before** committing a file. CI checks this list from P3-01
on.

## Selected sources

Evaluated in the P0-07 spike ([docs/spikes/assets.md](docs/spikes/assets.md), [ADR 0004](docs/adr/0004-assets.md))
and P3-01 ([ADR 0005](docs/adr/0005-interim-character.md)). `npm run assets:fetch` downloads them into `assets-src/`
(git-ignored, checked against a pinned SHA-256); `npm run assets:build` writes the committed files below.

| Asset | Source URL | Author | License | Used for | Committed files |
| --- | --- | --- | --- | --- | --- |
| Universal Animation Library [Standard] | https://opengameart.org/content/universal-animation-library · https://quaternius.com/packs/universalanimationlibrary.html | Quaternius | CC0 1.0 | Character animation clips | — |
| Universal Base Characters [Standard] | https://quaternius.itch.io/universal-base-characters | Quaternius | CC0 1.0 | Character bodies and hair | — |
| Furniture Kit 2.0 | https://kenney.nl/assets/furniture-kit | Kenney (www.kenney.nl) | CC0 1.0 | Furniture for all themes | — |
| RobotExpressive | https://github.com/mrdoob/three.js/tree/r180/examples/models/gltf/RobotExpressive (license in its README.md) | Tomás Laulhé (Quaternius); modifications by Don McCurdy | CC0 1.0 | Default rigged character (ADR 0005) | `client/public/assets/characters/robot.glb` |

## Committed files

| Path | Asset | License |
| --- | --- | --- |
| `client/public/assets/characters/robot.glb` | RobotExpressive, processed by `scripts/assets/` (merged to one mesh and material, finger bones and face morphs removed, meshopt) | CC0 1.0 |
