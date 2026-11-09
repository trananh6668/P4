/* =============================================================================
 * useChessGame — FIDE-correct game state backed by chess.js
 * (castling, en passant, promotion, check, checkmate, stalemate, 50-move rule,
 * threefold repetition, insufficient material).
 * ========================================================================== */

import { useCallback, useRef, useState } from 'react';
import { Chess, type Move } from 'chess.js';
import type {
  Color,
  GameResult,
  GameState,
  MoveRecord,
  PieceSymbol,
  PromotionPiece,
  Square,
  UciMove,
} from '../types/chess';

export interface BoardPiece {
  square: Square;
  type: PieceSymbol;
  color: Color;
}

export interface GameSnapshot extends GameState {
  /** 8×8, index [0][0] = a8 (chess.js layout). */
  board: (BoardPiece | null)[][];
  lastMove: { from: Square; to: Square } | null;
  /** Square of the king currently in check. */
  checkSquare: Square | null;
  /** Increments on every New Game: used to invalidate async engine work. */
  gameId: number;
  pgn: string;
}

function toRecord(m: Move): MoveRecord {
  return {
    san: m.san,
    uci: m.lan,
    from: m.from,
    to: m.to,
    color: m.color,
    fenAfter: m.after,
  };
}

function computeResult(chess: Chess): GameResult | null {
  if (chess.isCheckmate()) return { reason: 'checkmate', winner: chess.turn() === 'w' ? 'b' : 'w' };
  if (chess.isStalemate()) return { reason: 'stalemate', winner: null };
  if (chess.isInsufficientMaterial()) return { reason: 'insufficient', winner: null };
  if (chess.isThreefoldRepetition()) return { reason: 'threefold', winner: null };
  if (chess.isDrawByFiftyMoves()) return { reason: 'fifty-move', winner: null };
  return null;
}

function findKing(chess: Chess, color: Color): Square | null {
  for (const row of chess.board()) {
    for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
  }
  return null;
}

function snapshot(chess: Chess, gameId: number, resigned: GameResult | null): GameSnapshot {
  const verbose = chess.history({ verbose: true });
  const last = verbose.at(-1);
  const inCheck = chess.inCheck();
  return {
    fen: chess.fen(),
    turn: chess.turn(),
    history: verbose.map(toRecord),
    inCheck,
    result: resigned ?? computeResult(chess),
    board: chess.board(),
    lastMove: last ? { from: last.from, to: last.to } : null,
    checkSquare: inCheck ? findKing(chess, chess.turn()) : null,
    gameId,
    pgn: chess.pgn(),
  };
}

export interface MoveInput {
  from: Square;
  to: Square;
  promotion?: PromotionPiece;
}

export function useChessGame() {
  const chessRef = useRef<Chess>(new Chess());
  const gameIdRef = useRef(1);
  const resignedRef = useRef<GameResult | null>(null);
  const [state, setState] = useState<GameSnapshot>(() => snapshot(chessRef.current, 1, null));

  const commit = useCallback(() => {
    setState(snapshot(chessRef.current, gameIdRef.current, resignedRef.current));
  }, []);

  /** Legal moves from a square (empty when the game is over). */
  const legalMovesFrom = useCallback((square: Square): Move[] => {
    const chess = chessRef.current;
    if (resignedRef.current || chess.isGameOver()) return [];
    return chess.moves({ square, verbose: true });
  }, []);

  const move = useCallback(
    (input: MoveInput): MoveRecord | null => {
      const chess = chessRef.current;
      if (resignedRef.current || chess.isGameOver()) return null;
      try {
        const m = chess.move({ from: input.from, to: input.to, promotion: input.promotion });
        commit();
        return toRecord(m);
      } catch {
        return null; // illegal move (chess.js ≥1.0 throws)
      }
    },
    [commit],
  );

  /**
   * Apply an engine move in UCI notation, but ONLY if the board is still in the
   * position the engine analysed (`expectedFen`) and the game wasn't restarted.
   * This is the last line of defence against race conditions.
   */
  const applyUciMove = useCallback(
    (uci: UciMove, expectedFen: string, expectedGameId: number): boolean => {
      const chess = chessRef.current;
      if (gameIdRef.current !== expectedGameId || chess.fen() !== expectedFen) return false;
      const from = uci.slice(0, 2) as Square;
      const to = uci.slice(2, 4) as Square;
      const promotion = (uci[4] as PromotionPiece | undefined) ?? undefined;
      return move({ from, to, promotion }) !== null;
    },
    [move],
  );

  const undo = useCallback(
    (plies: number) => {
      const chess = chessRef.current;
      resignedRef.current = null;
      for (let i = 0; i < plies; i++) if (!chess.undo()) break;
      commit();
    },
    [commit],
  );

  const reset = useCallback(() => {
    chessRef.current = new Chess();
    resignedRef.current = null;
    gameIdRef.current += 1;
    commit();
  }, [commit]);

  const resign = useCallback(
    (loser: Color) => {
      if (resignedRef.current || chessRef.current.isGameOver()) return;
      resignedRef.current = { reason: 'resign', winner: loser === 'w' ? 'b' : 'w' };
      commit();
    },
    [commit],
  );

  return { state, legalMovesFrom, move, applyUciMove, undo, reset, resign };
}

/** Convert a UCI PV into SAN for display, stopping at the first invalid move. */
export function pvToSan(fen: string, pv: UciMove[], max = 10): string[] {
  const out: string[] = [];
  try {
    const chess = new Chess(fen);
    for (const uci of pv.slice(0, max)) {
      const m = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4],
      });
      out.push(m.san);
    }
  } catch {
    /* PV may reference a stale position; return what we could convert */
  }
  return out;
}

export function describeResult(result: GameResult): { title: string; detail: string } {
  const winner = result.winner === 'w' ? 'Trắng' : 'Đen';
  switch (result.reason) {
    case 'checkmate':
      return { title: `${winner} thắng`, detail: 'Chiếu bí (Checkmate)' };
    case 'resign':
      return { title: `${winner} thắng`, detail: 'Đối phương đầu hàng' };
    case 'stalemate':
      return { title: 'Hòa cờ', detail: 'Hết nước đi (Stalemate)' };
    case 'fifty-move':
      return { title: 'Hòa cờ', detail: 'Luật 50 nước không ăn quân / không đi tốt' };
    case 'threefold':
      return { title: 'Hòa cờ', detail: 'Lặp lại thế cờ 3 lần' };
    case 'insufficient':
      return { title: 'Hòa cờ', detail: 'Không đủ lực lượng chiếu bí' };
  }
}
