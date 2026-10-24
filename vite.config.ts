import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// `npm run dev` loads this config in middleware mode inside the server (one port, HMR included).
// `npm run dev:client` runs Vite alone and proxies /api to a server started separately.
export default defineConfig({
  root: r('./client'),
  publicDir: r('./client/public'),
  build: {
    outDir: r('./dist/client'),
    emptyOutDir: true,
    // Hashed bundles go to /bundle/ (served immutable); /assets/ is reserved for fixed-name public files.
    assetsDir: 'bundle',
    assetsInlineLimit: 0,
    rollupOptions: { input: { main: r('./client/index.html'), preview: r('./client/preview.html') } },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.AGENT_OFFICE_PORT ?? 4848}` },
    },
  },
});
