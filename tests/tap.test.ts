/**
 * Tap tempo tests.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { describe, expect, it } from 'vitest';
import { addTap, tapBpm } from '../src/audio/tap';

const taps = (bpm: number, count: number, jitter: number[] = []): number[] =>
  Array.from({ length: count }, (_, i) => 1000 + (i * 60000) / bpm + (jitter[i] ?? 0));

describe('tapBpm', () => {
  it('needs three taps', () => {
    expect(tapBpm(taps(120, 2))).toBeNull();
    expect(tapBpm(taps(120, 3))).toBeCloseTo(120, 6);
  });

  it('is accurate with human jitter and ignores one bad tap', () => {
    expect(tapBpm(taps(128, 8, [0, 6, -4, 3, -7, 5, -2, 4]))).toBeCloseTo(128, 0);
    // The fifth tap is 120 ms late: the median rejects it.
    const bad = taps(124, 8);
    bad[4] += 120;
    expect(Math.abs(tapBpm(bad)! - 124)).toBeLessThan(2.5);
  });
});

describe('addTap', () => {
  it('starts a new run after a long pause and keeps the last eight', () => {
    let run: number[] = [];
    for (let i = 0; i < 12; i++) run = addTap(run, i * 500);
    expect(run).toHaveLength(8);
    run = addTap(run, 5500 + 3000);
    expect(run).toEqual([8500]);
  });
});
