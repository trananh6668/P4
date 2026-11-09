# ♞ Cờ Vua vs Stockfish (WebAssembly · Web Worker · Offline 100%)

React 19 + TypeScript + Tailwind CSS v4 + Vite. AI là **Stockfish 19 Lite (WASM, single-thread)** chạy hoàn toàn trong Web Worker, giao tiếp qua giao thức **UCI**. Luật cờ chuẩn FIDE dùng **chess.js**.

## Chạy nhanh

```bash
npm install        # postinstall tự copy engine WASM + quân cờ SVG vào public/
npm run dev        # http://localhost:5173
npm run build      # dist/ chạy offline 100%
npm run preview    # thử bản build ở http://localhost:4173
```

## Cấu trúc

```
public/
  stockfish/stockfish.js     ← glue Emscripten (stockfish-19-lite-single.js)
  stockfish/stockfish.wasm   ← engine WASM (~1.8 MB)
  pieces/{w,b}{K,Q,R,B,N,P}.svg  ← bộ quân cburnett (Lichess)
scripts/setup-assets.mjs     ← copy/extract tài nguyên tĩnh vào public/
src/
  types/chess.ts             ← kiểu dữ liệu: UCI, eval, game state, giao thức Worker
  workers/stockfish.worker.ts← vòng đời engine + state machine UCI (chống race condition)
  hooks/useStockfish.ts      ← cầu nối React ⇄ Worker, parse UCI, debounce/throttle
  hooks/useChessGame.ts      ← trạng thái ván cờ (chess.js)
  lib/engine.ts              ← cấp độ, công thức thanh đánh giá, format
  components/ChessBoard.tsx  ← bàn cờ (click / kéo-thả, phong cấp, mũi tên gợi ý)
  components/EvalBar.tsx     ← thanh đánh giá
  components/EnginePanel.tsx ← depth / nodes / NPS / best move / PV / log UCI
  components/GameControls.tsx← cấp độ, Đi lại, Ván mới, Đổi bên, biên bản PGN
  App.tsx
```

## Thêm file `.wasm` vào `public/`

Tự động: `npm install` (hoặc `npm run assets`) chạy `scripts/setup-assets.mjs`, copy
`node_modules/stockfish/bin/stockfish-19-lite-single.{js,wasm}` → `public/stockfish/stockfish.{js,wasm}`.

Thủ công: tải 2 file `stockfish-19-lite-single.js` và `stockfish-19-lite-single.wasm` ở
https://github.com/nmrugg/stockfish.js/releases, đổi tên thành `stockfish.js` / `stockfish.wasm`
và đặt chung thư mục `public/stockfish/`. File `.js` tự tìm file `.wasm` **cùng tên, cùng thư mục**.

Mọi thứ trong `public/` được Vite copy nguyên vẹn vào `dist/`, nên bản build chạy offline mà không cần CDN.
Host tĩnh phải trả `Content-Type: application/wasm` cho file `.wasm` (đa số host đã làm sẵn).

## `vite.config.ts`

- `worker.format: 'es'` — worker được bundle dạng ES module (`new Worker(new URL(...), { type: 'module' })`).
- `base: './'` — `dist/` deploy được ở bất kỳ sub-path nào.
- Header **COOP/COEP** cho dev/preview: *không bắt buộc* với bản single-thread, nhưng cần nếu đổi sang
  bản đa luồng `stockfish-19-lite.js` (dùng `SharedArrayBuffer`) — khi đó host production cũng phải gửi:
  `Cross-Origin-Opener-Policy: same-origin` và `Cross-Origin-Embedder-Policy: require-corp`.
- Middleware đảm bảo MIME `application/wasm`.

## Chống race condition (3 lớp)

1. **Worker** – state machine `idle → searching → stopping → idle`. Sau `stop`, UCI luôn trả đúng 1
   `bestmove` "cũ"; worker **chờ và loại bỏ** nó trước khi gửi `position`/`go` mới. Chỉ giữ 1 yêu cầu chờ (mới nhất thắng).
2. **Hook** – mỗi lần tìm kiếm có `id` tăng dần; mọi `info`/`bestmove` khác `id` hiện hành bị bỏ qua, Promise cũ resolve `null`.
3. **App** – trước khi đi nước AI, kiểm tra `gameId` và FEN vẫn trùng với thế cờ đã gửi cho engine.
