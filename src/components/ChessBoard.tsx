/* =============================================================================
 * ChessBoard — single light-mode tournament board with high-contrast Staunton
 * SVG pieces, click-to-move & drag-and-drop, move trajectory arrows (last move,
 * active move preview, engine best-move hint, right-click custom arrows),
 * check highlight and promotion picker.
 * ========================================================================== */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { Move } from 'chess.js';
import type { BoardPiece, MoveInput } from '../hooks/useChessGame';
import type { Color, PieceSymbol, PromotionPiece, Square, UciMove } from '../types/chess';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
const PROMOTION_PIECES: PromotionPiece[] = ['q', 'n', 'r', 'b'];

export function pieceSrc(color: Color, type: PieceSymbol): string {
  return `${import.meta.env.BASE_URL}pieces/${color}${type.toUpperCase()}.svg`;
}

interface ChessBoardProps {
  board: (BoardPiece | null)[][];
  fen: string;
  orientation: Color;
  /** Color the human controls. */
  playerColor: Color;
  /** Whether the human may move right now (their turn, engine idle, game running). */
  interactive: boolean;
  lastMove: { from: Square; to: Square } | null;
  /** Whether to draw an arrow showing the piece movement of the last move. */
  showMoveArrow?: boolean;
  checkSquare: Square | null;
  legalMovesFrom: (square: Square) => Move[];
  onMove: (move: MoveInput) => void;
  /** Optional arrow (engine suggestion), UCI notation. */
  arrow?: UciMove | null;
  /** Overlay rendered on top of the board (e.g. game-over card). */
  children?: ReactNode;
}

interface DragState {
  from: Square;
  piece: BoardPiece;
  /** Pointer position relative to the board, in px. */
  x: number;
  y: number;
}

/** Display coordinates (0..7, 0 = top-left) of a square for the given orientation. */
function toDisplay(square: Square, orientation: Color): { col: number; row: number } {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return orientation === 'w' ? { col: file, row: 7 - rank } : { col: 7 - file, row: rank };
}

function fromDisplay(col: number, row: number, orientation: Color): Square {
  const file = orientation === 'w' ? col : 7 - col;
  const rank = orientation === 'w' ? 7 - row : row;
  return `${FILES[file]}${rank + 1}` as Square;
}

function ChessBoardImpl({
  board,
  fen,
  orientation,
  playerColor,
  interactive,
  lastMove,
  showMoveArrow = true,
  checkSquare,
  legalMovesFrom,
  onMove,
  arrow,
  children,
}: ChessBoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pointerHover, setPointerHover] = useState<Square | null>(null);
  const [promotion, setPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const [userArrows, setUserArrows] = useState<UciMove[]>([]);
  const rightDragFromRef = useRef<Square | null>(null);
  const wasSelectedRef = useRef(false);

  // Any position change (own move, engine move, undo, new game) clears UI selection state.
  useEffect(() => {
    setSelected(null);
    setDrag(null);
    setPointerHover(null);
    setPromotion(null);
    setUserArrows([]);
  }, [fen, orientation]);

  useEffect(() => {
    if (!interactive) {
      setSelected(null);
      setDrag(null);
    }
  }, [interactive]);

  const pieceAt = useMemo(() => {
    const map = new Map<Square, BoardPiece>();
    for (const row of board) for (const p of row) if (p) map.set(p.square, p);
    return map;
  }, [board]);

  const targets = useMemo(() => {
    const map = new Map<Square, Move[]>();
    if (!selected) return map;
    for (const m of legalMovesFrom(selected)) {
      const list = map.get(m.to) ?? [];
      list.push(m);
      map.set(m.to, list);
    }
    return map;
  }, [selected, legalMovesFrom]);

  const squareFromPoint = useCallback(
    (clientX: number, clientY: number): Square | null => {
      const el = boardRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const col = Math.floor(((clientX - rect.left) / rect.width) * 8);
      const row = Math.floor(((clientY - rect.top) / rect.height) * 8);
      if (col < 0 || col > 7 || row < 0 || row > 7) return null;
      return fromDisplay(col, row, orientation);
    },
    [orientation],
  );

  const attemptMove = useCallback(
    (from: Square, to: Square): boolean => {
      const candidates = legalMovesFrom(from).filter((m) => m.to === to);
      if (candidates.length === 0) return false;
      if (candidates.some((m) => m.promotion)) {
        setPromotion({ from, to });
      } else {
        onMove({ from, to });
      }
      setSelected(null);
      return true;
    },
    [legalMovesFrom, onMove],
  );

  /* ---------------------------------------------------- pointer events */

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (promotion) return;
    const square = squareFromPoint(e.clientX, e.clientY);
    if (!square) return;

    // Right-click starts drawing a tactical arrow.
    if (e.button === 2) {
      rightDragFromRef.current = square;
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    if (e.button !== 0) return;
    if (userArrows.length > 0) setUserArrows([]);

    // Second click on a target square → move.
    if (selected && targets.has(square)) {
      attemptMove(selected, square);
      return;
    }

    const piece = pieceAt.get(square);
    if (interactive && piece && piece.color === playerColor) {
      wasSelectedRef.current = selected === square;
      setSelected(square);
      const rect = boardRef.current!.getBoundingClientRect();
      setDrag({ from: square, piece, x: e.clientX - rect.left, y: e.clientY - rect.top });
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    } else {
      setSelected(null);
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const sq = squareFromPoint(e.clientX, e.clientY);
    if (sq !== pointerHover) setPointerHover(sq);
    if (!drag) return;
    const rect = boardRef.current!.getBoundingClientRect();
    setDrag({ ...drag, x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button === 2 && rightDragFromRef.current) {
      const from = rightDragFromRef.current;
      rightDragFromRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      const to = squareFromPoint(e.clientX, e.clientY);
      if (to && to !== from) {
        const uci = `${from}${to}`;
        setUserArrows((prev) => (prev.includes(uci) ? prev.filter((a) => a !== uci) : [...prev, uci]));
      }
      return;
    }

    if (!drag) return;
    const target = squareFromPoint(e.clientX, e.clientY);
    const from = drag.from;
    setDrag(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);

    if (target && target !== from) {
      if (!attemptMove(from, target)) setSelected(null);
    } else if (target === from && wasSelectedRef.current) {
      setSelected(null); // click on an already-selected piece toggles it off
    }
  };

  const onPointerCancel = () => {
    rightDragFromRef.current = null;
    setDrag(null);
  };

  const onPointerLeave = () => {
    if (!drag) setPointerHover(null);
  };

  /* ------------------------------------------------------------ render */

  const hoverSquare = drag && boardRef.current
    ? (() => {
        const size = boardRef.current.clientWidth / 8;
        const col = Math.floor(drag.x / size);
        const row = Math.floor(drag.y / size);
        return col >= 0 && col < 8 && row >= 0 && row < 8 ? fromDisplay(col, row, orientation) : null;
      })()
    : pointerHover;

  // Live preview arrow when a piece is selected and the pointer hovers a legal destination square
  const activePreviewArrow: UciMove | null =
    selected && hoverSquare && hoverSquare !== selected && targets.has(hoverSquare)
      ? `${selected}${hoverSquare}`
      : null;

  const lastMoveUci: UciMove | null =
    showMoveArrow && lastMove ? `${lastMove.from}${lastMove.to}` : null;

  const squares: ReactNode[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const sq = fromDisplay(col, row, orientation);
      const file = sq.charCodeAt(0) - 97;
      const rank = Number(sq[1]);
      // Standard FIDE board: a1 (file=0, rank=1) is a dark square, h1 is a light square.
      const dark = (file + rank) % 2 === 1;
      const piece = pieceAt.get(sq);
      const moveTargets = targets.get(sq);
      const isCapture = !!moveTargets?.some((m) => m.captured);
      const isLast = lastMove && (lastMove.from === sq || lastMove.to === sq);
      const isSelected = selected === sq;
      const isDragging = drag?.from === sq;

      squares.push(
        <div
          key={sq}
          data-square={sq}
          className={`relative ${dark ? 'bg-board-dark' : 'bg-board-light'}`}
        >
          {isLast && <div className="absolute inset-0 bg-highlight/60" />}
          {isSelected && <div className="absolute inset-0 bg-amber-300/75" />}
          {checkSquare === sq && <div className="absolute inset-0 check-glow" />}
          {hoverSquare === sq && moveTargets && (
            <div className="absolute inset-0 shadow-[inset_0_0_0_3.5px_rgba(255,255,255,0.85)]" />
          )}

          {/* coordinates */}
          {col === 0 && (
            <span
              className={`pointer-events-none absolute left-[4%] top-[3%] text-[clamp(9px,1.5vw,13px)] font-bold leading-none ${
                dark ? 'text-board-light' : 'text-board-dark'
              }`}
            >
              {rank}
            </span>
          )}
          {row === 7 && (
            <span
              className={`pointer-events-none absolute bottom-[2%] right-[4%] text-[clamp(9px,1.5vw,13px)] font-bold leading-none ${
                dark ? 'text-board-light' : 'text-board-dark'
              }`}
            >
              {FILES[file]}
            </span>
          )}

          {piece && (
            <img
              src={pieceSrc(piece.color, piece.type)}
              alt={`${piece.color === 'w' ? 'Trắng' : 'Đen'} ${piece.type.toUpperCase()}`}
              draggable={false}
              className={`chess-piece pointer-events-none absolute inset-0 h-full w-full select-none p-[4%] ${
                isDragging ? 'opacity-25' : ''
              } ${interactive && piece.color === playerColor ? 'cursor-grab' : ''}`}
            />
          )}

          {moveTargets &&
            (isCapture ? (
              <div className="pointer-events-none absolute inset-0 capture-ring" />
            ) : (
              <div className="pointer-events-none absolute left-1/2 top-1/2 h-[28%] w-[28%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-900/28" />
            ))}
        </div>,
      );
    }
  }

  return (
    <div className="rounded-xl border border-slate-300 bg-white p-1.5 shadow-lg shadow-slate-300/60">
      <div
        ref={boardRef}
        className="relative aspect-square w-full touch-none select-none overflow-hidden rounded-lg ring-1 ring-slate-300"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="grid h-full w-full grid-cols-8 grid-rows-8">{squares}</div>

        {/* Layer of directional arrows (last move, engine hint, active move preview, user arrows) */}
        <BoardArrows
          orientation={orientation}
          lastMoveUci={lastMoveUci}
          hintUci={arrow ?? null}
          previewUci={activePreviewArrow}
          userArrows={userArrows}
        />

        {drag && boardRef.current && (
          <img
            src={pieceSrc(drag.piece.color, drag.piece.type)}
            alt=""
            draggable={false}
            className="chess-piece pointer-events-none absolute left-0 top-0 z-30 h-[12.5%] w-[12.5%] cursor-grabbing p-[0.5%]"
            style={{
              transform: `translate(${drag.x - boardRef.current.clientWidth / 16}px, ${drag.y - boardRef.current.clientWidth / 16}px) scale(1.12)`,
            }}
          />
        )}

        {promotion && (
          <PromotionPicker
            to={promotion.to}
            color={playerColor}
            orientation={orientation}
            onPick={(p) => {
              onMove({ from: promotion.from, to: promotion.to, promotion: p });
              setPromotion(null);
            }}
            onCancel={() => setPromotion(null)}
          />
        )}

        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------- Board Arrows */

interface ArrowItem {
  uci: UciMove;
  color: string;
  id: string;
  dashed?: boolean;
  showOriginDot?: boolean;
}

function BoardArrows({
  orientation,
  lastMoveUci,
  hintUci,
  previewUci,
  userArrows,
}: {
  orientation: Color;
  lastMoveUci: UciMove | null;
  hintUci: UciMove | null;
  previewUci: UciMove | null;
  userArrows: UciMove[];
}) {
  const items: ArrowItem[] = [];

  if (lastMoveUci && lastMoveUci.length >= 4) {
    items.push({
      uci: lastMoveUci,
      color: 'rgba(217, 119, 6, 0.85)', // amber-600: piece that just moved
      id: 'arrow-last',
      showOriginDot: true,
    });
  }
  if (hintUci && hintUci.length >= 4) {
    items.push({
      uci: hintUci,
      color: 'rgba(22, 163, 74, 0.88)', // green-600: Stockfish best move hint
      id: 'arrow-hint',
      showOriginDot: true,
    });
  }
  if (previewUci && previewUci.length >= 4) {
    items.push({
      uci: previewUci,
      color: 'rgba(37, 99, 235, 0.85)', // blue-600: active move preview
      id: 'arrow-preview',
      showOriginDot: true,
    });
  }
  userArrows.forEach((u, idx) => {
    if (u.length >= 4) {
      items.push({
        uci: u,
        color: 'rgba(220, 38, 38, 0.82)', // red-600: right-click tactical arrow
        id: `arrow-user-${idx}`,
        showOriginDot: true,
      });
    }
  });

  if (items.length === 0) return null;

  return (
    <svg viewBox="0 0 8 8" className="pointer-events-none absolute inset-0 z-20 h-full w-full">
      {items.map((item) => {
        const a = toDisplay(item.uci.slice(0, 2) as Square, orientation);
        const b = toDisplay(item.uci.slice(2, 4) as Square, orientation);
        const x1 = a.col + 0.5;
        const y1 = a.row + 0.5;
        const x2 = b.col + 0.5;
        const y2 = b.row + 0.5;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len === 0) return null;

        const ux = dx / len;
        const uy = dy / len;
        const px = -uy;
        const py = ux;

        // Start slightly away from center of origin square; stop inside target square
        const startOffset = 0.16;
        const headLength = 0.42;
        const headHalfWidth = 0.24;
        const shaftHalfWidth = 0.085;

        const sx = x1 + ux * startOffset;
        const sy = y1 + uy * startOffset;
        const tipX = x2 - ux * 0.08;
        const tipY = y2 - uy * 0.08;
        const neckX = tipX - ux * headLength;
        const neckY = tipY - uy * headLength;

        const points = [
          `${sx + px * shaftHalfWidth},${sy + py * shaftHalfWidth}`,
          `${neckX + px * shaftHalfWidth},${neckY + py * shaftHalfWidth}`,
          `${neckX + px * headHalfWidth},${neckY + py * headHalfWidth}`,
          `${tipX},${tipY}`,
          `${neckX - px * headHalfWidth},${neckY - py * headHalfWidth}`,
          `${neckX - px * shaftHalfWidth},${neckY - py * shaftHalfWidth}`,
          `${sx - px * shaftHalfWidth},${sy - py * shaftHalfWidth}`,
        ].join(' ');

        return (
          <g key={item.id}>
            {item.showOriginDot && (
              <circle
                cx={x1}
                cy={y1}
                r={0.14}
                fill={item.color}
                stroke="rgba(255,255,255,0.8)"
                strokeWidth={0.03}
              />
            )}
            <polygon
              points={points}
              fill={item.color}
              stroke="rgba(255,255,255,0.85)"
              strokeWidth={0.03}
              strokeLinejoin="round"
            />
          </g>
        );
      })}
    </svg>
  );
}

/* --------------------------------------------------- Promotion picker */

function PromotionPicker({
  to,
  color,
  orientation,
  onPick,
  onCancel,
}: {
  to: Square;
  color: Color;
  orientation: Color;
  onPick: (p: PromotionPiece) => void;
  onCancel: () => void;
}) {
  const { col, row } = toDisplay(to, orientation);
  const fromTop = row === 0; // promotion square at the top edge → list grows downward

  return (
    <div
      className="absolute inset-0 z-40 bg-slate-900/35 backdrop-blur-[1px]"
      onPointerDown={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div
        className="absolute flex w-[12.5%] flex-col overflow-hidden rounded-lg bg-white shadow-2xl ring-2 ring-slate-400"
        style={{
          left: `${col * 12.5}%`,
          ...(fromTop ? { top: 0 } : { bottom: 0 }),
          flexDirection: fromTop ? 'column' : 'column-reverse',
        }}
      >
        {PROMOTION_PIECES.map((p) => (
          <button
            key={p}
            type="button"
            title={{ q: 'Hậu', r: 'Xe', b: 'Tượng', n: 'Mã' }[p]}
            className="aspect-square w-full p-1 transition hover:bg-amber-200"
            onPointerDown={(e) => {
              e.stopPropagation();
              onPick(p);
            }}
          >
            <img src={pieceSrc(color, p)} alt={p} draggable={false} className="chess-piece h-full w-full" />
          </button>
        ))}
      </div>
    </div>
  );
}

export const ChessBoard = memo(ChessBoardImpl);
