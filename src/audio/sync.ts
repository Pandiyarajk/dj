/**
 * Pure beat-sync maths: tempo matching and phase alignment.
 *
 * Positions are in seconds of *track* time (not wall-clock time); a beat grid is
 * described by its BPM and the time of its first beat.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */

export interface BeatGrid {
  /** Native tempo of the track, beats per minute. */
  bpm: number;
  /** Time of the first beat, seconds of track time. */
  firstBeat: number;
}

/** Tempo fader ranges a deck offers, as fractions (0.08 = ±8%). */
export const TEMPO_RANGES = [0.08, 0.16, 0.5] as const;

export interface SyncTempo {
  /** Tempo offset to apply to the follower, as a fraction (0.02 = +2%). */
  tempo: number;
  /** Beat multiplier used: 1 normally, 2 or 0.5 when matching double/half time. */
  multiplier: number;
  /** Smallest tempo range from TEMPO_RANGES that can hold `tempo`, or null if none can. */
  range: number | null;
}

/** Length of one beat in seconds of track time. */
export function beatLength(bpm: number): number {
  return 60 / bpm;
}

/** Fractional beat index at a track position (0 at the first beat). */
export function beatIndexAt(grid: BeatGrid, position: number): number {
  return (position - grid.firstBeat) / beatLength(grid.bpm);
}

/** Wrap a phase difference into [-0.5, 0.5). */
export function wrapPhase(delta: number): number {
  return delta - Math.floor(delta + 0.5);
}

/**
 * Tempo the follower needs to play at the leader's audible BPM.
 *
 * Tries half and double time as well and picks whichever needs the smallest
 * tempo change, so a 87 BPM track can sync to a 174 BPM one.
 *
 * @param leaderEffectiveBpm leader's native BPM times its current playback rate.
 * @param followerBpm follower's native BPM.
 */
export function tempoForSync(leaderEffectiveBpm: number, followerBpm: number): SyncTempo {
  let best = { tempo: Infinity, multiplier: 1 };
  for (const multiplier of [1, 2, 0.5]) {
    const tempo = (leaderEffectiveBpm * multiplier) / followerBpm - 1;
    if (Math.abs(tempo) < Math.abs(best.tempo) - 1e-9) best = { tempo, multiplier };
  }
  const range = TEMPO_RANGES.find((r) => Math.abs(best.tempo) <= r + 1e-9) ?? null;
  return { ...best, range };
}

/**
 * Follower position that puts its beats in phase with the leader's.
 *
 * Moves the follower by at most half a beat, in whichever direction is shorter,
 * except near the start of the track: a position before 0 would be clamped by
 * the seek and land up to half a beat out, so it goes one beat forward instead.
 *
 * @param leader leader grid.
 * @param leaderPosition leader track position now, seconds.
 * @param follower follower grid.
 * @param followerPosition follower track position now, seconds.
 * @param multiplier from tempoForSync: follower beats per leader beat.
 * @returns new follower track position, seconds.
 */
export function phaseAlignedPosition(
  leader: BeatGrid,
  leaderPosition: number,
  follower: BeatGrid,
  followerPosition: number,
  multiplier = 1,
): number {
  const targetPhase = beatIndexAt(leader, leaderPosition) * multiplier;
  const currentPhase = beatIndexAt(follower, followerPosition);
  const delta = wrapPhase(targetPhase - currentPhase);
  const aligned = followerPosition + delta * beatLength(follower.bpm);
  return aligned < 0 ? aligned + beatLength(follower.bpm) : aligned;
}

/**
 * Snap a position to the nearest beat (or the beat at/before it with `mode: 'floor'`).
 * Positions before the first beat snap onto the grid extended backwards.
 */
export function snapToBeat(grid: BeatGrid, position: number, mode: 'nearest' | 'floor' = 'nearest'): number {
  const index = beatIndexAt(grid, position);
  const snapped = mode === 'floor' ? Math.floor(index + 1e-6) : Math.round(index);
  return grid.firstBeat + snapped * beatLength(grid.bpm);
}
