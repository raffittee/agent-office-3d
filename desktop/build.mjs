// Bundles the Electron main process and the preload into dist/ (CommonJS: the preload runs sandboxed and the main
// process loads it with require).
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
for (const name of ['main', 'preload']) {
  await build({
    entryPoints: [join(root, 'src', `${name}.ts`)],
    outfile: join(root, 'dist', `${name}.cjs`),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
  });
}
