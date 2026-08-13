/* The whole integration, in one file.
 *
 * The proxy runs as Vite dev middleware rather than as a separate Express
 * process, so `npm run dev` is the only command you need and there is no second
 * port to keep straight. In production you would mount the same handler in your
 * real server — the function is identical, see ../express-proxy.mjs.
 *
 * THE KEY IS READ HERE, IN THE NODE PROCESS. Note that it is `process.env`, not
 * `import.meta.env` — anything under `import.meta.env`/`VITE_*` is inlined into
 * the browser bundle, which is exactly what must never happen to this value.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { floodtwinProxy } from '../express-proxy.mjs';

export default defineConfig(() => {
  const key = process.env.FLOODTWIN_API_KEY;
  const upstream = process.env.FLOODTWIN_UPSTREAM;

  if (!key || !upstream) {
    // Fail loudly at startup rather than with a wall of 401s in the browser
    // console once the map tries to load.
    throw new Error(
      '\n\n  Set FLOODTWIN_API_KEY and FLOODTWIN_UPSTREAM before starting.\n\n' +
      '    export FLOODTWIN_API_KEY=ft_live_…\n' +
      '    export FLOODTWIN_UPSTREAM=https://twin.example.com\n' +
      '    npm run dev\n\n' +
      '  Run `node ../preflight.mjs` first to check the key works.\n',
    );
  }

  return {
    plugins: [
      react(),
      {
        name: 'floodtwin-proxy',
        configureServer(server) {
          const handler = floodtwinProxy({ key, upstream });
          // Mounted at /api/floodtwin — the same path the component's `baseUrl`
          // points at in src/App.jsx. Vite strips the mount prefix from req.url,
          // which is what the handler expects.
          server.middlewares.use('/api/floodtwin', handler);
        },
      },
    ],
    // This example installs the package with `file:../..`, which npm satisfies
    // with a SYMLINK into the parent directory rather than a copy. Vite would
    // normally resolve that symlink to its real path — at which point the
    // library's own imports (`zustand`, `three`, `react`) are looked up starting
    // from the package directory, which sits ABOVE this example and so never
    // reaches node_modules here. Keeping the symlinked path makes those resolve
    // against this project, where they are actually installed.
    //
    // Your own app will install the package normally and needs none of this.
    resolve: { preserveSymlinks: true },

    server: { port: 5174, open: true },
  };
});
