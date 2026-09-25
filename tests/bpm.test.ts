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
  // 4/4 above 140 used to come out halved: the half-tempo comb sits on beats 2 and 4.
  { bpm: 140, style: 'house', offset: 0.1 },
  { bpm: 150, style: 'house', offset: 0.2 },
  { bpm: 160, style: 'house', offset: 0.05 },
  { bpm: 180, style: 'house', offset: 0.15 },
  // Hip-hop tempos stay slow. (A four-on-the-floor 85 with off-beat hats is
  // indistinguishable from a 170 pulse; the deck's x2 and /2 buttons cover it.)
  { bpm: 90, style: 'halftime', offset: 0.3 },
  { bpm: 95, style: 'halftime', offset: 0.44 },
];

// Full-length tracks: a fixed coarse step drifted far enough over minutes for a
// 2/3 or 4/3 candidate to win (128 read as 85.33, 124 as 165.34).
const longCases: Array<{ bpm: number; style: PatternStyle; seconds: number; offset: number }> = [
  { bpm: 128, style: 'house', seconds: 240, offset: 0.1 },
  { bpm: 128, style: 'house', seconds: 400, offset: 0.27 },
  { bpm: 124, style: 'house', seconds: 600, offset: 0.12 },
  { bpm: 174, style: 'dnb', seconds: 300, offset: 0.05 },
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

  for (const { bpm, style, seconds, offset } of longCases) {
    it(`finds ${bpm} BPM on a ${seconds} s ${style} track within 0.05 BPM and 15 ms`, () => {
      const samples = renderPattern({ bpm, seconds, sampleRate: 22050, style, offset, bassHz: style === 'house' ? 55 : 0 });
      const result = detectBpm(samples, 22050);
      expect(result).not.toBeNull();
      expect(Math.abs(result!.bpm - bpm)).toBeLessThanOrEqual(0.05);
      expect(phaseError(result!.firstBeat, offset, bpm)).toBeLessThanOrEqual(0.015);
    }, 60000);
  }

  it('returns null for silence and for audio too short to analyse', () => {
    expect(detectBpm(new Float32Array(SAMPLE_RATE * 20), SAMPLE_RATE)).toBeNull();
    const short = renderPattern({ bpm: 120, seconds: 2, sampleRate: SAMPLE_RATE, style: 'clicks' });
    expect(detectBpm(short, SAMPLE_RATE)).toBeNull();
  });
});
