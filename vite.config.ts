import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEV_INDEX_HTML = `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="./pieces/wN.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="Cờ vua đối đầu Stockfish WebAssembly - chạy offline 100%" />
    <title>Cờ Vua vs Stockfish</title>
  </head>
  <body class="bg-slate-100 text-slate-900">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

/**
 * Ensures `index.html` has the dev entry before `vite` / `vite build` runs,
 * and copies `dist/*` back to the project root after `vite build` so GitHub Pages
 * (serving from the branch root `/`) works out of the box.
 */
const ghPagesRootSync = (): Plugin => ({
  name: 'gh-pages-root-sync',
  config() {
    const indexPath = resolve(__dirname, 'index.html');
    if (existsSync(indexPath) && !readFileSync(indexPath, 'utf8').includes('/src/main.tsx')) {
      writeFileSync(indexPath, DEV_INDEX_HTML, 'utf8');
    }
  },
  closeBundle() {
    const distDir = resolve(__dirname, 'dist');
    if (existsSync(distDir)) {
      cpSync(distDir, resolve(__dirname), { recursive: true, force: true });
    }
  },
});

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
  plugins: [ghPagesRootSync(), react(), tailwindcss(), wasmMime()],
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
