# Releasing

A push to the **`release`** branch builds, tests and publishes the version in `package.json` as a GitHub release.
The pipeline is [`.github/workflows/release.yml`](../.github/workflows/release.yml).

## What a release contains

| File | For |
| --- | --- |
| `agent-office-<version>.zip` | Windows (also fine anywhere) |
| `agent-office-<version>.tar.gz` | Linux and macOS |
| `SHA256SUMS` | Checking the downloads |

Both archives hold the same package: the built server and client, the hook shims, the two installers (bundled, so
they run without `tsx`), the Claude Code messages plugin, an `install.sh` / `install.ps1` pair, and the license
files. There are no sources, tests or `node_modules`: the server has no runtime dependencies. The only thing a
machine needs is **Node.js 22.12 or newer**. One package serves every operating system, because it is plain
JavaScript.

## Cutting a release

1. **Pick the version and write the notes.** Add a `## <version> — <date>` section to `CHANGELOG.md`. Its text
   becomes the release notes.
2. **Bump the version everywhere:** `npm run release -- <version>`. It runs the checks, then sets the version in
   `package.json`, `package-lock.json` and the plugin manifest.
3. **Merge to `main`** with a normal pull request.
4. **Publish:** move `release` to `main`:

   ```bash
   git push origin main:release
   ```

   This is a fast-forward as long as nobody committed on `release` directly. Don't: `release` only ever receives
   `main`.
5. Watch **Actions › Release**. When it is green, the release and the tag `v<version>` exist.

A pre-release version (`0.2.0-rc.1`) is published as a GitHub pre-release.

## What the pipeline does

1. **package** (Linux): `npm ci`, typecheck, `theme:check`, tests, build, `npm run package`, then the archives and
   checksums. The archives are reproducible: the same commit gives the same bytes. Before any of that, it fails if
   the tag `v<version>` already exists (you forgot to bump the version).
2. **smoke** (Linux, Windows, macOS): unpacks the **archive** (not the build folder), starts the packaged server in
   demo mode, checks `/api/health`, the page, its script, the snapshot and the Host-header guard, runs the bundled
   hook installers, and runs the package's own installer: install, upgrade, run the installed command, uninstall.
   Normal CI runs the same smoke test on Linux and Windows on every push, so problems show up before release day.
3. **publish** (Linux): only if 1 and 2 passed. It re-verifies the checksums, refuses to overwrite an existing tag,
   and creates the tag on the exact commit that was tested, with the release notes and the three files.

Running **Actions › Release › Run workflow** by hand does steps 1 and 2 only, from any branch, without publishing.
Tick "Publish" (and run it from `release`) to publish.

## If something goes wrong

- **"Tag vX already exists":** bump the version and push again. Never move a published tag.
- **A smoke test fails on one OS:** nothing is published. Fix on `main`, then push `main:release` again. A failed run
  leaves no tag behind.
- **A bad release is out:** delete the GitHub release and its tag (Releases page), fix, bump to the next patch
  version, and release again. Users who installed it upgrade by installing the new one.

## Recommended repository settings

- A ruleset on `release`: allow pushes only from admins or the maintainer, block force pushes and deletion.
- Allow the workflow to create releases: Settings › Actions › General › Workflow permissions can stay on
  *read*, because the publish job asks for `contents: write` itself.

## Installing a release

See the package's own `README.md` (the first thing in the archive), or the project README: unpack, then
`install.ps1` (Windows) or `install.sh` (Linux and macOS). Installing puts the package in a fixed folder, so hooks
and the plugin keep working across upgrades.

## Building the package locally

```bash
npm run build && npm run package          # release/agent-office-<version>/
npm run package:smoke -- release/agent-office-<version> --installer
```

The smoke test runs the installer into a throwaway folder and a throwaway `HOME`: it touches nothing of yours.
