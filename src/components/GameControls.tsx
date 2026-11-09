/* =============================================================================
 * GameControls — difficulty, Undo / New game / Switch sides / Resign,
 * move-arrow & analysis toggles and the move history (PGN).
 * ========================================================================== */

import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { DIFFICULTY_LEVELS, getLevel } from '../lib/engine';
import type { Color, LevelId, MoveRecord } from '../types/chess';

interface GameControlsProps {
  levelId: LevelId;
  depth: number;
  onLevelChange: (id: LevelId) => void;
  onDepthChange: (depth: number) => void;

  playerColor: Color;
  canUndo: boolean;
  canResign: boolean;
  onUndo: () => void;
  onNewGame: () => void;
  onSwitchSides: () => void;
  onResign: () => void;

  showMoveArrow: boolean;
  onShowMoveArrowChange: (v: boolean) => void;
  analysisEnabled: boolean;
  onAnalysisChange: (v: boolean) => void;
  showHint: boolean;
  onShowHintChange: (v: boolean) => void;

  history: MoveRecord[];
  pgn: string;
}

function Button({
  children,
  onClick,
  disabled,
  variant = 'default',
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'default' | 'primary' | 'danger';
  title?: string;
}) {
  const styles = {
    default: 'border border-slate-300 bg-slate-100 hover:bg-slate-200 text-slate-800',
    primary: 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm',
    danger: 'border border-slate-300 bg-slate-100 hover:border-red-300 hover:bg-red-50 hover:text-red-700 text-slate-700',
  }[variant];
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 text-xs font-medium text-slate-700">
      {label}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-emerald-600' : 'bg-slate-300'}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`}
        />
      </button>
    </label>
  );
}

function GameControlsImpl(props: GameControlsProps) {
  const {
    levelId,
    depth,
    onLevelChange,
    onDepthChange,
    playerColor,
    canUndo,
    canResign,
    onUndo,
    onNewGame,
    onSwitchSides,
    onResign,
    showMoveArrow,
    onShowMoveArrowChange,
    analysisEnabled,
    onAnalysisChange,
    showHint,
    onShowHintChange,
    history,
    pgn,
  } = props;

  const level = getLevel(levelId);
  const listRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  // Auto-scroll the move list to the latest move.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [history.length]);

  const rows: { n: number; w?: MoveRecord; b?: MoveRecord }[] = [];
  history.forEach((m, i) => {
    const n = Math.floor(i / 2) + 1;
    if (i % 2 === 0) rows.push({ n, w: m });
    else rows[rows.length - 1].b = m;
  });

  const copyPgn = async () => {
    try {
      await navigator.clipboard.writeText(pgn);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable (insecure context) */
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Difficulty */}
      <section className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
        <label htmlFor="level" className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">
          Cấp độ AI
        </label>
        <select
          id="level"
          value={levelId}
          onChange={(e) => onLevelChange(Number(e.target.value) as LevelId)}
          className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
        >
          {DIFFICULTY_LEVELS.map((l) => (
            <option key={l.id} value={l.id}>
              Cấp {l.id} · {l.name} — {l.description}
            </option>
          ))}
        </select>

        {level.range && (
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-xs text-slate-600">
              <span>Độ sâu tính toán</span>
              <span className="font-mono font-bold text-emerald-700">depth {depth}</span>
            </div>
            <input
              type="range"
              min={level.range[0]}
              max={level.range[1]}
              step={1}
              value={depth}
              onChange={(e) => onDepthChange(Number(e.target.value))}
              className="w-full accent-emerald-600"
            />
            <div className="flex justify-between font-mono text-[10px] text-slate-400">
              <span>{level.range[0]}</span>
              <span>{level.range[1]}</span>
            </div>
          </div>
        )}
      </section>

      {/* Actions */}
      <section className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={onUndo} disabled={!canUndo} title="Đi lại nước vừa rồi (Ctrl+Z)">
            ↶ Đi lại
          </Button>
          <Button onClick={onNewGame} variant="primary" title="Bắt đầu ván mới (N)">
            ＋ Ván mới
          </Button>
          <Button onClick={onSwitchSides} title="Đổi màu quân & lật bàn cờ (F)">
            ⇅ Đổi bên ({playerColor === 'w' ? 'Trắng' : 'Đen'})
          </Button>
          <Button onClick={onResign} disabled={!canResign} variant="danger">
            ⚑ Đầu hàng
          </Button>
        </div>
        <div className="mt-3 flex flex-col gap-2 border-t border-slate-200 pt-3">
          <Toggle checked={showMoveArrow} onChange={onShowMoveArrowChange} label="Hiện mũi tên chỉ quân cờ di chuyển" />
          <Toggle checked={analysisEnabled} onChange={onAnalysisChange} label="Phân tích khi đến lượt bạn" />
          <Toggle checked={showHint} onChange={onShowHintChange} label="Hiện mũi tên gợi ý (best move)" />
        </div>
      </section>

      {/* Move list */}
      <section className="flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Biên bản nước đi</h3>
          <button
            type="button"
            onClick={copyPgn}
            disabled={history.length === 0}
            className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-600 disabled:text-slate-400"
          >
            {copied ? '✓ Đã sao chép' : 'Sao chép PGN'}
          </button>
        </div>
        <div ref={listRef} className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 font-mono text-sm lg:max-h-60">
          {rows.length === 0 ? (
            <p className="p-3 text-center text-xs text-slate-400">Chưa có nước đi nào</p>
          ) : (
            <table className="w-full">
              <tbody>
                {rows.map((r, i) => {
                  const lastIdx = history.length - 1;
                  const wIdx = i * 2;
                  return (
                    <tr key={r.n} className="odd:bg-slate-100/70">
                      <td className="w-10 py-1 pl-2.5 text-slate-400">{r.n}.</td>
                      <td className={`py-1 pl-1.5 font-semibold ${wIdx === lastIdx ? 'rounded bg-amber-200/80 text-slate-900' : 'text-slate-800'}`}>
                        {r.w?.san}
                      </td>
                      <td className={`py-1 pl-1.5 font-semibold ${wIdx + 1 === lastIdx ? 'rounded bg-amber-200/80 text-slate-900' : 'text-slate-800'}`}>
                        {r.b?.san ?? ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

export const GameControls = memo(GameControlsImpl);
