/* =============================================================================
 * stockfish.worker.ts
 * -----------------------------------------------------------------------------
 * Dedicated module Worker that owns the Stockfish WASM engine life-cycle and
 * pipes UCI commands. The React main thread NEVER talks to the engine directly
 * and never executes any engine code, so the UI stays at 60 fps even while
 * Stockfish searches at depth 20.
 *
 *   React UI ──postMessage(WorkerInbound)──▶ this Worker ──UCI text──▶ Stockfish
 *   React UI ◀──postMessage(WorkerOutbound)── this Worker ◀──UCI text── Stockfish
 *
 * The Stockfish build (`stockfish-19-lite-single.js` + `.wasm`, copied into
 * `public/stockfish/`) is itself an Emscripten worker script that speaks UCI
 * over postMessage. We spawn it as a *nested* worker from here, which keeps the
 * engine fully off the main thread and lets this file be a plain, typed,
 * bundle-friendly ES module.
 *
 * RACE-CONDITION STRATEGY (the important part)
 * --------------------------------------------
 * UCI guarantees exactly ONE `bestmove` per `go`, even when the search is
 * aborted with `stop`. If we started a new search right after `stop`, the
 * stale `bestmove` of the old search would arrive *after* the new `go` and be
 * mistaken for the new result (classic bug: AI plays a move from a position
 * that no longer exists after Undo / New Game).
 *
 * This worker therefore runs an explicit state machine:
 *
 *   loading → handshake (uci/uciok, isready/readyok) → idle
 *   idle --search--> searching --bestmove--> idle
 *   searching --new search / stop / newgame--> stopping
 *   stopping --(stale) bestmove: DROPPED--> idle
 *   idle --newgame / setoption--> syncing (ucinewgame + isready) --readyok--> idle
 *
 * Only ONE search is ever "pending" (latest request wins). Every forwarded
 * `info` / `bestmove` is tagged with the UI-generated search id, so the UI can
 * apply a second, independent guard.
 * ========================================================================== */

import type {
  EngineIdentity,
  EnginePhase,
  SearchRequest,
  WorkerInbound,
  WorkerOutbound,
} from '../types/chess';

/**
 * Minimal typing of the dedicated worker global scope. (Including both the
 * "DOM" and "WebWorker" libs in one tsconfig produces duplicate declarations,
 * so we describe just what this file uses.)
 */
declare const self: {
  postMessage(message: WorkerOutbound): void;
  onmessage: ((ev: MessageEvent<WorkerInbound>) => void) | null;
  close(): void;
};

const HANDSHAKE_TIMEOUT_MS = 30_000;

let engine: Worker | null = null;
let phase: EnginePhase = 'loading';
let debug = false;

/** Search currently running inside Stockfish (or being stopped). */
let current: SearchRequest | null = null;
/** Next search to start once the engine is idle. Latest request wins. */
let pending: SearchRequest | null = null;
/** `ucinewgame` requested, will be sent as soon as the engine is idle. */
let newGamePending = false;
/** `setoption` commands are only legal while the engine is not searching. */
const optionQueue: string[] = [];

let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
const identity: EngineIdentity = { name: 'Stockfish', author: '' };

/* ------------------------------------------------------------- helpers */

function post(msg: WorkerOutbound): void {
  self.postMessage(msg);
}

function setPhase(next: EnginePhase): void {
  if (phase === next) return;
  phase = next;
  post({ type: 'status', phase });
}

function send(command: string): void {
  if (!engine) return;
  if (debug) post({ type: 'log', direction: 'out', line: command });
  engine.postMessage(command);
}

function fail(message: string): void {
  if (handshakeTimer) clearTimeout(handshakeTimer);
  handshakeTimer = null;
  current = null;
  pending = null;
  setPhase('error');
  post({ type: 'error', message });
}

/**
 * Drive the state machine forward whenever the engine becomes idle.
 * Priority: options/newgame sync first, then the pending search.
 */
function pump(): void {
  if (phase !== 'idle' || !engine) return;

  if (newGamePending || optionQueue.length > 0) {
    while (optionQueue.length > 0) send(optionQueue.shift()!);
    if (newGamePending) {
      newGamePending = false;
      send('ucinewgame');
    }
    // `isready` is the UCI barrier: `readyok` means every previous command was processed.
    send('isready');
    setPhase('syncing');
    return;
  }

  if (pending) {
    current = pending;
    pending = null;
    if (current.moves && current.moves.length > 0) {
      send(`position startpos moves ${current.moves.join(' ')}`);
    } else {
      send(`position fen ${current.fen}`);
    }
    send(`go depth ${current.depth}`);
    setPhase('searching');
  }
}

/** Ask the engine to abort the running search. Its `bestmove` will be drained. */
function abortCurrent(): void {
  if (phase === 'searching') {
    send('stop');
    setPhase('stopping');
  }
  // In 'stopping' we are already waiting for the drain; nothing else to do.
}

/* ------------------------------------------------------ engine output */

function handleEngineLine(line: string): void {
  if (!line) return;
  if (debug) post({ type: 'log', direction: 'in', line });

  // --- Handshake -------------------------------------------------------
  if (line.startsWith('id name ')) {
    identity.name = line.slice(8).trim();
    return;
  }
  if (line.startsWith('id author ')) {
    identity.author = line.slice(10).trim();
    return;
  }
  if (line === 'uciok') {
    if (phase === 'handshake') send('isready');
    return;
  }
  if (line === 'readyok') {
    if (phase === 'handshake') {
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeTimer = null;
      setPhase('idle');
      post({ type: 'ready', engine: { ...identity } });
      pump();
    } else if (phase === 'syncing') {
      setPhase('idle');
      pump();
    }
    return;
  }

  // --- Search output ---------------------------------------------------
  if (line.startsWith('info ')) {
    // Only the active (non-aborted) search may reach the UI.
    if (phase === 'searching' && current && !line.startsWith('info string')) {
      post({ type: 'info', id: current.id, fen: current.fen, line });
    }
    return;
  }

  if (line.startsWith('bestmove')) {
    const finished = current;
    current = null;

    if (phase === 'searching' && finished) {
      post({ type: 'bestmove', id: finished.id, fen: finished.fen, purpose: finished.purpose, line });
    }
    // phase === 'stopping' → stale result of an aborted search: silently DROPPED.

    if (phase === 'searching' || phase === 'stopping') {
      setPhase('idle');
      pump();
    }
  }
}

/* ----------------------------------------------------------- lifecycle */

function init(engineUrl: string): void {
  if (engine) return; // idempotent (React StrictMode may double-invoke effects)

  if (typeof Worker === 'undefined') {
    fail('Trình duyệt không hỗ trợ nested Web Worker (cần Chrome 69+, Firefox 44+, Safari 15.5+).');
    return;
  }

  setPhase('loading');
  try {
    // Classic worker: the Emscripten glue resolves `stockfish.wasm` next to `stockfish.js`.
    engine = new Worker(engineUrl);
  } catch (err) {
    fail(`Không thể khởi tạo Stockfish: ${(err as Error).message}`);
    return;
  }

  engine.onmessage = (ev: MessageEvent<unknown>) => {
    // The engine posts plain strings; ignore anything else (e.g. download progress objects).
    if (typeof ev.data !== 'string') return;
    // Defensive: a single message may contain several lines.
    for (const raw of ev.data.split('\n')) handleEngineLine(raw.trim());
  };

  engine.onerror = (ev: ErrorEvent) => {
    ev.preventDefault();
    fail(`Stockfish gặp lỗi: ${ev.message || 'không tải được stockfish.js / stockfish.wasm'}`);
  };

  handshakeTimer = setTimeout(() => {
    if (phase === 'loading' || phase === 'handshake') {
      fail('Hết thời gian chờ Stockfish phản hồi "uciok/readyok". Kiểm tra public/stockfish/.');
    }
  }, HANDSHAKE_TIMEOUT_MS);

  // Commands posted before the wasm is compiled are queued by the Emscripten glue.
  setPhase('handshake');
  send('uci');
}

function quit(): void {
  if (handshakeTimer) clearTimeout(handshakeTimer);
  if (engine) {
    send('quit');
    engine.terminate();
    engine = null;
  }
  self.close();
}

/* ------------------------------------------------------- UI messages */

self.onmessage = (ev: MessageEvent<WorkerInbound>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      debug = !!msg.debug;
      init(msg.engineUrl);
      break;

    case 'search':
      if (phase === 'error') return;
      pending = msg.request; // latest wins: any older pending request is discarded
      if (phase === 'searching') abortCurrent();
      else pump(); // no-op unless idle; other phases call pump() when they settle
      break;

    case 'stop':
      pending = null;
      abortCurrent();
      break;

    case 'newgame':
      pending = null;
      newGamePending = true;
      if (phase === 'searching') abortCurrent();
      else pump();
      break;

    case 'setoption': {
      optionQueue.push(`setoption name ${msg.name} value ${String(msg.value)}`);
      pump();
      break;
    }

    case 'raw':
      send(msg.command);
      break;

    case 'quit':
      quit();
      break;
  }
};

export {};
