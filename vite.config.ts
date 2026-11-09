import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Cross-origin isolation headers.
 *
 * The bundled engine is `stockfish-19-lite-single` (single-threaded) which does
 * NOT require SharedArrayBuffer, so these headers are optional. They are kept
 * here so you can drop in the multi-threaded build (`stockfish-19-lite.js`)
 * and call `setoption name Threads value N` without touching anything else.
 * If you deploy the multi-threaded build, your static host MUST send them too.
 */
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/** Make sure `.wasm` is always served with the correct MIME type (needed for streaming compile). */
const wasmMime = (): Plugin => ({
  name: 'wasm-mime',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0].endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0].endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
      next();
    });
  },
});

export default defineConfig({
  // Relative base => the `dist/` folder can be opened from any sub-path / static host.
  base: './',
  plugins: [react(), tailwindcss(), wasmMime()],
  worker: {
    // `src/workers/stockfish.worker.ts` is bundled as an ES module worker.
    format: 'es',
  },
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  build: {
    target: 'es2022',
    // Engine files live in public/stockfish and are copied verbatim, never inlined.
    assetsInlineLimit: 0,
  },
});
