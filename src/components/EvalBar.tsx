/* =============================================================================
 * EvalBar — vertical evaluation gauge (White's share of the bar), driven by the
 * centipawn / mate score parsed from Stockfish's UCI `info` output.
 * ========================================================================== */

import { memo } from 'react';
import { formatScore, whiteWinPercent } from '../lib/engine';
import type { Color, UciScore } from '../types/chess';

interface EvalBarProps {
  /** White-perspective score, `null` while no evaluation is available yet. */
  score: UciScore | null;
  orientation: Color;
  /** Game-over override (e.g. checkmate: 100/0, draw: 50). */
  forcedPercent?: number | null;
  depth?: number;
}

function EvalBarImpl({ score, orientation, forcedPercent, depth }: EvalBarProps) {
  const white = forcedPercent ?? (score ? whiteWinPercent(score) : 50);
  const label = score ? formatScore(score) : '0.00';
  const whiteAhead = white >= 50;
  const whiteAtBottom = orientation === 'w';

  // Label sits at the edge of whichever side is better, inside its own color.
  const labelAtBottom = whiteAhead === whiteAtBottom;

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-lg border border-slate-300 bg-slate-800 shadow-sm"
      role="meter"
      aria-label="Thanh đánh giá thế trận"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(white)}
      title={depth ? `Đánh giá: ${label} (depth ${depth})` : 'Đánh giá thế trận'}
    >
      {/* White fill */}
      <div
        className="absolute left-0 right-0 bg-white transition-[height] duration-500 ease-out"
        style={{ height: `${white}%`, ...(whiteAtBottom ? { bottom: 0 } : { top: 0 }) }}
      />
      {/* Midline */}
      <div className="absolute left-0 right-0 top-1/2 h-0.5 bg-amber-500/80" />

      <span
        className={`absolute left-0 right-0 text-center font-mono text-[8px] font-bold leading-none tracking-tighter sm:text-[10px] ${
          labelAtBottom ? 'bottom-1.5' : 'top-1.5'
        } ${whiteAhead ? 'text-slate-900' : 'text-white'}`}
      >
        {label}
      </span>
    </div>
  );
}

export const EvalBar = memo(EvalBarImpl);
