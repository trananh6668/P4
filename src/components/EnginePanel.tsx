/* =============================================================================
 * EnginePanel — real-time Stockfish telemetry parsed from UCI `info` lines:
 * score, depth/seldepth, nodes, NPS, time, best move & principal variation.
 * ========================================================================== */

import { memo, useMemo, useState } from 'react';
import { pvToSan } from '../hooks/useChessGame';
import { formatNumber, formatScore } from '../lib/engine';
import type { EngineEvaluation, EngineIdentity, EnginePhase, SearchPurpose } from '../types/chess';

interface EnginePanelProps {
  evaluation: EngineEvaluation | null;
  engine: EngineIdentity | null;
  phase: EnginePhase;
  thinking: SearchPurpose | null;
  error: string | null;
  targetDepth: number;
  logs: string[];
}

const PHASE_LABEL: Record<EnginePhase, string> = {
  loading: 'Đang tải WASM…',
  handshake: 'Bắt tay UCI…',
  idle: 'Sẵn sàng',
  searching: 'Đang tính toán',
  stopping: 'Đang dừng…',
  syncing: 'Đồng bộ…',
  error: 'Lỗi',
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
      <div className="truncate font-mono text-sm font-bold text-slate-900">{value}</div>
    </div>
  );
}

function EnginePanelImpl({ evaluation, engine, phase, thinking, error, targetDepth, logs }: EnginePanelProps) {
  const [showLog, setShowLog] = useState(false);

  const sanPv = useMemo(
    () => (evaluation ? pvToSan(evaluation.fen, evaluation.pv, 12) : []),
    [evaluation],
  );

  const moveNumber = evaluation ? Number(evaluation.fen.split(' ')[5] ?? 1) : 1;
  const blackFirst = evaluation?.fen.split(' ')[1] === 'b';

  const dotColor =
    phase === 'error'
      ? 'bg-red-500'
      : thinking
        ? 'bg-amber-500 animate-pulse'
        : phase === 'idle'
          ? 'bg-emerald-500'
          : 'bg-sky-500 animate-pulse';

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
      <header className="mb-2.5 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-bold text-slate-900">
            {engine?.name ?? 'Stockfish'} <span className="font-normal text-slate-500">· WASM</span>
          </h2>
          <p className="text-[11px] text-slate-500">Web Worker · UCI · 100% offline</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
          <span className={`h-2 w-2 rounded-full ${dotColor}`} />
          {thinking === 'play' ? 'AI đang nghĩ' : thinking === 'analysis' ? 'Phân tích' : PHASE_LABEL[phase]}
        </div>
      </header>

      {error && <p className="mb-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</p>}

      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="Đánh giá" value={evaluation ? formatScore(evaluation.score) : '—'} />
        <Stat
          label="Depth"
          value={evaluation ? `${evaluation.depth}${evaluation.seldepth ? `/${evaluation.seldepth}` : ''}` : `0/${targetDepth}`}
        />
        <Stat label="Thời gian" value={evaluation ? `${(evaluation.timeMs / 1000).toFixed(2)}s` : '—'} />
        <Stat label="Nodes" value={evaluation ? formatNumber(evaluation.nodes) : '—'} />
        <Stat label="NPS" value={evaluation ? `${formatNumber(evaluation.nps)}/s` : '—'} />
        <Stat label="Best move" value={sanPv[0] ?? evaluation?.bestMove ?? '—'} />
      </div>

      <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Biến chính (PV)</div>
        <p className="mt-0.5 line-clamp-2 min-h-[2.5em] font-mono text-xs leading-relaxed text-slate-700">
          {sanPv.length === 0
            ? '—'
            : sanPv.map((san, i) => {
                const ply = i + (blackFirst ? 1 : 0);
                const num = moveNumber + Math.floor(ply / 2);
                const prefix = ply % 2 === 0 ? `${num}. ` : i === 0 ? `${num}… ` : '';
                return (
                  <span key={i} className={i === 0 ? 'font-bold text-emerald-700' : ''}>
                    {prefix}
                    {san}{' '}
                  </span>
                );
              })}
        </p>
      </div>

      <button
        type="button"
        onClick={() => setShowLog((s) => !s)}
        className="mt-2 text-[11px] font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline"
      >
        {showLog ? 'Ẩn' : 'Hiện'} log UCI
      </button>
      {showLog && (
        <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-slate-200 bg-slate-900 p-2 font-mono text-[10px] leading-snug text-emerald-300">
          {logs.length ? logs.slice(-60).join('\n') : '(trống)'}
        </pre>
      )}
    </section>
  );
}

export const EnginePanel = memo(EnginePanelImpl);
