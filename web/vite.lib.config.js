/* Library build — produces the publishable @airesq/floodtwin-react package.
 *
 * Differs from the app build (vite.config.js) in four ways that matter:
 *
 *  1. PRESERVED MODULES. The console's cold-load story depends on every heavy
 *     feature being a lazy import() — the 600 KB renderer, the 2.4 MB drainage
 *     network, the asset index. Bundling to a single file would make a partner
 *     download all of it to show a map. preserveModules keeps each dynamic
 *     import a real split point that THEIR bundler can then code-split too.
 *
 *  2. REACT IS EXTERNAL. Two copies of React in one page throws
 *     "invalid hook call". react/react-dom/jsx-runtime are peer deps.
 *
 *  3. SCOPED CSS. Every rule is nested under .ft-root — see build/postcss-scope.js.
 *
 *  4. NO three.js CHUNK SPLIT. The app splits it to keep the landing page light;
 *     here it rides along with the engine modules that import it, so the
 *     partner's bundler decides.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import postcssScope from './build/postcss-scope.js';

export default defineConfig({
  plugins: [react()],
  css: {
    postcss: { plugins: [postcssScope({ root: '.ft-root' })] },
  },
  build: {
    outDir: resolve(__dirname, 'packages/floodtwin-react/dist'),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,          // a library ships readable; the app bundler minifies
    lib: {
      entry: resolve(__dirname, 'src/lib/index.js'),
      formats: ['es'],
    },
    rollupOptions: {
      // React as peer deps (two copies in a page throws "invalid hook call");
      // three and zustand as real dependencies, so npm resolves ONE copy rather
      // than us shipping a second 1 MB three.module.js inside dist/.
      external: [
        'react', 'react-dom', 'react/jsx-runtime', 'react-dom/client',
        'three', 'zustand', 'zustand/vanilla',
      ],
      output: {
        preserveModules: true,
        preserveModulesRoot: resolve(__dirname, 'src'),
        entryFileNames: '[name].js',
        // One stylesheet, one predictable name for partners to import.
        assetFileNames: (info) => (
          (info.names?.[0] || info.name || '').endsWith('.css')
            ? 'floodtwin.css'
            : 'assets/[name][extname]'
        ),
      },
    },
  },
});
