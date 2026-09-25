/**
 * Waveform peak summaries in three frequency bands.
 *
 * The result is small enough to cache per track (about 450 bytes per second)
 * and is what both waveform views draw from.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (single streaming pass; per-band robust normalisation)
 */
import { LowPass } from './filters';

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
 * Each band is scaled so this fraction of its bins fit below full scale.
 * Normalising to the single loudest bin let one transient flatten the whole
 * view; normalising all bands together let the bass hide the hats.
 */
const NORMALISE_PERCENTILE = 0.995;

/** Value at `fraction` of the sorted distribution of `values` (ignores silence). */
function percentile(values: Float32Array, fraction: number): number {
  const audible = values.filter((v) => v > 1e-4);
  if (audible.length === 0) return 0;
  audible.sort();
  return audible[Math.min(audible.length - 1, Math.floor(audible.length * fraction))];
}

/**
 * Compute per-band peak levels for a mono signal in one streaming pass.
 *
 * @param samples mono PCM, -1..1.
 * @param sampleRate sample rate of `samples`.
 * @param binsPerSecond resolution of the summary.
 */
export function computePeaks(samples: Float32Array, sampleRate: number, binsPerSecond = 150): Peaks {
  const lowFilter = new LowPass(LOW_CUT, sampleRate);
  const belowHighFilter = new LowPass(HIGH_CUT, sampleRate);
  const binSize = Math.max(1, Math.round(sampleRate / binsPerSecond));
  const bins = Math.ceil(samples.length / binSize);
  const bands = [new Float32Array(bins), new Float32Array(bins), new Float32Array(bins)];

  for (let b = 0; b < bins; b++) {
    const end = Math.min(samples.length, (b + 1) * binSize);
    let l = 0;
    let m = 0;
    let h = 0;
    for (let i = b * binSize; i < end; i++) {
      const x = samples[i];
      const low = lowFilter.next(x);
      const belowHigh = belowHighFilter.next(x);
      const lv = Math.abs(low);
      const mv = Math.abs(belowHigh - low);
      const hv = Math.abs(x - belowHigh);
      if (lv > l) l = lv;
      if (mv > m) m = mv;
      if (hv > h) h = hv;
    }
    bands[0][b] = l;
    bands[1][b] = m;
    bands[2][b] = h;
  }

  const [low, mid, high] = bands.map((band) => {
    const reference = percentile(band, NORMALISE_PERCENTILE);
    const scale = reference > 0 ? 255 / reference : 0;
    return Uint8Array.from(band, (v) => Math.min(255, Math.round(v * scale)));
  });
  return { binsPerSecond: sampleRate / binSize, low, mid, high };
}
