/**
 * Tests for loop fitting, phase-preserving jumps and the automatic cue point.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { describe, expect, it } from 'vitest';
import { autoCuePoint } from '../src/analysis/auto-cue';
import type { Peaks } from '../src/analysis/peaks';
import { fitLoop, phasePreservingTarget } from '../src/audio/loops';
import { beatIndexAt, wrapPhase } from '../src/audio/sync';

describe('fitLoop', () => {
  it('leaves a loop inside the track alone', () => {
    expect(fitLoop(10, 12, 100, 0.5)).toEqual({ start: 10, end: 12, moved: false });
  });

  it('moves a loop that starts before 0 forward by whole beats', () => {
    const fitted = fitLoop(-0.2, 1.8, 100, 0.5)!;
    expect(fitted.start).toBeCloseTo(0.3, 9);
    expect(fitted.end - fitted.start).toBeCloseTo(2, 9);
    expect(fitted.moved).toBe(true);
  });

  it('moves a loop that runs past the end back by whole beats', () => {
    const fitted = fitLoop(97, 105, 100, 0.5)!;
    expect(fitted.end).toBeLessThanOrEqual(100 + 1e-9);
    expect(fitted.start).toBeCloseTo(92, 9);
  });

  it('refuses a loop longer than the track', () => {
    expect(fitLoop(0, 30, 20, 0.5)).toBeNull();
  });
});

describe('phasePreservingTarget', () => {
  const grid = { bpm: 120, firstBeat: 0.1 };

  it('keeps the position within the beat, moving at most half a beat', () => {
    const current = 20.23;
    for (const cue of [5.1, 5.35, 61.9]) {
      const landed = phasePreservingTarget(grid, current, cue);
      expect(wrapPhase(beatIndexAt(grid, landed) - beatIndexAt(grid, current))).toBeCloseTo(0, 9);
      expect(Math.abs(landed - cue)).toBeLessThanOrEqual(0.25 + 1e-9);
    }
  });

  it('never lands before the start of the track', () => {
    expect(phasePreservingTarget(grid, 20.5, 0.1)).toBeGreaterThanOrEqual(0);
  });
});

describe('autoCuePoint', () => {
  const peaksWithOnset = (onsetBin: number): Peaks => {
    const n = 1000;
    const low = new Uint8Array(n);
    for (let i = onsetBin; i < n; i++) low[i] = 200;
    return { binsPerSecond: 100, low, mid: new Uint8Array(n), high: new Uint8Array(n) };
  };

  it('cues to the first beat at the start of the music', () => {
    // Music starts at 2.02 s; beats every 0.5 s from 0.01 s: the beat at 2.01 s.
    expect(autoCuePoint(peaksWithOnset(202), { bpm: 120, firstBeat: 0.01 })).toBeCloseTo(2.01, 9);
  });

  it('is 0 for silence, and the onset itself without a grid', () => {
    expect(autoCuePoint(peaksWithOnset(1000), { bpm: 120, firstBeat: 0 })).toBe(0);
    expect(autoCuePoint(peaksWithOnset(150), null)).toBeCloseTo(1.5, 9);
  });
});
