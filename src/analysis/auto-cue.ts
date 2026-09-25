/**
 * Automatic cue point: the first beat at the start of the music, so a fresh
 * track does not cue into leading silence.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { beatLength, type BeatGrid } from '../audio/sync';
import type { Peaks } from './peaks';

/** A bin counts as audible above this fraction of full scale (0..255 peaks). */
const AUDIBLE = 0.06;

/**
 * First grid beat at (or just before) the first audible moment.
 *
 * @returns seconds; 0 for silence. Without a grid, the first audible moment itself.
 */
export function autoCuePoint(peaks: Peaks, grid: BeatGrid | null): number {
  const threshold = AUDIBLE * 255;
  let first = -1;
  for (let i = 0; i < peaks.low.length; i++) {
    if (peaks.low[i] > threshold || peaks.mid[i] > threshold || peaks.high[i] > threshold) {
      first = i;
      break;
    }
  }
  if (first < 0) return 0;
  const onset = first / peaks.binsPerSecond;
  if (!grid) return onset;
  const beat = beatLength(grid.bpm);
  // A beat up to a quarter beat before the onset counts: onsets are detected
  // slightly after the transient starts.
  const index = Math.ceil((onset - grid.firstBeat) / beat - 0.25);
  return Math.max(0, grid.firstBeat + index * beat);
}
