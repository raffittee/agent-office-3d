// Bundles the server (TypeScript) into a single ESM file in dist/server.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Only devDependencies exist (the server has no runtime dependencies), and `vite` is imported in --dev only.
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
