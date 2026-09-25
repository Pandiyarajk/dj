/**
 * Effect timing maths.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { describe, expect, it } from 'vitest';
import { echoSeconds } from '../src/audio/effects';

describe('echoSeconds', () => {
  it('is the beat division at the deck tempo', () => {
    expect(echoSeconds(1, 120)).toBeCloseTo(0.5, 9);
    expect(echoSeconds(0.75, 128)).toBeCloseTo(0.3515625, 9);
    expect(echoSeconds(0.25, 174)).toBeCloseTo(60 / 174 / 4, 9);
  });

  it('falls back to 120 BPM without a tempo and stays inside the delay line', () => {
    expect(echoSeconds(1, null)).toBeCloseTo(0.5, 9);
    expect(echoSeconds(2, 20)).toBeLessThan(4);
    expect(echoSeconds(0.001, 200)).toBeGreaterThan(0);
  });
});
