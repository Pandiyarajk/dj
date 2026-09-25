/**
 * Pure loop and jump geometry: keeping loops inside the track and jumps on
 * the beat phase.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { beatIndexAt, beatLength, wrapPhase, type BeatGrid } from './sync';

export interface FittedLoop {
  start: number;
  end: number;
  /** True when the loop had to be moved to fit the track. */
  moved: boolean;
}

/**
 * Fit a loop inside [0, duration], keeping its length.
 *
 * A loop that starts before the track (a floor-snapped grid extends
 * backwards) or runs past its end would never loop in the audio thread, so it
 * is moved inside, by whole beats when a beat length is given so it stays on
 * the grid.
 *
 * @returns the fitted loop, or null if the loop is longer than the track.
 */
export function fitLoop(start: number, end: number, duration: number, beat?: number): FittedLoop | null {
  const span = end - start;
  if (span <= 0 || span > duration) return null;
  let s = start;
  const step = beat && beat > 0 && beat <= duration ? beat : 0;
  if (s < 0) s += step ? Math.ceil(-s / step - 1e-9) * step : -s;
  if (s + span > duration) s -= step ? Math.ceil((s + span - duration) / step - 1e-9) * step : s + span - duration;
  // Whole-beat moves can overshoot at either edge on a short track: pin it.
  if (s < 0) s = 0;
  if (s + span > duration) s = duration - span;
  return { start: s, end: s + span, moved: Math.abs(s - start) > 1e-9 };
}

/**
 * Where a jump to `target` should land so the beat phase is unchanged.
 *
 * Moves the target by at most half a beat so the playhead keeps its position
 * within the beat: a playing deck that was on the beat (or in phase with a
 * synced deck) stays there after a hot cue or waveform jump. A result before
 * the track start goes one beat forward.
 */
export function phasePreservingTarget(grid: BeatGrid, current: number, target: number): number {
  const delta = wrapPhase(beatIndexAt(grid, current) - beatIndexAt(grid, target));
  const landed = target + delta * beatLength(grid.bpm);
  return landed < 0 ? landed + beatLength(grid.bpm) : landed;
}
