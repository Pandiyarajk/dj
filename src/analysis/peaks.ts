/**
 * Waveform peak summaries in three frequency bands.
 *
 * The result is small enough to cache per track (about 450 bytes per second)
 * and is what both waveform views draw from.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { lowPass } from './filters';

export interface Peaks {
  /** Bins per second of track time. */
  binsPerSecond: number;
  /** Peak level per bin, 0..255, for each band. */
  low: Uint8Array;
  mid: Uint8Array;
  high: Uint8Array;
}

/** Band edges in Hz: low < LOW_CUT <= mid < HIGH_CUT <= high. */
const LOW_CUT = 200;
const HIGH_CUT = 2000;

/**
 * Compute per-band peak levels for a mono signal.
 *
 * @param samples mono PCM, -1..1.
 * @param sampleRate sample rate of `samples`.
 * @param binsPerSecond resolution of the summary.
 * @returns peaks normalised so the loudest bin of any band is 255.
 */
export function computePeaks(samples: Float32Array, sampleRate: number, binsPerSecond = 150): Peaks {
  const low = lowPass(samples, LOW_CUT, sampleRate);
  const belowHigh = lowPass(samples, HIGH_CUT, sampleRate);
  const binSize = Math.max(1, Math.round(sampleRate / binsPerSecond));
  const bins = Math.ceil(samples.length / binSize);
  const lowPeak = new Float32Array(bins);
  const midPeak = new Float32Array(bins);
  const highPeak = new Float32Array(bins);
  let max = 0;

  for (let b = 0; b < bins; b++) {
    const end = Math.min(samples.length, (b + 1) * binSize);
    let l = 0;
    let m = 0;
    let h = 0;
    for (let i = b * binSize; i < end; i++) {
      const lv = Math.abs(low[i]);
      const mv = Math.abs(belowHigh[i] - low[i]);
      const hv = Math.abs(samples[i] - belowHigh[i]);
      if (lv > l) l = lv;
      if (mv > m) m = mv;
      if (hv > h) h = hv;
    }
    lowPeak[b] = l;
    midPeak[b] = m;
    highPeak[b] = h;
    max = Math.max(max, l, m, h);
  }

  const scale = max > 0 ? 255 / max : 0;
  const quantise = (src: Float32Array): Uint8Array => Uint8Array.from(src, (v) => Math.round(v * scale));
  return {
    binsPerSecond: sampleRate / binSize,
    low: quantise(lowPeak),
    mid: quantise(midPeak),
    high: quantise(highPeak),
  };
}
