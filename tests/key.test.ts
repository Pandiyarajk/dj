/**
 * Key detection tests on synthesised chord progressions.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { describe, expect, it } from 'vitest';
import { compatibleKeys, detectKey, fft } from '../src/analysis/key';
import { renderPattern } from '../src/demo/synth';

const RATE = 22050;
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** A harmonic tone (fundamental plus two overtones) at MIDI note `midi`. */
function addNote(out: Float32Array, midi: number, start: number, seconds: number, gain: number): void {
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  const s0 = Math.round(start * RATE);
  const n = Math.round(seconds * RATE);
  for (let i = 0; i < n && s0 + i < out.length; i++) {
    const t = i / RATE;
    const env = Math.min(1, t * 50) * Math.exp(-t * 1.5);
    out[s0 + i] += gain * env * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t));
  }
}

/** A diatonic progression in a key: I-IV-V-I-vi (major) or i-iv-V-i-VI (minor), looped. */
function progression(tonic: number, minor: boolean, seconds = 24): Float32Array {
  const out = new Float32Array(seconds * RATE);
  const chords: number[][] = minor
    ? [[0, 3, 7], [5, 8, 12], [7, 11, 14], [0, 3, 7], [8, 12, 15]]
    : [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7], [9, 12, 16]];
  const beat = 1.2;
  for (let c = 0; c * beat < seconds; c++) {
    const chord = chords[c % chords.length];
    const root = 60 + tonic;
    for (const interval of chord) addNote(out, root + interval, c * beat, beat, 0.12);
    addNote(out, root - 24 + chord[0], c * beat, beat, 0.18);
  }
  return out;
}

describe('fft', () => {
  it('puts a pure bin-aligned tone in its bin', () => {
    const n = 1024;
    const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 37 * i) / n));
    const im = new Float64Array(n);
    fft(re, im);
    const mags = Array.from(re, (r, i) => Math.hypot(r, im[i]));
    expect(mags.indexOf(Math.max(...mags.slice(0, n / 2)))).toBe(37);
  });
});

describe('detectKey', () => {
  const cases: Array<[number, boolean, string]> = [
    [0, false, '8B'],
    [9, true, '8A'],
    [7, false, '9B'],
    [2, true, '7A'],
    [6, false, '2B'],
    [3, true, '2A'],
    [5, false, '7B'],
    [11, true, '10A'],
  ];
  for (const [tonic, minor, camelot] of cases) {
    it(`finds ${NOTES[tonic]} ${minor ? 'minor' : 'major'} (${camelot})`, () => {
      const result = detectKey(progression(tonic, minor), RATE);
      expect(result?.camelot).toBe(camelot);
      expect(result?.name).toBe(`${NOTES[tonic]} ${minor ? 'minor' : 'major'}`);
    });
  }

  it('finds the key or a Camelot neighbour under a drum pattern', () => {
    const music = progression(9, true, 30);
    const drums = renderPattern({ bpm: 124, seconds: 30, sampleRate: RATE, style: 'house' });
    const mixed = Float32Array.from(music, (v, i) => v + 0.6 * drums[i]);
    const result = detectKey(mixed, RATE);
    expect(compatibleKeys('8A')).toContain(result?.camelot);
  });

  it('returns null for silence', () => {
    expect(detectKey(new Float32Array(RATE * 10), RATE)).toBeNull();
  });
});

describe('compatibleKeys', () => {
  it('lists the key, its wheel neighbours and its relative', () => {
    expect(compatibleKeys('8A')).toEqual(['8A', '7A', '9A', '8B']);
    expect(compatibleKeys('12B')).toEqual(['12B', '11B', '1B', '12A']);
    expect(compatibleKeys('1A')).toEqual(['1A', '12A', '2A', '1B']);
    expect(compatibleKeys('x')).toEqual([]);
  });
});
