import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import rendererPlugin from 'vite-plugin-electron-renderer';
import path from 'node:path';

// Krypto Bot renders one BrowserWindow (the main UI). The main process
// owns the engine: the Solana WebSocket feed, decoders, risk checks,
// scoring, the paper-trade position manager and the event recorder.
// `ws` and `discord-rpc` stay external so Rollup never tries to inline
// their optional native accelerators (bufferutil / utf-8-validate).
//
// ─── Why the main-process chunks are NOT content-hashed ───────────────
//
// Rollup's default `[name]-[hash].js` exists to bust HTTP caches. Nothing
// serves the main process over HTTP — Electron loads it off disk — so the
// hash bought nothing and cost a great deal: every rebuild wrote a NEW set
// of filenames beside the old ones, and vite does not clean this directory
// between watch rebuilds. Measured 2026-08-25: dist-electron had grown to
// 857 MB across 2,007 files, and electron-builder faithfully packed all of
// it, producing a 232 MB installer of which ~95% was dead builds.
//
// Stable names make a rebuild overwrite its predecessor, which is the
// behaviour that was wanted all along.

const stableNames = {
  entryFileNames: '[name].js',
  chunkFileNames: '[name].js',
  assetFileNames: '[name][extname]',
};

export default defineConfig(({ mode }) => {
  // Maps are worth their weight while developing and are pure bloat (and a
  // source leak) in a shipped build.
  const sourcemap = mode !== 'production';

  return {
    plugins: [
      react(),
      electron([
        {
          entry: 'electron/main.ts',
          vite: {
            resolve: { alias: { '@shared': path.resolve(__dirname, 'shared') } },
            build: {
              outDir: 'dist-electron',
              sourcemap,
              rollupOptions: {
                external: ['ws', 'discord-rpc', 'bufferutil', 'utf-8-validate', 'undici'],
                output: stableNames,
              },
            },
          },
        },
        {
          entry: 'electron/preload.ts',
          onstart(options) {
            options.reload();
          },
          vite: {
            resolve: { alias: { '@shared': path.resolve(__dirname, 'shared') } },
            build: {
              outDir: 'dist-electron',
              sourcemap,
              rollupOptions: { output: stableNames },
            },
          },
        },
      ]),
      rendererPlugin(),
    ],
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'shared'),
      },
    },
    // RENDERER build only — the two electron entries above carry their own
    // `vite.build` and are built with `configFile: false`, so nothing here
    // reaches them. The heavy libraries get their own chunks so the entry
    // bundle (once 1.4 MB, everything in one file) stops carrying three.js
    // for the Observatory through Discover's first paint; with the routes
    // lazy-loaded in App.tsx each lands only when its page is opened.
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            three: ['three'],
            motion: ['framer-motion'],
            charts: ['lightweight-charts'],
          },
        },
      },
    },
    server: {
      port: 5273,
      strictPort: true,
      watch: {
        // NEVER watch build output. electron-builder writes locked .tmp files
        // into release/ during `npm run dist`, and vite's watcher crashes the
        // whole dev server with EBUSY when it tries to watch one. The renderer
        // HMR only cares about src/ and public/ anyway; these dirs are pure
        // output.
        ignored: ['**/release/**', '**/dist/**', '**/dist-electron/**', '**/node_modules/**'],
      },
    },
    clearScreen: false,
  };
});
