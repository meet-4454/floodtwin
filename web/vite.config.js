import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Everything the browser needs beyond the bundle is served by Flask (:9121):
// the heavy simulation binaries, the drainage GeoJSON, and every /api/* proxy
// that holds a server-side key. In dev we proxy those through Vite so the app
// runs on one origin; in prod Flask serves the built bundle itself.
const FLASK = process.env.FLOODTWIN_API || 'http://127.0.0.1:9121';
const proxied = [
  '/api', '/sim', '/live', '/drainage', '/chunks', '/dem_tiles',
  '/coordinates.bin', '/polygon_index.json', '/wards_gurugram.geojson',
  '/prediction.geojson', '/assets', '/healthz',
];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      proxied.map((p) => [p, { target: FLASK, changeOrigin: true }])
    ),
  },
  build: {
    // Flask serves this directory as the app bundle.
    outDir: resolve(__dirname, '../static/dist'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // three.js is ~600 KB and is only needed once the console mounts — keep
        // it out of the landing page's critical path.
        manualChunks: {
          three: ['three'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
