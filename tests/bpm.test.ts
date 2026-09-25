/**
 * BPM detector accuracy against synthetic signals of known tempo.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { describe, expect, it } from 'vitest';
import { detectBpm } from '../src/analysis/bpm';
import { renderPattern, type PatternStyle } from '../src/demo/synth';

const SAMPLE_RATE = 44100;

/** Distance between two beat times, modulo the beat length. */
function phaseError(actual: number, expected: number, bpm: number): number {
  const beat = 60 / bpm;
  const d = (((actual - expected) % beat) + beat) % beat;
  return Math.min(d, beat - d);
}

const cases: Array<{ bpm: number; style: PatternStyle; offset: number }> = [
  { bpm: 90, style: 'clicks', offset: 0.37 },
  { bpm: 120, style: 'clicks', offset: 0.05 },
  { bpm: 128, style: 'clicks', offset: 0.2 },
  { bpm: 174, style: 'clicks', offset: 0.11 },
  { bpm: 124, style: 'house', offset: 0.3 },
  { bpm: 128.5, style: 'house', offset: 0.0 },
  { bpm: 174, style: 'dnb', offset: 0.25 },
  { bpm: 86, style: 'halftime', offset: 0.6 },
];

describe('detectBpm', () => {
  for (const { bpm, style, offset } of cases) {
    it(`finds ${bpm} BPM (${style}) within 0.5 BPM and 15 ms`, () => {
      const samples = renderPattern({ bpm, seconds: 45, sampleRate: SAMPLE_RATE, style, offset, bassHz: style === 'house' ? 55 : 0 });
      const result = detectBpm(samples, SAMPLE_RATE);
      expect(result).not.toBeNull();
      expect(Math.abs(result!.bpm - bpm)).toBeLessThanOrEqual(0.5);
      expect(phaseError(result!.firstBeat, offset, bpm)).toBeLessThanOrEqual(0.015);
    });
  }

  it('returns null for silence and for audio too short to analyse', () => {
    expect(detectBpm(new Float32Array(SAMPLE_RATE * 20), SAMPLE_RATE)).toBeNull();
    const short = renderPattern({ bpm: 120, seconds: 2, sampleRate: SAMPLE_RATE, style: 'clicks' });
    expect(detectBpm(short, SAMPLE_RATE)).toBeNull();
  });
});
