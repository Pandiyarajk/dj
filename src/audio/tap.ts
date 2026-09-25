/**
 * Tap tempo: BPM from a run of taps, robust to one off-time tap.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */

/** A pause longer than this starts a new run of taps, ms. */
export const TAP_RESET_MS = 2000;
/** Taps averaged at most (the most recent ones). */
const MAX_TAPS = 8;

/**
 * BPM from tap times (ms, ascending), or null with fewer than 3 taps.
 * Uses the median interval, so one late or early tap does not skew it.
 */
export function tapBpm(taps: number[]): number | null {
  const recent = taps.slice(-MAX_TAPS);
  if (recent.length < 3) return null;
  const intervals = recent.slice(1).map((t, i) => t - recent[i]).sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  const median = intervals.length % 2 ? intervals[mid] : (intervals[mid - 1] + intervals[mid]) / 2;
  // Average the intervals close to the median for precision, dropping outliers.
  const close = intervals.filter((d) => Math.abs(d - median) <= median * 0.15);
  const mean = close.reduce((a, b) => a + b, 0) / close.length;
  return mean > 0 ? 60000 / mean : null;
}

/** Add a tap, starting a new run after a pause; returns the new list. */
export function addTap(taps: number[], now: number): number[] {
  const last = taps[taps.length - 1];
  const run = last !== undefined && now - last > TAP_RESET_MS ? [] : taps;
  return [...run, now].slice(-MAX_TAPS);
}
