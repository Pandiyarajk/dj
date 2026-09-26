/**
 * Offline tempo and beat-grid detection.
 *
 * Pipeline:
 *   1. Onset-strength envelope: log-compressed energy flux in five bands, each
 *      normalised to equal weight and summed, at about 200 frames per second.
 *      Computed in one streaming pass, so memory is O(frames), not O(samples).
 *   2. Candidates: the strongest autocorrelation peaks over 60-200 BPM of each
 *      40 s window (20 s apart), folded into [MIN_BPM, MAX_BPM), plus doubles
 *      and halves.
 *   3. Selection: in each window, a comb scored on the window picks a local
 *      tempo; windows with a clear beat vote, and the tempo that covers the
 *      most of the track wins. A track whose windows disagree is flagged as
 *      changing tempo (its grid follows the main tempo).
 *   4. Octave choice: half, same and double tempo are weighed by their comb
 *      score times a tempo prior centred on 135 BPM.
 *   5. Precision: the comb over the whole track, with a step scaled to its
 *      length so it cannot drift more than 4 ms end to end.
 *   6. Beat gate, three checks that each catch what the others miss: enough
 *      onset strength at all (steady tones), a grid that stands out from the
 *      same comb at every other phase (noise), and from the envelope's mean
 *      (beatless music). Otherwise the track has no steady beat.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-26-2026 (phase z-score gate added; onset-strength gate
 *   lowered from 0.8 to 0.5, which rejected three of ten real songs;
 *   tempo voted across windows, so a song that changes tempo follows its
 *   main tempo and is flagged)
 */
import { LowPass } from './filters';

export interface BpmResult {
  /** Detected tempo, beats per minute, in [MIN_BPM, MAX_BPM). */
  bpm: number;
  /** Time of the first beat, seconds. */
  firstBeat: number;
  /** 0..1, how far beat positions stand out from the average envelope. */
  confidence: number;
  /** Part of the track has a different tempo (the grid follows the main one). */
  tempoChanges: boolean;
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
/** Centre and width (in octaves) of the tempo prior used for the octave choice. */
const PRIOR_BPM = 135;
const PRIOR_OCTAVES = 0.75;
/** Below this beat confidence the track is treated as having no steady beat. */
const MIN_CONFIDENCE = 0.6;
/**
 * Below this mean onset strength there are no real onsets at all: steady
 * tones and square waves measured 0.05-0.30, real mastered songs 0.71-1.09.
 * It was 0.8, tuned on synthetic tracks (1.5-2.5), and rejected three of ten
 * real songs whose tempo was right.
 */
const MIN_ENVELOPE = 0.5;
/**
 * How far the winning grid's comb score must stand above the same comb at
 * every other phase, in standard deviations. Noise measured 1.85-2.47 (white
 * noise has onset strength 0.57, brown noise 0.92, which read 131.5 BPM), real
 * songs 2.91-6.39, synthetic beat tracks 4.0-6.1.
 */
const MIN_PHASE_Z = 2.7;
/** Phase step for the z-score, frames. */
const PHASE_Z_STEP = 0.5;
/** Seconds of envelope used to rank candidates: long enough to separate them, short enough that a coarse step cannot drift off the beats. */
const EXCERPT_SECONDS = 40;
/** Step between tempo windows, seconds (windows overlap by half). */
const WINDOW_HOP_SECONDS = 20;
/** A window votes only when its beat stands out this clearly (beatless stretches do not vote). */
const MIN_WINDOW_CONFIDENCE = 0.55;
/** Local tempos within this fraction of each other are the same tempo. */
const TEMPO_TOLERANCE = 0.02;
/**
 * Another tempo holding at least this share of the voting windows means the
 * track changes tempo. A film song at 98 BPM with a 135 BPM finale read 135
 * when only the loudest 40 s were used (the finale was the loudest part).
 */
const TEMPO_CHANGE_SHARE = 0.2;
/**
 * Tempo ratios that are the same pulse felt differently (triplet feel, 6/8):
 * windows alternating 96/144 or 110/147 are one ambiguous metre, not a
 * tempo change.
 */
const METRIC_RATIOS = [3 / 2, 4 / 3];
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

/**
 * The `seconds`-long stretch with the most onset energy (all of it when
 * shorter). The middle of the track is often a beatless breakdown: on the
 * corpus breakdown track the middle 40 s were 75% beatless.
 */
function excerpt(env: Envelope, seconds: number): Envelope {
  const length = Math.round(seconds * env.frameRate);
  const values = env.values;
  if (values.length <= length) return env;
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i] + values[i];
  const step = Math.max(1, Math.round(env.frameRate * 2));
  let best = 0;
  let bestEnergy = -1;
  for (let start = 0; start + length <= values.length; start += step) {
    const energy = prefix[start + length] - prefix[start];
    if (energy > bestEnergy) {
      bestEnergy = energy;
      best = start;
    }
  }
  return { ...env, values: values.subarray(best, best + length) };
}

/** How many standard deviations the comb at `phase` stands above the same comb at every phase. */
function phaseZ(values: Float32Array, period: number, score: number): number {
  let sum = 0;
  let squares = 0;
  let count = 0;
  for (let phase = 0; phase < period; phase += PHASE_Z_STEP) {
    const s = combMean(values, period, phase);
    sum += s;
    squares += s * s;
    count++;
  }
  const mean = sum / count;
  const sd = Math.sqrt(Math.max(0, squares / count - mean * mean));
  return sd > 0 ? (score - mean) / sd : 0;
}

/** Tempo prior: a log-normal preference around PRIOR_BPM (DJ music clusters there). */
function prior(bpm: number): number {
  const octaves = Math.log2(bpm / PRIOR_BPM);
  return Math.exp(-0.5 * (octaves / PRIOR_OCTAVES) ** 2);
}

/**
 * Final precision over the whole track. The step shrinks with track length so
 * the comb never drifts more than MAX_DRIFT_SECONDS end to end: a fixed 0.05
 * BPM step drifts ~90 ms over a 4-minute track, enough for a 2/3-tempo
 * candidate to win.
 */
function wholeTrackTempo(env: Envelope, estimate: number, spread = 0): { bpm: number; phase: number; score: number } {
  const duration = env.values.length / env.frameRate;
  const step = Math.max(0.0005, (estimate * MAX_DRIFT_SECONDS) / duration);
  // Never wider than 1% either way: the search is whole-track and fine-stepped.
  const span = Math.min(estimate * 0.01, Math.max(0.03, step * 4, spread / 2 + 0.03));
  const fine = refine(env, estimate, span, step);
  return { bpm: fine.bpm, ...subFramePhase(env, fine.bpm, fine.phase, fine.score) };
}

interface LocalTempo {
  bpm: number;
  score: number;
  confidence: number;
}

/** The best tempo of one stretch of envelope: candidates, comb ranking, refinement, octave choice. */
function localTempo(part: Envelope): LocalTempo | null {
  const candidates = tempoCandidates(part);
  if (candidates.length === 0) return null;

  // Rank every candidate cheaply on the stretch, refine the best two there.
  let best = candidates
    .map((bpm) => refine(part, bpm, bpm * 0.02, 0.1))
    .sort((x, y) => y.score - x.score)
    .slice(0, 2)
    .map((r) => refine(part, r.bpm, 0.12, 0.01))
    .reduce((top, r) => (r.score > top.score ? r : top));

  // Octave choice: a comb at half the true tempo lands on every other beat
  // and often out-scores it, and no off-beat threshold separates "half-time
  // 140" from "90 with eighth-note hats" (same pattern, different tempo).
  // Weigh each octave's comb score by a tempo prior instead.
  const octaves = [best.bpm / 2, best.bpm, best.bpm * 2].filter((b) => b >= MIN_BPM && b < MAX_BPM);
  best = octaves
    .map((b) => (b === best.bpm ? best : refine(part, b, 0.12, 0.01)))
    .reduce((top, r) => (r.score * prior(r.bpm) > top.score * prior(top.bpm) ? r : top));

  let mean = 0;
  for (let i = 0; i < part.values.length; i++) mean += part.values[i];
  mean /= part.values.length;
  const confidence = best.score > 0 ? (best.score - mean) / best.score : 0;
  return { bpm: best.bpm, score: best.score, confidence };
}

/** Overlapping windows across the whole envelope; empty when the track is too short for two. */
function tempoWindows(env: Envelope): Envelope[] {
  const length = Math.round(EXCERPT_SECONDS * env.frameRate);
  const hop = Math.round(WINDOW_HOP_SECONDS * env.frameRate);
  if (env.values.length < length + hop) return [];
  const windows: Envelope[] = [];
  for (let start = 0; start + length <= env.values.length; start += hop) windows.push({ ...env, values: env.values.subarray(start, start + length) });
  // The tail, so the end of the track votes too.
  const tail = env.values.length - length;
  if (tail % hop !== 0) windows.push({ ...env, values: env.values.subarray(tail) });
  return windows;
}

/**
 * The tempo that covers the most of the track, from each window's local
 * tempo. Octaves count as the same tempo for the vote (so a window that read
 * half time does not split it); the octave most windows chose wins.
 *
 * @returns the estimate and whether a second tempo holds a real share, or
 *   null when no window has a clear beat.
 */
function votedTempo(windows: Envelope[]): { bpm: number; low: number; high: number; tempoChanges: boolean } | null {
  const votes = windows.map(localTempo).filter((t): t is LocalTempo => t !== null && t.confidence >= MIN_WINDOW_CONFIDENCE);
  if (votes.length === 0) return null;
  const fold = (bpm: number): number => {
    let f = bpm;
    while (f < PRIOR_BPM / Math.SQRT2) f *= 2;
    while (f >= PRIOR_BPM * Math.SQRT2) f /= 2;
    return f;
  };
  // Greedy clusters on the octave-folded tempo.
  const clusters: { folded: number; members: LocalTempo[] }[] = [];
  for (const vote of [...votes].sort((a, b) => fold(a.bpm) - fold(b.bpm))) {
    const folded = fold(vote.bpm);
    const cluster = clusters.find((c) => Math.abs(folded - c.folded) / c.folded <= TEMPO_TOLERANCE);
    if (cluster) cluster.members.push(vote);
    else clusters.push({ folded, members: [vote] });
  }
  clusters.sort((a, b) => b.members.length - a.members.length || b.members.reduce((s, m) => s + m.score, 0) - a.members.reduce((s, m) => s + m.score, 0));
  const main = clusters[0];
  // The octave most of the main tempo's windows chose, then their median tempo in it.
  const byOctave = new Map<number, LocalTempo[]>();
  for (const m of main.members) {
    const octave = Math.round(Math.log2(m.bpm / main.folded));
    byOctave.set(octave, [...(byOctave.get(octave) ?? []), m]);
  }
  const chosen = [...byOctave.values()].sort((a, b) => b.length - a.length)[0];
  const sorted = chosen.map((m) => m.bpm).sort((a, b) => a - b);
  const bpm = sorted[Math.floor(sorted.length / 2)];
  const metric = (a: number, b: number): boolean => {
    const ratio = Math.max(a, b) / Math.min(a, b);
    return METRIC_RATIOS.some((r) => Math.abs(ratio - r) / r <= TEMPO_TOLERANCE);
  };
  const tempoChanges = clusters.slice(1).some((c) => c.members.length / votes.length >= TEMPO_CHANGE_SHARE && !metric(c.folded, main.folded));
  // The spread of the main tempo's windows: a drifting live drummer reads
  // 109.1-110.9 across windows, and the whole-track search must cover it.
  return { bpm, low: sorted[0], high: sorted[sorted.length - 1], tempoChanges };
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
  // Vote across the track; short tracks (or no clear window) fall back to the
  // stretch with the most onset energy.
  let estimate: number;
  let spread = 0;
  let tempoChanges = false;
  const voted = votedTempo(tempoWindows(env));
  if (voted) {
    estimate = (voted.low + voted.high) / 2;
    spread = voted.high - voted.low;
    tempoChanges = voted.tempoChanges;
  } else {
    const local = localTempo(excerpt(env, EXCERPT_SECONDS));
    if (!local) return null;
    estimate = local.bpm;
  }

  const result = wholeTrackTempo(env, estimate, spread);
  let mean = 0;
  for (let i = 0; i < env.values.length; i++) mean += env.values[i];
  mean /= env.values.length;
  if (result.score <= 0 || mean < MIN_ENVELOPE) return null;
  if (phaseZ(env.values, (env.frameRate * 60) / result.bpm, result.score) < MIN_PHASE_Z) return null;

  // Onset flux peaks at the frame where the energy jump starts: reporting the
  // frame centre (+half a hop) put every grid 2.0-4.0 ms late on the corpus.
  const firstBeat = (result.phase * env.hop) / sampleRate;
  const confidence = Math.max(0, Math.min(1, (result.score - mean) / result.score));
  // Beatless music still gives some comb peak: a real beat stands out far
  // more (0.84-0.95 on the corpus beat tracks, 0.39 on the ambient one).
  if (confidence < MIN_CONFIDENCE) return null;
  // Full precision: rounding to 0.01 BPM drifted a synced mix ~12 ms per 5
  // minutes, three times the detector's own budget. Round only for display.
  return { bpm: result.bpm, firstBeat, confidence, tempoChanges };
}
