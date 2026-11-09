import type { DifficultyLevel, LevelId, UciScore } from '../types/chess';

export const DIFFICULTY_LEVELS: readonly DifficultyLevel[] = [
  { id: 1, name: 'Người mới', description: 'Depth 4 · ~0.1–0.2s', depth: 4 },
  { id: 2, name: 'Phong trào', description: 'Depth 8 · ~0.5s', depth: 8 },
  { id: 3, name: 'Cao thủ', description: 'Depth 12 · ~1–2s', depth: 12 },
  {
    id: 4,
    name: 'Đại kiện tướng',
    description: 'Depth 16–20 · phân tích sâu',
    depth: 18,
    range: [16, 20],
  },
] as const;

export function getLevel(id: LevelId): DifficultyLevel {
  return DIFFICULTY_LEVELS.find((l) => l.id === id) ?? DIFFICULTY_LEVELS[0];
}

/** Background analysis on the user's turn is capped to keep the CPU (and battery) cool. */
export const MAX_ANALYSIS_DEPTH = 16;

/**
 * White's winning chance in [0, 100] from a White-perspective score.
 * Same logistic model Lichess uses for its evaluation gauge.
 */
export function whiteWinPercent(score: UciScore): number {
  if (score.kind === 'mate') {
    if (score.value === 0) return 50;
    return score.value > 0 ? 100 : 0;
  }
  const cp = Math.max(-1000, Math.min(1000, score.value));
  const winning = 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
  return 50 + 50 * winning;
}

/** "+1.25", "-0.40", "M3", "-M5" (White perspective). */
export function formatScore(score: UciScore): string {
  if (score.kind === 'mate') {
    if (score.value === 0) return '#';
    return score.value > 0 ? `M${score.value}` : `-M${Math.abs(score.value)}`;
  }
  const pawns = score.value / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}G`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
