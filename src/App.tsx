/* =============================================================================
 * App — wires the FIDE game state (chess.js) to the Stockfish Web Worker.
 *
 * Engine driving rules (single effect, keyed on the position):
 *   • AI's turn       → `go depth <level>` (purpose 'play'); result applied only
 *                       if the game id AND the FEN are still unchanged.
 *   • Player's turn   → optional background analysis (debounced) for the eval
 *                       bar, statistics and the best-move hint arrow.
 *   • Game over       → `stop`.
 * Undo / New game / Switch sides send `stop` first so the CPU is released
 * immediately; the worker drains the stale `bestmove` before the next `go`.
 * ========================================================================== */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChessBoard, pieceSrc } from './components/ChessBoard';
import { EnginePanel } from './components/EnginePanel';
import { EvalBar } from './components/EvalBar';
import { GameControls } from './components/GameControls';
import { describeResult, useChessGame, type BoardPiece, type MoveInput } from './hooks/useChessGame';
import { useStockfish } from './hooks/useStockfish';
import { getLevel, MAX_ANALYSIS_DEPTH } from './lib/engine';
import type { Color, LevelId, PieceSymbol } from './types/chess';

/** Minimum perceived "thinking" time so instant low-depth replies don't feel jarring. */
const MIN_THINK_MS = 350;
const ANALYSIS_DEBOUNCE_MS = 250;

const opposite = (c: Color): Color => (c === 'w' ? 'b' : 'w');

/* -------------------------------------------------- material helpers */

const START_COUNT: Record<Exclude<PieceSymbol, 'k'>, number> = { q: 1, r: 2, b: 2, n: 2, p: 8 };
const VALUE: Record<Exclude<PieceSymbol, 'k'>, number> = { q: 9, r: 5, b: 3, n: 3, p: 1 };
const ORDER: Exclude<PieceSymbol, 'k'>[] = ['q', 'r', 'b', 'n', 'p'];

function material(board: (BoardPiece | null)[][]) {
  const count = { w: { q: 0, r: 0, b: 0, n: 0, p: 0 }, b: { q: 0, r: 0, b: 0, n: 0, p: 0 } };
  for (const row of board) for (const p of row) if (p && p.type !== 'k') count[p.color][p.type]++;
  const score = (c: Color) => ORDER.reduce((s, t) => s + count[c][t] * VALUE[t], 0);
  /** Pieces of `victim` color that are no longer on the board. */
  const captured = (victim: Color) =>
    ORDER.flatMap((t) => Array<PieceSymbol>(Math.max(0, START_COUNT[t] - count[victim][t])).fill(t));
  return { diff: score('w') - score('b'), captured };
}

/* ------------------------------------------------------- Player bar */

function PlayerBar({
  name,
  subtitle,
  color,
  capturedPieces,
  advantage,
  active,
  thinking,
  inCheck,
  lastMoveLabel,
}: {
  name: string;
  subtitle: string;
  color: Color;
  capturedPieces: PieceSymbol[];
  advantage: number;
  active: boolean;
  thinking?: boolean;
  inCheck: boolean;
  lastMoveLabel?: string | null;
}) {
  const victim = opposite(color);
  return (
    <div
      className={`flex items-center gap-2.5 rounded-xl border px-3 py-1.5 shadow-sm transition ${
        active ? 'border-emerald-500 bg-white ring-2 ring-emerald-500/20' : 'border-slate-200 bg-white/85'
      }`}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-board-light p-1 shadow-inner">
        <img src={pieceSrc(color, 'k')} alt="" className="chess-piece h-full w-full" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-bold text-slate-900">{name}</span>
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
              color === 'w'
                ? 'border border-slate-300 bg-white text-slate-800'
                : 'border border-slate-900 bg-slate-900 text-white'
            }`}
          >
            {color === 'w' ? 'Quân Trắng' : 'Quân Đen'}
          </span>
          {inCheck && (
            <span className="animate-pulse rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
              Chiếu tướng!
            </span>
          )}
          {thinking && (
            <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-600">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-amber-500 [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-amber-500 [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-amber-500" />
              đang nghĩ
            </span>
          )}
          {lastMoveLabel && !thinking && (
            <span className="ml-auto rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[11px] font-bold text-amber-800">
              {lastMoveLabel}
            </span>
          )}
        </div>
        <div className="flex h-4 items-center">
          <span className="mr-2 truncate text-[11px] text-slate-500">{subtitle}</span>
          <div className="flex items-center -space-x-1">
            {capturedPieces.map((t, i) => (
              <img key={i} src={pieceSrc(victim, t)} alt="" className="chess-piece h-4 w-4" />
            ))}
          </div>
          {advantage > 0 && <span className="ml-1.5 text-[11px] font-bold text-emerald-700">+{advantage}</span>}
        </div>
      </div>
    </div>
  );
}

/* ================================================================ App */

export default function App() {
  const [playerColor, setPlayerColor] = useState<Color>('w');
  const [levelId, setLevelId] = useState<LevelId>(2);
  const [gmDepth, setGmDepth] = useState(18);
  const [showMoveArrow, setShowMoveArrow] = useState(true);
  const [analysisEnabled, setAnalysisEnabled] = useState(true);
  const [showHint, setShowHint] = useState(false);
  const [overlayDismissedFor, setOverlayDismissedFor] = useState<string | null>(null);

  const { state: game, legalMovesFrom, move, applyUciMove, undo, reset, resign } = useChessGame();
  const sf = useStockfish({ debug: true });
  const { search, stop, newGame: engineNewGame, isReady } = sf;

  const level = getLevel(levelId);
  const depth = level.range ? gmDepth : level.depth;
  const analysisDepth = Math.min(Math.max(depth, 12), MAX_ANALYSIS_DEPTH);
  const aiColor = opposite(playerColor);
  const isPlayerTurn = game.turn === playerColor;
  const uciMoves = useMemo(() => game.history.map((m) => m.uci), [game.history]);

  /* ------------------------------------------------ engine driver */
  useEffect(() => {
    if (!isReady) return;
    if (game.result) {
      stop();
      return;
    }

    const fen = game.fen;
    const gameId = game.gameId;

    if (game.turn === aiColor) {
      let cancelled = false;
      let applyTimer: ReturnType<typeof setTimeout> | undefined;
      const startedAt = performance.now();

      search({ fen, moves: uciMoves, depth, purpose: 'play' }).then((res) => {
        // null ⇒ superseded by Undo / New game / side switch / depth change.
        if (cancelled || !res?.bestmove) return;
        const bestmove = res.bestmove;
        const wait = Math.max(0, MIN_THINK_MS - (performance.now() - startedAt));
        applyTimer = setTimeout(() => {
          // Final guard: same game & same position as the one analysed.
          if (!cancelled) applyUciMove(bestmove, fen, gameId);
        }, wait);
      });

      return () => {
        cancelled = true;
        if (applyTimer) clearTimeout(applyTimer);
      };
    }

    if (analysisEnabled || showHint) {
      void search({
        fen,
        moves: uciMoves,
        depth: analysisDepth,
        purpose: 'analysis',
        debounceMs: ANALYSIS_DEBOUNCE_MS,
      });
    } else {
      stop();
    }
  }, [isReady, game.fen, game.gameId, game.turn, game.result, uciMoves, aiColor, depth, analysisDepth, analysisEnabled, showHint, search, stop, applyUciMove]);

  /* ------------------------------------------------------ actions */

  const handlePlayerMove = useCallback(
    (m: MoveInput) => {
      if (game.turn !== playerColor || game.result) return;
      move(m);
    },
    [game.turn, game.result, playerColor, move],
  );

  const canUndo = isPlayerTurn ? game.history.length >= 2 : game.history.length >= 1;

  const handleUndo = useCallback(() => {
    if (!canUndo) return;
    stop(); // free the CPU right now; stale bestmove is drained by the worker
    // Player's turn → take back AI reply + own move. AI's turn → take back own move.
    undo(isPlayerTurn ? 2 : 1);
  }, [canUndo, isPlayerTurn, stop, undo]);

  const handleNewGame = useCallback(() => {
    engineNewGame(); // stop + ucinewgame + isready
    reset();
  }, [engineNewGame, reset]);

  const handleSwitchSides = useCallback(() => {
    stop();
    setPlayerColor((c) => opposite(c));
  }, [stop]);

  const handleResign = useCallback(() => {
    stop();
    resign(playerColor);
  }, [stop, resign, playerColor]);

  /* ---------------------------------------------- keyboard shortcuts */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key.toLowerCase() === 'n') handleNewGame();
        if (e.key.toLowerCase() === 'f') handleSwitchSides();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo, handleNewGame, handleSwitchSides]);

  /* -------------------------------------------------- derived view */

  const { diff, captured } = useMemo(() => material(game.board), [game.board]);
  const evaluation = sf.evaluation;
  const evalIsCurrent = evaluation?.fen === game.fen;

  const hintArrow =
    showHint && isPlayerTurn && !game.result && evalIsCurrent && sf.thinking !== 'play' ? evaluation?.bestMove ?? null : null;

  const forcedPercent = game.result
    ? game.result.reason === 'checkmate' || game.result.reason === 'resign'
      ? game.result.winner === 'w'
        ? 100
        : 0
      : 50
    : null;

  const overlayKey = `${game.gameId}:${game.history.length}`;
  const showOverlay = !!game.result && overlayDismissedFor !== overlayKey;
  const resultText = game.result ? describeResult(game.result) : null;
  const playerWon = game.result?.winner === playerColor;
  const lastRecord = game.history.at(-1) ?? null;

  const aiBar = (
    <PlayerBar
      name={`Stockfish · Cấp ${level.id}`}
      subtitle={`${level.name} · depth ${depth}`}
      color={aiColor}
      capturedPieces={captured(playerColor)}
      advantage={aiColor === 'w' ? diff : -diff}
      active={!game.result && game.turn === aiColor}
      thinking={sf.thinking === 'play'}
      inCheck={game.inCheck && game.turn === aiColor}
      lastMoveLabel={lastRecord?.color === aiColor ? `${lastRecord.from}→${lastRecord.to} (${lastRecord.san})` : null}
    />
  );
  const playerBar = (
    <PlayerBar
      name="Bạn"
      subtitle={isPlayerTurn && !game.result ? 'Đến lượt bạn đi' : 'Đang chờ đối phương'}
      color={playerColor}
      capturedPieces={captured(aiColor)}
      advantage={playerColor === 'w' ? diff : -diff}
      active={!game.result && isPlayerTurn}
      inCheck={game.inCheck && isPlayerTurn}
      lastMoveLabel={lastRecord?.color === playerColor ? `${lastRecord.from}→${lastRecord.to} (${lastRecord.san})` : null}
    />
  );

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white/95 shadow-xs backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 bg-board-light p-1">
              <img src={pieceSrc('w', 'n')} alt="" className="chess-piece h-full w-full" />
            </div>
            <div>
              <h1 className="text-base font-bold leading-tight text-slate-900">Cờ Vua vs Stockfish</h1>
              <p className="text-[11px] text-slate-500">WebAssembly · Web Worker · Giao diện Sáng chuẩn thi đấu</p>
            </div>
          </div>
          <div className="hidden text-right text-[11px] text-slate-500 sm:block">
            <kbd className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">Ctrl+Z</kbd> đi lại ·{' '}
            <kbd className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">N</kbd> ván mới ·{' '}
            <kbd className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">F</kbd> đổi bên
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-3 sm:p-4 lg:flex-row lg:items-start lg:justify-center">
        {/* Board column */}
        <div className="flex w-full flex-col gap-2 lg:w-[min(calc(100vh-190px),740px)] lg:shrink-0">
          {aiBar}
          <div className="flex items-stretch gap-2">
            <div className="w-5 shrink-0 sm:w-7">
              <EvalBar
                score={evaluation?.score ?? null}
                orientation={playerColor}
                forcedPercent={forcedPercent}
                depth={evaluation?.depth}
              />
            </div>
            <div className="min-w-0 flex-1">
              <ChessBoard
                board={game.board}
                fen={game.fen}
                orientation={playerColor}
                playerColor={playerColor}
                interactive={isPlayerTurn && !game.result}
                lastMove={game.lastMove}
                showMoveArrow={showMoveArrow}
                checkSquare={game.checkSquare}
                legalMovesFrom={legalMovesFrom}
                onMove={handlePlayerMove}
                arrow={hintArrow}
              >
                {showOverlay && resultText && (
                  <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-900/45 backdrop-blur-[1px]">
                    <div className="animate-fade-in-up w-[min(82%,330px)] rounded-2xl border border-slate-200 bg-white p-5 text-center shadow-2xl">
                      <div className="text-4xl">{game.result?.winner === null ? '🤝' : playerWon ? '🏆' : '♚'}</div>
                      <h2 className="mt-2 text-xl font-bold text-slate-900">
                        {game.result?.winner === null ? resultText.title : playerWon ? 'Bạn thắng!' : 'Stockfish thắng'}
                      </h2>
                      <p className="mt-1 text-sm text-slate-600">{resultText.detail}</p>
                      <div className="mt-4 flex gap-2">
                        <button
                          type="button"
                          onClick={handleNewGame}
                          className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
                        >
                          Ván mới
                        </button>
                        <button
                          type="button"
                          onClick={() => setOverlayDismissedFor(overlayKey)}
                          className="flex-1 rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-200"
                        >
                          Xem bàn cờ
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </ChessBoard>
            </div>
          </div>
          {playerBar}
        </div>

        {/* Side panel */}
        <aside className="flex w-full flex-col gap-3 lg:w-[360px] lg:shrink-0">
          <EnginePanel
            evaluation={evaluation}
            engine={sf.engine}
            phase={sf.phase}
            thinking={sf.thinking}
            error={sf.error}
            targetDepth={sf.thinking === 'analysis' ? analysisDepth : depth}
            logs={sf.logs}
          />
          <GameControls
            levelId={levelId}
            depth={depth}
            onLevelChange={setLevelId}
            onDepthChange={setGmDepth}
            playerColor={playerColor}
            canUndo={canUndo}
            canResign={!game.result && game.history.length > 0}
            onUndo={handleUndo}
            onNewGame={handleNewGame}
            onSwitchSides={handleSwitchSides}
            onResign={handleResign}
            showMoveArrow={showMoveArrow}
            onShowMoveArrowChange={setShowMoveArrow}
            analysisEnabled={analysisEnabled}
            onAnalysisChange={setAnalysisEnabled}
            showHint={showHint}
            onShowHintChange={setShowHint}
            history={game.history}
            pgn={game.pgn}
          />
        </aside>
      </main>
    </div>
  );
}
