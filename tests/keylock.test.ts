/**
 * Key lock (WSOLA) and playback tests on the real deck processor.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { describe, expect, it } from 'vitest';
import { deckProcessor } from './worklet-harness';

const RATE = 48000;

function sine(freq: number, seconds: number): Float32Array {
  return Float32Array.from({ length: seconds * RATE }, (_, i) => 0.5 * Math.sin((2 * Math.PI * freq * i) / RATE));
}

/** Frequency from rising zero crossings over a stretch of signal. */
function frequency(signal: Float32Array, from: number, to: number): number {
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if (signal[i - 1] <= 0 && signal[i] > 0) crossings++;
  return crossings / ((to - from) / RATE);
}

/** Min and max RMS (dB) over 20 ms windows in a range. */
function levelRange(signal: Float32Array, from: number, to: number): [number, number] {
  const size = RATE / 50;
  let min = Infinity;
  let max = -Infinity;
  for (let s = from; s + size <= to; s += size) {
    let sum = 0;
    for (let i = s; i < s + size; i++) sum += signal[i] * signal[i];
    const db = 10 * Math.log10(sum / size + 1e-20);
    min = Math.min(min, db);
    max = Math.max(max, db);
  }
  return [min, max];
}

async function play(rate: number, keyLock: boolean, seconds: number, setup?: (send: (c: never) => void) => void) {
  const deck = await deckProcessor(RATE);
  const tone = sine(440, 8);
  deck.send({ type: 'load', left: tone, right: tone.slice() });
  deck.send({ type: 'rate', rate });
  deck.send({ type: 'keyLock', on: keyLock });
  setup?.(deck.send as never);
  deck.send({ type: 'play', seq: 1 });
  const [left] = deck.render(seconds * RATE);
  return { left, deck };
}

describe('key lock', () => {
  it('without key lock, +8% raises the pitch by 8%', async () => {
    const { left } = await play(1.08, false, 2);
    expect(frequency(left, RATE / 2, RATE * 2)).toBeCloseTo(475.2, -1);
  });

  it('with key lock, +8% and -8% keep the pitch', async () => {
    for (const rate of [1.08, 0.92, 1.16]) {
      const { left } = await play(rate, true, 2);
      const f = frequency(left, RATE / 2, RATE * 2);
      expect(Math.abs(f - 440) / 440).toBeLessThan(0.01);
    }
  });

  it('keeps a steady level (no grain dips) and reports the head at the tempo rate', async () => {
    const { left, deck } = await play(1.08, true, 2);
    const [min, max] = levelRange(left, RATE / 2, RATE * 2);
    expect(max - min).toBeLessThan(1.5);
    const reports = deck.messages.filter((m): m is { type: string; frame: number } => (m as { type: string }).type === 'position');
    const lastFrame = reports[reports.length - 1].frame;
    expect(lastFrame / (2 * RATE)).toBeCloseTo(1.08, 1);
  });

  it('runs well faster than real time (CPU sanity bound for two decks)', async () => {
    const start = performance.now();
    await play(1.08, true, 10);
    // 10 s of audio; two decks must fit comfortably in real time on the audio thread.
    expect(performance.now() - start).toBeLessThan(2500);
  });

  it('stays smooth across loop wraps', async () => {
    const { left } = await play(1.08, true, 3, (send) => send({ type: 'loop', start: RATE, end: RATE * 1.4137 } as never));
    const [min, max] = levelRange(left, RATE, RATE * 3);
    expect(max - min).toBeLessThan(2);
    expect(Math.abs(frequency(left, RATE, RATE * 3) - 440) / 440).toBeLessThan(0.015);
  });
});

describe('key lock bass and timing', () => {
  it('holds bass pitch (45-90 Hz) as well as the mids', async () => {
    for (const f of [45, 60, 90]) {
      for (const rate of [0.92, 1.06, 1.16]) {
        const deck = await deckProcessor(RATE);
        const tone = Float32Array.from({ length: RATE * 6 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / RATE));
        deck.send({ type: 'load', left: tone, right: tone.slice() });
        deck.send({ type: 'rate', rate });
        deck.send({ type: 'keyLock', on: true });
        deck.send({ type: 'play', seq: 1 });
        const [left] = deck.render(RATE * 4);
        // One zero crossing over 3 s is 1/135 at 45 Hz: allow two.
        expect(Math.abs(frequency(left, RATE, RATE * 4) - f)).toBeLessThanOrEqual(2 / 3 + 1e-9);
      }
    }
  });

  it('keeps kicks within 2 ms of the head at 0.92 to 1.16', async () => {
    const kicks = new Float32Array(RATE * 12);
    const beats: number[] = [];
    for (let s = 0.5; s < 11.5; s += 0.4839) {
      const at = Math.round(s * RATE);
      beats.push(at);
      let phase = 0;
      for (let i = 0; i < RATE / 4; i++) {
        const t = i / RATE;
        phase += (2 * Math.PI * (50 + 100 * Math.exp(-t * 30))) / RATE;
        kicks[at + i] += 0.8 * Math.exp(-t * 12) * Math.sin(phase);
      }
    }
    for (let i = 0; i < kicks.length; i++) kicks[i] += 0.05 * Math.sin((2 * Math.PI * 440 * i) / RATE);
    for (const rate of [0.92, 1.06, 1.16]) {
      const deck = await deckProcessor(RATE);
      deck.send({ type: 'load', left: kicks, right: kicks.slice() });
      deck.send({ type: 'rate', rate });
      deck.send({ type: 'keyLock', on: true });
      deck.send({ type: 'play', seq: 1 });
      const [left] = deck.render(Math.floor(RATE * 9.5));
      const errors: number[] = [];
      for (const beat of beats) {
        const expected = beat / rate;
        if (expected < RATE || expected > RATE * 9) continue;
        let onset = expected + 1500;
        for (let i = Math.floor(expected - 1500); i < expected + 1500; i++) {
          if (Math.abs(left[i]) > 0.3) {
            onset = i;
            break;
          }
        }
        errors.push(((onset - expected) / RATE) * 1000);
      }
      errors.sort((a, b) => a - b);
      expect(Math.abs(errors[errors.length >> 1])).toBeLessThan(2);
    }
  });
});
