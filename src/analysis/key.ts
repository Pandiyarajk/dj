/**
 * Musical key detection: chroma from short-time spectra, matched against
 * Temperley key profiles, reported in standard and Camelot notation.
 *
 * Expect roughly 60-70% exact on electronic music; most misses are the
 * relative major/minor or a fifth away, which are Camelot neighbours and
 * still mix harmonically.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { LowPass } from './filters';

export interface KeyResult {
  /** "A minor", "F# major". */
  name: string;
  /** Camelot wheel code, "8A". */
  camelot: string;
  /** Correlation margin over the runner-up, 0..1 (small = ambiguous). */
  confidence: number;
  /** Correlation with the winning key profile, -1..1 (how key-like the audio is at all). */
  strength: number;
}

const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
/** Camelot number per tonic pitch class (C = 0). */
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

/** Temperley (2007) key profiles, tonic first. */
const MAJOR = [0.748, 0.06, 0.488, 0.082, 0.67, 0.46, 0.096, 0.715, 0.104, 0.366, 0.057, 0.4];
const MINOR = [0.712, 0.084, 0.474, 0.618, 0.049, 0.46, 0.105, 0.747, 0.404, 0.067, 0.133, 0.33];

const TARGET_RATE = 11025;
const FFT_SIZE = 4096;
const HOP = 2048;
const MIN_HZ = 100;
const MAX_HZ = 2000;

/** In-place iterative radix-2 FFT of (re, im); length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Average chroma (12 pitch classes, C first) of a mono signal. */
export function chroma(samples: Float32Array, sampleRate: number): number[] {
  const factor = Math.max(1, Math.floor(sampleRate / TARGET_RATE));
  const rate = sampleRate / factor;
  // Anti-alias, then decimate, streaming.
  const filter = new LowPass(rate * 0.4, sampleRate, 4);
  const down = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0, j = 0; j < down.length; i++) {
    const y = filter.next(samples[i]);
    if (i % factor === factor - 1) down[j++] = y;
  }

  // Precompute bin -> (pitch class, weight): weight falls off away from the
  // nearest equal-tempered pitch, so energy between notes counts little.
  const map: Array<[number, number] | null> = [];
  for (let k = 0; k < FFT_SIZE / 2; k++) {
    const f = (k * rate) / FFT_SIZE;
    if (f < MIN_HZ || f > MAX_HZ) {
      map.push(null);
      continue;
    }
    const pitch = 12 * Math.log2(f / 440) + 69;
    const nearest = Math.round(pitch);
    const off = Math.abs(pitch - nearest);
    map.push([((nearest % 12) + 12) % 12, Math.cos(Math.PI * off) ** 2]);
  }
  const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const total = new Array<number>(12).fill(0);

  for (let start = 0; start + FFT_SIZE <= down.length; start += HOP) {
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = down[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    const frame = new Array<number>(12).fill(0);
    let sum = 0;
    for (let k = 0; k < FFT_SIZE / 2; k++) {
      const m = map[k];
      if (!m) continue;
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      frame[m[0]] += mag * m[1];
      sum += mag * m[1];
    }
    // Normalise per frame, so loud sections do not outvote the rest.
    if (sum > 1e-9) for (let p = 0; p < 12; p++) total[p] += frame[p] / sum;
  }
  return total;
}

/** Key from a chroma vector; null when there is no tonal content. */
export function keyFromChroma(chromaVector: number[]): KeyResult | null {
  if (chromaVector.every((v) => v === 0)) return null;
  const scores: Array<{ tonic: number; minor: boolean; r: number }> = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = chromaVector.map((_, i) => chromaVector[(i + tonic) % 12]);
    scores.push({ tonic, minor: false, r: pearson(rotated, MAJOR) });
    scores.push({ tonic, minor: true, r: pearson(rotated, MINOR) });
  }
  scores.sort((a, b) => b.r - a.r);
  const [best, next] = scores;
  const name = `${NOTES[best.tonic]} ${best.minor ? 'minor' : 'major'}`;
  const camelot = `${(best.minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[best.tonic]}${best.minor ? 'A' : 'B'}`;
  return { name, camelot, confidence: Math.max(0, Math.min(1, best.r - next.r)), strength: best.r };
}

/**
 * Below this correlation with the best key profile the audio has no key at
 * all: noise and DC measured 0.31-0.32, the corpus tracks 0.40-0.94.
 */
const MIN_STRENGTH = 0.36;

/** Detect the key of a mono signal; null for silence and for noise-like audio. */
export function detectKey(samples: Float32Array, sampleRate: number): KeyResult | null {
  const result = keyFromChroma(chroma(samples, sampleRate));
  return result && result.strength >= MIN_STRENGTH ? result : null;
}

/**
 * Camelot codes that mix harmonically with `code`: the same code, one step
 * round the wheel either way, and the relative major/minor.
 */
export function compatibleKeys(code: string): string[] {
  const match = /^(\d{1,2})([AB])$/.exec(code);
  if (!match) return [];
  const n = Number(match[1]);
  const letter = match[2];
  const wrap = (v: number): number => ((v - 1 + 12) % 12) + 1;
  return [code, `${wrap(n - 1)}${letter}`, `${wrap(n + 1)}${letter}`, `${n}${letter === 'A' ? 'B' : 'A'}`];
}
