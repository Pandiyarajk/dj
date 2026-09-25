/**
 * Audio quality of the deck processor: loop wraps, jumps, key lock placement,
 * reverse inside a loop. Each test is a defect the audio-corpus test measured.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-26-2026
 */
import { describe, expect, it } from 'vitest';
import { deckProcessor } from './worklet-harness';

const RATE = 48000;

/** A chord with no energy above 3 kHz, so any HF at a wrap is a click. */
function chord(seconds: number): Float32Array {
  return Float32Array.from({ length: seconds * RATE }, (_, i) => {
    const t = i / RATE;
    return 0.2 * (Math.sin(2 * Math.PI * 110 * t) + Math.sin(2 * Math.PI * 220.5 * t) + Math.sin(2 * Math.PI * 331 * t) + Math.sin(2 * Math.PI * 440.7 * t));
  });
}

/** Seeded white noise: any two positions are uncorrelated, so a crossfade between them holds the level. */
function noise(seconds: number): Float32Array {
  let seed = 12345;
  return Float32Array.from({ length: seconds * RATE }, () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return (seed / 2 ** 32 - 0.5) * 0.6;
  });
}

/** Largest second difference (a click detector) over a range, relative to the signal peak. */
function worstKink(signal: Float32Array, from: number, to: number): number {
  let kink = 0;
  let peak = 1e-9;
  for (let i = from + 1; i < to - 1; i++) {
    kink = Math.max(kink, Math.abs(signal[i + 1] - 2 * signal[i] + signal[i - 1]));
    peak = Math.max(peak, Math.abs(signal[i]));
  }
  return kink / peak;
}

/** Lowest 5 ms RMS (dB relative to the overall RMS) over a range: a dropout detector. */
function deepestDip(signal: Float32Array, from: number, to: number): number {
  const size = RATE / 200;
  let total = 0;
  for (let i = from; i < to; i++) total += signal[i] * signal[i];
  const overall = total / (to - from);
  let min = Infinity;
  for (let s = from; s + size <= to; s += size / 4) {
    let sum = 0;
    for (let i = s; i < s + size; i++) sum += signal[i] * signal[i];
    min = Math.min(min, sum / size);
  }
  return 10 * Math.log10(min / overall + 1e-20);
}

async function loaded(signal: Float32Array) {
  const deck = await deckProcessor(RATE);
  deck.send({ type: 'load', left: signal, right: signal.slice() });
  return deck;
}

/** The kink level of straight playback of the chord: the baseline a clean wrap must match. */
const CLEAN_KINK = 0.02;

describe('deck processor quality', () => {
  it('straight chord playback is below the click threshold (calibration)', async () => {
    const deck = await loaded(chord(4));
    deck.send({ type: 'play', seq: 1 });
    const [left] = deck.render(RATE * 2);
    expect(worstKink(left, RATE / 10, RATE * 2)).toBeLessThan(CLEAN_KINK);
  });

  for (const keyLock of [false, true]) {
    it(`an off-grid loop wraps without a click (key lock ${keyLock ? 'on' : 'off'})`, async () => {
      const deck = await loaded(chord(6));
      deck.send({ type: 'keyLock', on: keyLock });
      deck.send({ type: 'rate', rate: keyLock ? 1.08 : 1 });
      deck.send({ type: 'loop', start: RATE * 1.003, end: RATE * 1.3737 });
      deck.send({ type: 'play', seq: 1 });
      const [left] = deck.render(RATE * 3);
      expect(worstKink(left, RATE / 10, RATE * 3)).toBeLessThan(CLEAN_KINK);
    });
  }

  for (const keyLock of [false, true]) {
    it(`a jump while playing crossfades instead of dropping out (key lock ${keyLock ? 'on' : 'off'})`, async () => {
      const deck = await loaded(noise(6));
      deck.send({ type: 'keyLock', on: keyLock });
      deck.send({ type: 'play', seq: 1 });
      deck.render(RATE);
      deck.send({ type: 'seek', frame: RATE * 3.2371, seq: 2 });
      const [left] = deck.render(RATE / 2);
      expect(deepestDip(left, 0, RATE / 2)).toBeGreaterThan(-3);
    });
  }

  it('switching key lock while playing does not drop out', async () => {
    const deck = await loaded(noise(6));
    deck.send({ type: 'play', seq: 1 });
    deck.render(RATE);
    deck.send({ type: 'keyLock', on: true });
    const [on] = deck.render(RATE / 2);
    deck.send({ type: 'keyLock', on: false });
    const [off] = deck.render(RATE / 2);
    expect(deepestDip(on, 0, RATE / 2)).toBeGreaterThan(-3);
    expect(deepestDip(off, 0, RATE / 2)).toBeGreaterThan(-3);
  });

  it('key lock at rate 1 after silence does not lag the head', async () => {
    // 1 s of silence, then a click every 0.5 s: at rate 1 the output must match the input.
    const signal = new Float32Array(RATE * 4);
    const clicks = [1.5, 2, 2.5, 3].map((s) => Math.round(s * RATE));
    for (const c of clicks) for (let i = 0; i < 64; i++) signal[c + i] = Math.sin((Math.PI * i) / 64) * (i % 2 ? 1 : -1) * 0.8;
    const deck = await loaded(signal);
    deck.send({ type: 'keyLock', on: true });
    deck.send({ type: 'play', seq: 1 });
    const [left] = deck.render(RATE * 3.5);
    for (const c of clicks) {
      let best = 0;
      let at = 0;
      for (let i = c - 400; i < c + 400; i++) if (Math.abs(left[i]) > best) [best, at] = [Math.abs(left[i]), i];
      // Allow the de-click ramp's offset and grain rounding: well under 1 ms.
      expect(Math.abs(at - (c + 32))).toBeLessThan(48);
    }
  });

  it('reversing inside a loop stays inside the loop', async () => {
    const deck = await loaded(chord(12));
    deck.send({ type: 'seek', frame: RATE * 10.2, seq: 1 });
    deck.send({ type: 'loop', start: RATE * 10, end: RATE * 10.5 });
    deck.send({ type: 'rate', rate: -1 });
    deck.send({ type: 'play', seq: 2 });
    deck.render(RATE);
    const reports = deck.messages.filter((m): m is { type: string; frame: number } => (m as { type: string }).type === 'position');
    const frame = reports[reports.length - 1].frame;
    expect(frame).toBeGreaterThanOrEqual(RATE * 10);
    expect(frame).toBeLessThan(RATE * 10.5);
  });
});
