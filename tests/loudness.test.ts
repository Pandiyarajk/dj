/**
 * Loudness (BS.1770) and auto-gain tests.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { describe, expect, it } from 'vitest';
import { autoGainDb, measureLoudness } from '../src/analysis/loudness';

const RATE = 48000;

function sine(freq: number, amplitudeDb: number, seconds: number): Float32Array {
  const a = Math.pow(10, amplitudeDb / 20);
  return Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => a * Math.sin((2 * Math.PI * freq * i) / RATE));
}

describe('measureLoudness', () => {
  it('reads a stereo 1 kHz sine at -23 dBFS as -23.0 LUFS (EBU Tech 3341 case 1)', () => {
    const tone = sine(1000, -23, 20);
    expect(measureLoudness([tone, tone], RATE).lufs).toBeCloseTo(-23, 1);
  });

  it('reads the same tone in one channel 3 dB quieter', () => {
    const tone = sine(1000, -23, 20);
    const silence = new Float32Array(tone.length);
    expect(measureLoudness([tone, silence], RATE).lufs).toBeCloseTo(-26.01, 1);
  });

  it('gates out silence: a track with a long silent intro reads like the music', () => {
    const tone = sine(1000, -20, 10);
    const padded = new Float32Array(tone.length * 3);
    padded.set(tone, tone.length * 2);
    const plain = measureLoudness([tone, tone], RATE).lufs;
    // Within 0.15 LU, not exact: the 400 ms blocks straddling the edge are
    // partly loud, pass both gates and count, as BS.1770 specifies.
    expect(Math.abs(measureLoudness([padded, padded], RATE).lufs - plain)).toBeLessThan(0.15);
  });

  it('reports the sample peak and -Infinity for silence', () => {
    const tone = sine(440, -6, 5);
    expect(measureLoudness([tone], RATE).peakDb).toBeCloseTo(-6, 1);
    expect(measureLoudness([new Float32Array(RATE * 5)], RATE).lufs).toBe(-Infinity);
  });

  it('streams a 10-minute stereo track without stalling (sanity bound, not a benchmark)', () => {
    const tone = sine(100, -12, 600);
    const start = performance.now();
    measureLoudness([tone, tone], RATE);
    expect(performance.now() - start).toBeLessThan(20000);
  });
});

describe('autoGainDb', () => {
  it('turns loud tracks down and quiet ones up, towards -10 LUFS', () => {
    expect(autoGainDb({ lufs: -6, peakDb: 0 })).toBeCloseTo(-4, 9);
    expect(autoGainDb({ lufs: -16, peakDb: -12 })).toBeCloseTo(6, 9);
  });

  it('never boosts the peak above -1 dBFS, and clamps to +/-12 dB', () => {
    expect(autoGainDb({ lufs: -16, peakDb: -3 })).toBeCloseTo(2, 9);
    expect(autoGainDb({ lufs: -40, peakDb: -30 })).toBe(12);
    expect(autoGainDb({ lufs: 5, peakDb: 0 })).toBe(-12);
    expect(autoGainDb({ lufs: -Infinity, peakDb: -Infinity })).toBe(0);
    expect(autoGainDb(null)).toBe(0);
  });
});
