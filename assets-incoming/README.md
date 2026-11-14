# assets-incoming

A drop folder for third-party asset files that can't be downloaded from the cloud session (itch.io, kenney.nl and
OpenGameArt aren't reachable there). It exists for the human characters of Phase 10 (P10-01, P10-07..09,
[ADR 0004](../docs/adr/0004-assets.md)).

Nothing here ships. The asset pipeline (`npm run assets:build`) reads from the git-ignored `assets-src/`; files from
here are copied into it first, and what lands in the repo for real is the built, compressed output in
`client/public/assets/characters/`.

## What goes where

| Folder | Put here | From |
| --- | --- | --- |
| `universal-base-characters/` | The `.glb` file(s) of the **Standard (free)** pack, **not** the zip | https://quaternius.itch.io/universal-base-characters |
| `universal-animation-library/` | Optional: the `.glb` of the Standard pack, if `npm run assets:fetch` can't reach OpenGameArt | https://opengameart.org/ (Quaternius, Universal Animation Library) |

## Steps

1. In your browser, open the itch.io page, click **Download Now**, take the free Standard version ($0 works), and
   unzip it.
2. Copy only the `.glb` files (and the license/readme text file that comes with the pack) into the folder above. Keep
   the original file names. Don't add the zip, and don't add Blender, Unity or Unreal files: they're large and unused.
3. Check each file is under 100 MB (GitHub refuses larger files).
4. Commit and push this branch:
   ```bash
   git checkout assets/human-characters
   git add assets-incoming
   git commit -m "Add the Quaternius Universal Base Characters (Standard) glb files"
   git push -u origin assets/human-characters
   ```
5. Tell Claude the files are pushed. It will copy them into `assets-src/`, read the real bone and animation names,
   write the build entry, and build the characters.

## License

Quaternius publishes these packs under CC0 1.0. Check the license text on the download page and keep the pack's own
license file next to the `.glb` files. Every asset that ends up in the repo is also listed in
[ASSETS.md](../ASSETS.md).
