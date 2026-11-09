/* =============================================================================
 * useStockfish
 * -----------------------------------------------------------------------------
 * React bridge to `stockfish.worker.ts`.
 *
 *  - Spawns the worker once, performs the UCI handshake (uci → uciok,
 *    isready → readyok) and exposes the engine phase.
 *  - `search()` returns a Promise<UciBestMove | null>. It resolves with `null`
 *    if the search was superseded / stopped (Undo, New Game, side switch…).
 *  - Parses the raw UCI text stream (`info depth … score … nodes … nps … pv …`,
 *    `bestmove …`) into typed objects and normalises the score to WHITE's
 *    perspective for the evaluation bar.
 *  - Debounces search requests (useful for analysis while the user clicks
 *    Undo repeatedly) and throttles React state updates: Stockfish can emit
 *    hundreds of `info` lines per second, we commit at most ~12 per second.
 *
 * Race-condition guards (defence in depth):
 *  1. Worker: drains the stale `bestmove` after `stop` before the next `go`.
 *  2. Hook  : every message carries the search id; anything ≠ active id is dropped.
 *  3. Caller: verifies the position (FEN) is unchanged before applying a move.
 * ========================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  EngineEvaluation,
  EngineIdentity,
  EnginePhase,
  SearchPurpose,
  UciBestMove,
  UciInfo,
  UciScore,
  WorkerInbound,
  WorkerOutbound,
} from '../types/chess';

/* ============================================================ UCI parser */

const INT_FIELDS = new Set(['depth', 'seldepth', 'multipv', 'nodes', 'nps', 'time', 'hashfull']);

/** Parse a raw `info ...` line. Returns `null` for non-info lines / `info string`. */
export function parseInfoLine(line: string): UciInfo | null {
  if (!line.startsWith('info ') || line.startsWith('info string')) return null;
  const t = line.split(/\s+/);
  const info: UciInfo = {};

  for (let i = 1; i < t.length; i++) {
    const key = t[i];
    if (INT_FIELDS.has(key)) {
      const n = Number.parseInt(t[++i], 10);
      if (Number.isFinite(n)) (info as Record<string, number>)[key] = n;
    } else if (key === 'score') {
      const kind = t[++i];
      const value = Number.parseInt(t[++i], 10);
      if ((kind === 'cp' || kind === 'mate') && Number.isFinite(value)) {
        info.score = { kind, value };
      }
      const maybeBound = t[i + 1];
      if (maybeBound === 'lowerbound' || maybeBound === 'upperbound') {
        info.bound = maybeBound;
        i++;
      }
    } else if (key === 'pv') {
      info.pv = t.slice(i + 1).filter(Boolean);
      break; // pv is always the last field
    } else if (key === 'currmove' || key === 'currmovenumber' || key === 'tbhits' || key === 'cpuload' || key === 'wdl') {
      // skip value(s) we don't display
      i += key === 'wdl' ? 3 : 1;
    }
  }
  return info;
}

/** Parse `bestmove e2e4 [ponder e7e5]`. */
export function parseBestMoveLine(line: string): UciBestMove | null {
  if (!line.startsWith('bestmove')) return null;
  const t = line.split(/\s+/);
  const move = t[1];
  const result: UciBestMove = {
    bestmove: !move || move === '(none)' || move === '0000' ? null : move,
  };
  const p = t.indexOf('ponder');
  if (p > 0 && t[p + 1]) result.ponder = t[p + 1];
  return result;
}

/** UCI scores are relative to the side to move; convert to White's perspective. */
export function toWhitePerspective(score: UciScore, fen: string): UciScore {
  const blackToMove = fen.split(' ')[1] === 'b';
  return blackToMove ? { kind: score.kind, value: -score.value } : score;
}

/* ================================================================= Hook */

export interface SearchOptions {
  fen: string;
  moves?: string[];
  depth: number;
  purpose: SearchPurpose;
  /** Delay before the command reaches the engine; re-requests inside the window replace it. */
  debounceMs?: number;
}

interface ActiveSearch {
  id: number;
  fen: string;
  purpose: SearchPurpose;
  resolve: (r: UciBestMove | null) => void;
}

export interface UseStockfish {
  phase: EnginePhase;
  isReady: boolean;
  engine: EngineIdentity | null;
  error: string | null;
  /** Latest evaluation (White perspective). */
  evaluation: EngineEvaluation | null;
  /** Purpose of the search currently running, or `null`. */
  thinking: SearchPurpose | null;
  /** Last N raw UCI lines (only when `debug` is enabled). */
  logs: string[];
  search: (opts: SearchOptions) => Promise<UciBestMove | null>;
  stop: () => void;
  newGame: () => void;
  setOption: (name: string, value: string | number | boolean) => void;
}

const UI_THROTTLE_MS = 80;
const MAX_LOG_LINES = 150;

export function useStockfish(options: { debug?: boolean } = {}): UseStockfish {
  const debug = options.debug ?? false;

  const [phase, setPhase] = useState<EnginePhase>('loading');
  const [engine, setEngine] = useState<EngineIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<EngineEvaluation | null>(null);
  const [thinking, setThinking] = useState<SearchPurpose | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const workerRef = useRef<Worker | null>(null);
  const nextIdRef = useRef(0);
  const activeRef = useRef<ActiveSearch | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Throttled commits
  const pendingEvalRef = useRef<EngineEvaluation | null>(null);
  const logBufferRef = useRef<string[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    flushTimerRef.current = null;
    if (pendingEvalRef.current) {
      setEvaluation(pendingEvalRef.current);
      pendingEvalRef.current = null;
    }
    if (logBufferRef.current.length) {
      const chunk = logBufferRef.current;
      logBufferRef.current = [];
      setLogs((prev) => [...prev, ...chunk].slice(-MAX_LOG_LINES));
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current === null) flushTimerRef.current = setTimeout(flush, UI_THROTTLE_MS);
  }, [flush]);

  const post = useCallback((msg: WorkerInbound) => {
    workerRef.current?.postMessage(msg);
  }, []);

  /** Resolve the active search with `null` (superseded) and forget it. */
  const cancelActive = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const active = activeRef.current;
    activeRef.current = null;
    pendingEvalRef.current = null; // drop un-committed info of the cancelled search
    if (active) active.resolve(null);
    setThinking(null);
  }, []);

  /* --------------------------------------------------- worker lifecycle */
  useEffect(() => {
    const worker = new Worker(new URL('../workers/stockfish.worker.ts', import.meta.url), {
      type: 'module',
      name: 'stockfish-uci',
    });
    workerRef.current = worker;

    worker.onmessage = (ev: MessageEvent<WorkerOutbound>) => {
      const msg = ev.data;
      switch (msg.type) {
        case 'status':
          setPhase(msg.phase);
          break;

        case 'ready':
          setEngine(msg.engine);
          setError(null);
          break;

        case 'error':
          setError(msg.message);
          setPhase('error');
          cancelActive();
          break;

        case 'log':
          logBufferRef.current.push(`${msg.direction === 'out' ? '→' : '←'} ${msg.line}`);
          scheduleFlush();
          break;

        case 'info': {
          const active = activeRef.current;
          if (!active || active.id !== msg.id) return; // stale → ignore
          const info = parseInfoLine(msg.line);
          // Only principal variation with a real score & depth is useful for the panel.
          if (!info || !info.score || info.depth === undefined || (info.multipv ?? 1) !== 1) return;
          if (info.bound) return; // aspiration-window fail high/low: not an exact score
          const pv = info.pv ?? [];
          pendingEvalRef.current = {
            score: toWhitePerspective(info.score, msg.fen),
            depth: info.depth,
            seldepth: info.seldepth,
            nodes: info.nodes ?? 0,
            nps: info.nps ?? 0,
            timeMs: info.time ?? 0,
            pv,
            bestMove: pv[0] ?? null,
            fen: msg.fen,
          };
          scheduleFlush();
          break;
        }

        case 'bestmove': {
          const active = activeRef.current;
          if (!active || active.id !== msg.id) return; // stale → ignore
          const result = parseBestMoveLine(msg.line);
          activeRef.current = null;
          setThinking(null);
          flush(); // commit the final depth immediately
          active.resolve(result);
          break;
        }
      }
    };

    worker.onerror = (ev) => {
      setError(`Worker lỗi: ${ev.message}`);
      setPhase('error');
    };

    const engineUrl = new URL(`${import.meta.env.BASE_URL}stockfish/stockfish.js`, document.baseURI).href;
    worker.postMessage({ type: 'init', engineUrl, debug } satisfies WorkerInbound);

    return () => {
      cancelActive();
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
      worker.postMessage({ type: 'quit' } satisfies WorkerInbound);
      worker.terminate();
      workerRef.current = null;
      setPhase('loading');
      setEngine(null);
    };
  }, [debug, cancelActive, flush, scheduleFlush]);

  /* ---------------------------------------------------------- commands */

  const search = useCallback(
    ({ fen, moves, depth, purpose, debounceMs = 0 }: SearchOptions): Promise<UciBestMove | null> => {
      cancelActive(); // previous promise resolves with null

      return new Promise<UciBestMove | null>((resolve) => {
        const id = ++nextIdRef.current;
        activeRef.current = { id, fen, purpose, resolve };
        setThinking(purpose);

        const dispatch = () => {
          debounceRef.current = null;
          if (activeRef.current?.id !== id) return;
          post({ type: 'search', request: { id, fen, moves, depth, purpose } });
        };

        if (debounceMs > 0) {
          // Abort whatever is running right away to free the CPU during the debounce window.
          post({ type: 'stop' });
          debounceRef.current = setTimeout(dispatch, debounceMs);
        } else {
          dispatch();
        }
      });
    },
    [cancelActive, post],
  );

  const stop = useCallback(() => {
    cancelActive();
    post({ type: 'stop' });
  }, [cancelActive, post]);

  const newGame = useCallback(() => {
    cancelActive();
    setEvaluation(null);
    post({ type: 'newgame' });
  }, [cancelActive, post]);

  const setOption = useCallback(
    (name: string, value: string | number | boolean) => post({ type: 'setoption', name, value }),
    [post],
  );

  return {
    phase,
    isReady: engine !== null && phase !== 'error' && phase !== 'loading' && phase !== 'handshake',
    engine,
    error,
    evaluation,
    thinking,
    logs,
    search,
    stop,
    newGame,
    setOption,
  };
}
