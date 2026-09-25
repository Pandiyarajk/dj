/**
 * Tests for tempo matching and phase alignment.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { describe, expect, it } from 'vitest';
import { beatIndexAt, phaseAlignedPosition, snapToBeat, tempoForSync, wrapPhase } from '../src/audio/sync';

describe('tempoForSync', () => {
  it('matches a nearby tempo inside the smallest range', () => {
    const result = tempoForSync(128, 124);
    expect(result.multiplier).toBe(1);
    expect(124 * (1 + result.tempo)).toBeCloseTo(128, 9);
    expect(result.range).toBe(0.08);
  });

  it('uses double or half time instead of a huge tempo change', () => {
    expect(tempoForSync(174, 86).multiplier).toBe(0.5);
    expect(tempoForSync(87, 172).multiplier).toBe(2);
    const half = tempoForSync(174, 86);
    expect(86 * (1 + half.tempo)).toBeCloseTo(87, 9);
  });

  it('widens the range when needed', () => {
    expect(tempoForSync(140, 124).range).toBe(0.16);
    expect(tempoForSync(100, 140).range).toBe(0.5);
    expect(tempoForSync(90, 150).range).toBe(0.5);
  });

  it('always fits the widest range for any two detectable tempos (70-180 BPM)', () => {
    for (let leader = 70; leader < 180; leader += 7) {
      for (let follower = 70; follower < 180; follower += 11) {
        const { tempo, range } = tempoForSync(leader, follower);
        expect(Math.abs(tempo)).toBeLessThan(0.415);
        expect(range).not.toBeNull();
      }
    }
  });
});

describe('phase alignment', () => {
  const leader = { bpm: 128, firstBeat: 0.21 };
  const follower = { bpm: 128, firstBeat: 0.05 };

  it('wrapPhase lands in [-0.5, 0.5)', () => {
    for (const d of [-3.7, -0.5, -0.2, 0, 0.49, 0.5, 2.25]) {
      const w = wrapPhase(d);
      expect(w).toBeGreaterThanOrEqual(-0.5);
      expect(w).toBeLessThan(0.5);
      expect(Math.abs(w - d) % 1).toBeCloseTo(0, 9);
    }
  });

  it('puts the follower beat in phase with the leader, moving at most half a beat', () => {
    for (const followerPos of [3.1, 17.77, 60.01]) {
      const leaderPos = 42.345;
      const aligned = phaseAlignedPosition(leader, leaderPos, follower, followerPos);
      const lPhase = beatIndexAt(leader, leaderPos);
      const fPhase = beatIndexAt(follower, aligned);
      expect(wrapPhase(fPhase - lPhase)).toBeCloseTo(0, 9);
      expect(Math.abs(aligned - followerPos)).toBeLessThanOrEqual(60 / 128 / 2 + 1e-9);
    }
  });

  it('never aligns to a position before the start of the track', () => {
    // Follower parked at 0 with the leader just past a beat: the shortest move is
    // backwards, which a seek would clamp to 0 and leave up to half a beat out.
    for (let leaderPos = 10; leaderPos < 11; leaderPos += 0.05) {
      const aligned = phaseAlignedPosition(leader, leaderPos, follower, 0);
      expect(aligned).toBeGreaterThanOrEqual(0);
      expect(wrapPhase(beatIndexAt(follower, aligned) - beatIndexAt(leader, leaderPos))).toBeCloseTo(0, 9);
    }
  });

  it('aligns across different tempos and a double-time multiplier', () => {
    const slow = { bpm: 87, firstBeat: 0.4 };
    const fast = { bpm: 172, firstBeat: 0.1 };
    const aligned = phaseAlignedPosition(slow, 20, fast, 33.3, 2);
    expect(wrapPhase(beatIndexAt(fast, aligned) - 2 * beatIndexAt(slow, 20))).toBeCloseTo(0, 9);
  });

  it('snapToBeat snaps to the grid', () => {
    const grid = { bpm: 120, firstBeat: 0.1 };
    expect(snapToBeat(grid, 1.33)).toBeCloseTo(1.1, 9);
    expect(snapToBeat(grid, 1.58, 'floor')).toBeCloseTo(1.1, 9);
    expect(snapToBeat(grid, 1.6, 'floor')).toBeCloseTo(1.6, 9);
  });
});
