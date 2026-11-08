// Builds the release package (the thing the `release` branch pipeline publishes). Run after `npm run build`:
//
//   npm run package                 # release/agent-office-<version>/ plus release/RELEASE_NOTES.md
//   npm run package -- --out <dir>
//
// The package is plain JavaScript (the server has no runtime dependencies), so one package serves Windows, Linux and
// macOS. It holds only what runs: the built server and client, the hook shims, the two installers bundled with
// esbuild (so they run without tsx), the messages plugin, the license files and the packaging templates. Archiving
// (.zip, .tar.gz) and checksums are the pipeline's job (.github/workflows/release.yml).
import { build, type Plugin } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What goes into the package, relative to the repository root. Anything not listed stays out. */
export const COPY: { from: string; to?: string; skip?: (rel: string) => boolean }[] = [
  { from: 'dist/server', skip: (rel) => rel.endsWith('.map') },
  { from: 'dist/client' },
  { from: 'hooks', skip: (rel) => /\.test\.[cm]?[jt]s$/.test(rel) },
  { from: 'plugins', skip: (rel) => rel.split('/').includes('tests') },
  { from: '.claude-plugin' },
  { from: 'docs/interactive.md' },
  { from: 'docs/security.md' },
  { from: 'LICENSE' },
  { from: 'NOTICE.md' },
  { from: 'ASSETS.md' },
  { from: 'CHANGELOG.md' },
  { from: 'packaging/README.md', to: 'README.md' },
  { from: 'packaging/install.sh', to: 'install.sh' },
  { from: 'packaging/install.ps1', to: 'install.ps1' },
  { from: 'packaging/bin/agent-office.mjs', to: 'bin/agent-office.mjs' },
];

/** Installers bundled into scripts/<name>.mjs. `usage-install` imports `hooks-install`, which stays a separate file. */
export const INSTALLERS = ['hooks-install', 'usage-install'] as const;

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function isVersion(v: string): boolean {
  return SEMVER.test(v);
}

export function packageName(version: string): string {
  return `agent-office-${version}`;
}

export function releaseTag(version: string): string {
  return `v${version}`;
}

/** 0.2.0-rc.1 and the like are published as pre-releases. */
export function isPrerelease(version: string): boolean {
  return version.includes('-');
}

/** The package's own package.json: just what the server and the CLI read (name, version) and `engines`. */
export function packageManifest(source: { description?: unknown; license?: unknown; engines?: unknown }, version: string): string {
  const manifest = {
    name: 'agent-office',
    version,
    description: source.description,
    license: source.license,
    type: 'module',
    engines: source.engines,
    bin: { 'agent-office': 'bin/agent-office.mjs' },
    scripts: { start: 'node bin/agent-office.mjs start' },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The body of CHANGELOG.md's "## <version> …" section, without its heading; null if there is none. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const head = new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?(?:\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body || null;
}

/** The GitHub release text: the changelog section, then how to install. */
export function releaseNotes(version: string, section: string): string {
  const name = packageName(version);
  return `${section}

## Install

You need Node.js 22.12 or newer. Download the package for your system, unpack it and run the installer:

- **Windows:** \`${name}.zip\`, then \`powershell -ExecutionPolicy Bypass -File .\\install.ps1\`
- **Linux and macOS:** \`${name}.tar.gz\`, then \`./install.sh\`

\`SHA256SUMS\` lists the checksums. Details are in the package's README.md.
`;
}

/** Installer imports of ./hooks-install stay a runtime import of the sibling bundle (see INSTALLERS). */
const siblingInstaller: Plugin = {
  name: 'sibling-installer',
  setup(b) {
    b.onResolve({ filter: /^\.\/hooks-install$/ }, () => ({ path: './hooks-install.mjs', external: true }));
  },
};

function fail(message: string): never {
  console.error(`package: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const outDir = resolve(ROOT, outIndex >= 0 ? (argv[outIndex + 1] ?? fail('--out needs a folder')) : 'release');

  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; description?: unknown; license?: unknown; engines?: unknown };
  const version = rootPkg.version;
  if (!isVersion(version)) fail(`package.json version "${version}" is not a version like 1.2.3`);
  const pluginVersion = (JSON.parse(readFileSync(join(ROOT, 'plugins/agent-office-messages/.claude-plugin/plugin.json'), 'utf8')) as { version?: string }).version;
  if (pluginVersion !== version) fail(`the plugin manifest says ${pluginVersion} but package.json says ${version}: run npm run release -- ${version}`);
  const section = changelogSection(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
  if (!section) fail(`CHANGELOG.md has no "## ${version}" section: write the release notes first`);
  for (const built of ['dist/server/index.js', 'dist/client/index.html']) {
    if (!existsSync(join(ROOT, built))) fail(`${built} is missing: run npm run build first`);
  }

  const stage = join(outDir, packageName(version));
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  for (const item of COPY) {
    const from = join(ROOT, item.from);
    if (!existsSync(from)) fail(`${item.from} is missing`);
    cpSync(from, join(stage, item.to ?? item.from), {
      recursive: true,
      filter: (src) => !item.skip?.(src.slice(from.length + 1).split(sep).join('/')),
    });
  }
  writeFileSync(join(stage, 'package.json'), packageManifest(rootPkg, version));
  for (const name of INSTALLERS) {
    await build({
      entryPoints: [join(ROOT, 'scripts', `${name}.ts`)],
      outfile: join(stage, 'scripts', `${name}.mjs`),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      plugins: name === 'usage-install' ? [siblingInstaller] : [],
      logLevel: 'warning',
    });
  }
  for (const exe of ['bin/agent-office.mjs', 'install.sh']) chmodSync(join(stage, exe), 0o755);
  writeFileSync(join(outDir, 'RELEASE_NOTES.md'), releaseNotes(version, section));

  console.log(`✓ ${packageName(version)} staged in ${stage}`);
  console.log(`  release notes: ${join(outDir, 'RELEASE_NOTES.md')}`);
}

if (process.argv[1] && /package\.ts$/.test(process.argv[1])) void main();
