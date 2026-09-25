/**
 * Offline tempo and beat-grid detection.
 *
 * Pipeline:
 *   1. Onset-strength envelope: log-compressed energy flux in five bands, each
 *      normalised to equal weight and summed, at about 200 frames per second.
 *      Computed in one streaming pass, so memory is O(frames), not O(samples).
 *   2. Candidates: the strongest autocorrelation peaks over 60-200 BPM of a
 *      40 s excerpt, folded into [MIN_BPM, MAX_BPM), plus doubles and halves.
 *   3. Selection: a comb scored on the excerpt; the candidate whose beats carry
 *      the most onset energy wins.
 *   4. Octave check: a slow winner whose off-beats are strong is really twice
 *      as fast (drum and bass read as 87, or 140 house read as 70).
 *   5. Precision: the comb over the whole track, with a step scaled to its
 *      length so it cannot drift more than 4 ms end to end.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { LowPass } from './filters';

export interface BpmResult {
  /** Detected tempo, beats per minute, in [MIN_BPM, MAX_BPM). */
  bpm: number;
  /** Time of the first beat, seconds. */
  firstBeat: number;
  /** 0..1, how far beat positions stand out from the average envelope. */
  confidence: number;
}

export const MIN_BPM = 70;
/** Exclusive upper bound; 180 itself is a common hardcore/DnB tempo and must be reachable. */
export const MAX_BPM = 181;

/** Target envelope frame rate; the actual rate is sampleRate / round(sampleRate / this). */
const FRAME_RATE = 200;
/**
 * Off-beat / on-beat ratio above which a slow tempo is doubled. A comb at half
 * the true tempo still lands on every other beat, so its mean ties with the
 * true tempo's; only the strength of the beats it skips tells them apart.
 */
const DOUBLE_TIME_RATIO = 0.35;
/** Seconds of envelope used to rank candidates: long enough to separate them, short enough that a coarse step cannot drift off the beats. */
const EXCERPT_SECONDS = 40;
/** Largest drift, in seconds, the final tempo step may cause across the whole track. */
const MAX_DRIFT_SECONDS = 0.004;
/** Upper edges of the onset bands, Hz; everything above the last edge is the top band. */
const BAND_EDGES = [150, 600, 2500, 8000];

interface Envelope {
  values: Float32Array;
  /** Frames per second. */
  frameRate: number;
  /** Samples per frame. */
  hop: number;
}

/**
 * Onset-strength envelope of a mono signal.
 *
 * Exported for tests; most callers want detectBpm().
 */
export function onsetEnvelope(samples: Float32Array, sampleRate: number): Envelope {
  const hop = Math.max(1, Math.round(sampleRate / FRAME_RATE));
  const frames = Math.floor(samples.length / hop);
  const total = new Float32Array(frames);

  // One streaming pass: band b is lowPass(edge[b]) - lowPass(edge[b-1]), the
  // top band is the rest. Only per-frame levels are kept, never a filtered
  // copy of the track (a 10-minute track would otherwise need ~0.5 GB here).
  const filters = BAND_EDGES.filter((edge) => edge < sampleRate / 2).map((edge) => new LowPass(edge, sampleRate));
  const bands = filters.length + 1;
  const levels = Array.from({ length: bands }, () => new Float32Array(frames));
  const energy = new Float64Array(bands);
  for (let f = 0; f < frames; f++) {
    energy.fill(0);
    for (let i = f * hop, end = i + hop; i < end; i++) {
      const x = samples[i];
      let below = 0;
      for (let b = 0; b < filters.length; b++) {
        const upTo = filters[b].next(x);
        const v = upTo - below;
        energy[b] += v * v;
        below = upTo;
      }
      const top = x - below;
      energy[bands - 1] += top * top;
    }
    for (let b = 0; b < bands; b++) levels[b][f] = Math.log1p((1000 * energy[b]) / hop);
  }

  for (const level of levels) {
    let fluxSum = 0;
    for (let f = 1; f < frames; f++) fluxSum += Math.max(0, level[f] - level[f - 1]);
    // Normalise per band so quiet bands (hats, snares) count as much as the kick.
    const scale = fluxSum > 0 ? frames / fluxSum : 0;
    for (let f = 1; f < frames; f++) total[f] += Math.max(0, level[f] - level[f - 1]) * scale;
  }

  const smoothed = gaussianSmooth(total, 1.5);
  return { values: subtractLocalMean(smoothed, Math.round(FRAME_RATE * 0.25)), frameRate: sampleRate / hop, hop };
}

function gaussianSmooth(input: Float32Array, sigma: number): Float32Array {
  const radius = Math.ceil(sigma * 3);
  const kernel: number[] = [];
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < input.length) acc += input[j] * kernel[k + radius];
    }
    out[i] = acc / sum;
  }
  return out;
}

/** Remove slow level changes: subtract a moving average of +/- `radius` frames, clamp at 0. */
function subtractLocalMean(input: Float32Array, radius: number): Float32Array {
  const prefix = new Float64Array(input.length + 1);
  for (let i = 0; i < input.length; i++) prefix[i + 1] = prefix[i] + input[i];
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(input.length, i + radius + 1);
    const mean = (prefix[hi] - prefix[lo]) / (hi - lo);
    out[i] = Math.max(0, input[i] - mean);
  }
  return out;
}

/** Linear interpolation into the envelope at a fractional frame. */
function sampleAt(values: Float32Array, t: number): number {
  const i = Math.floor(t);
  if (i < 0 || i + 1 >= values.length) return 0;
  const frac = t - i;
  return values[i] * (1 - frac) + values[i + 1] * frac;
}

/** Mean envelope value at phase + k*period for all k. */
function combMean(values: Float32Array, period: number, phase: number): number {
  let sum = 0;
  let count = 0;
  for (let t = phase; t < values.length - 1; t += period) {
    sum += sampleAt(values, t);
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/** Best phase of a comb at `period` frames, searched in `step`-frame increments. */
function bestPhase(values: Float32Array, period: number, step: number): { phase: number; score: number } {
  let best = { phase: 0, score: -1 };
  for (let phase = 0; phase < period; phase += step) {
    const score = combMean(values, period, phase);
    if (score > best.score) best = { phase, score };
  }
  return best;
}

function foldBpm(bpm: number): number {
  let folded = bpm;
  while (folded < MIN_BPM) folded *= 2;
  while (folded >= MAX_BPM) folded /= 2;
  return folded;
}

/**
 * Candidate tempos from the autocorrelation: its strongest peaks, folded into
 * range, plus their double and half where those are in range too.
 *
 * The peaks alone are not trusted to pick the tempo. Syncopated patterns put
 * strong autocorrelation at 2/3 or 4/3 of the beat, so the comb decides.
 */
function tempoCandidates(env: Envelope, count = 5): number[] {
  const { values, frameRate } = env;
  const minLag = Math.floor((frameRate * 60) / 200);
  const maxLag = Math.ceil((frameRate * 60) / 60);
  if (values.length < maxLag * 4) return [];

  const acf = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < values.length; i++) sum += values[i] * values[i + lag];
    acf[lag] = sum / (values.length - lag);
  }

  const peaks: Array<{ lag: number; value: number }> = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (acf[lag] > 0 && acf[lag] >= acf[lag - 1] && acf[lag] > acf[lag + 1]) peaks.push({ lag, value: acf[lag] });
  }
  peaks.sort((x, y) => y.value - x.value);

  const candidates: number[] = [];
  const add = (bpm: number): void => {
    if (bpm < MIN_BPM || bpm >= MAX_BPM) return;
    if (candidates.every((c) => Math.abs(c - bpm) / c > 0.02)) candidates.push(bpm);
  };
  for (const { lag } of peaks.slice(0, count)) {
    // Parabolic interpolation around the peak for a sub-frame lag.
    const a = acf[lag - 1];
    const b = acf[lag];
    const c = acf[lag + 1];
    const denom = a - 2 * b + c;
    const offset = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const bpm = foldBpm((frameRate * 60) / (lag + offset));
    add(bpm);
    add(bpm * 2);
    add(bpm / 2);
  }
  return candidates;
}

/** Refine a tempo estimate by searching `bpm +/- span` in `step` increments. */
function refine(env: Envelope, bpm: number, span: number, step: number): { bpm: number; phase: number; score: number } {
  let best = { bpm, phase: 0, score: -1 };
  for (let candidate = bpm - span; candidate <= bpm + span + 1e-9; candidate += step) {
    if (candidate >= MAX_BPM) break;
    const period = (env.frameRate * 60) / candidate;
    const { phase, score } = bestPhase(env.values, period, 1);
    if (score > best.score) best = { bpm: candidate, phase, score };
  }
  return best;
}

/** Sub-frame phase around a whole-frame winner. */
function subFramePhase(env: Envelope, bpm: number, phase: number, score: number): { phase: number; score: number } {
  const period = (env.frameRate * 60) / bpm;
  let best = { phase, score };
  for (let p = phase - 1; p <= phase + 1; p += 0.1) {
    const wrapped = ((p % period) + period) % period;
    const s = combMean(env.values, period, wrapped);
    if (s > best.score) best = { phase: wrapped, score: s };
  }
  return best;
}

/** The middle `seconds` of an envelope (all of it when shorter). */
function excerpt(env: Envelope, seconds: number): Envelope {
  const length = Math.round(seconds * env.frameRate);
  if (env.values.length <= length) return env;
  const start = Math.floor((env.values.length - length) / 2);
  return { ...env, values: env.values.subarray(start, start + length) };
}

/**
 * Final precision over the whole track. The step shrinks with track length so
 * the comb never drifts more than MAX_DRIFT_SECONDS end to end: a fixed 0.05
 * BPM step drifts ~90 ms over a 4-minute track, enough for a 2/3-tempo
 * candidate to win.
 */
function wholeTrackTempo(env: Envelope, estimate: number): { bpm: number; phase: number; score: number } {
  const duration = env.values.length / env.frameRate;
  const step = Math.max(0.0005, (estimate * MAX_DRIFT_SECONDS) / duration);
  const fine = refine(env, estimate, Math.max(0.03, step * 4), step);
  return { bpm: fine.bpm, ...subFramePhase(env, fine.bpm, fine.phase, fine.score) };
}

/**
 * Detect tempo and first-beat offset of a mono signal.
 *
 * @param samples mono PCM, -1..1.
 * @param sampleRate sample rate of `samples`.
 * @returns the result, or null for silence or audio too short to analyse (under ~5 s).
 */
export function detectBpm(samples: Float32Array, sampleRate: number): BpmResult | null {
  const env = onsetEnvelope(samples, sampleRate);
  const part = excerpt(env, EXCERPT_SECONDS);
  const candidates = tempoCandidates(part);
  if (candidates.length === 0) return null;

  // Rank every candidate cheaply on the excerpt, refine the best two there.
  let best = candidates
    .map((bpm) => refine(part, bpm, bpm * 0.02, 0.1))
    .sort((x, y) => y.score - x.score)
    .slice(0, 2)
    .map((r) => refine(part, r.bpm, 0.12, 0.01))
    .reduce((top, r) => (r.score > top.score ? r : top));

  // Octave check: a comb at half the true tempo lands on every other beat and
  // can even out-score it when beats 2 and 4 carry kick plus snare, so the
  // mean alone cannot decide. Strong off-beats mean the tempo is double.
  if (best.bpm * 2 < MAX_BPM) {
    const period = (part.frameRate * 60) / best.bpm;
    const offBeat = combMean(part.values, period, best.phase + period / 2);
    if (offBeat > best.score * DOUBLE_TIME_RATIO) best = refine(part, best.bpm * 2, 0.12, 0.01);
  }

  const result = wholeTrackTempo(env, best.bpm);
  let mean = 0;
  for (let i = 0; i < env.values.length; i++) mean += env.values[i];
  mean /= env.values.length;
  if (result.score <= 0 || mean <= 0) return null;

  // Frame f summarises samples [f*hop, (f+1)*hop): report the frame centre.
  const firstBeat = ((result.phase + 0.5) * env.hop) / sampleRate;
  const confidence = Math.max(0, Math.min(1, (result.score - mean) / result.score));
  // Full precision: rounding to 0.01 BPM drifted a synced mix ~12 ms per 5
  // minutes, three times the detector's own budget. Round only for display.
  return { bpm: result.bpm, firstBeat, confidence };
}
