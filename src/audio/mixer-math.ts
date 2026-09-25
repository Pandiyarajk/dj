/**
 * Pure mixer curves: crossfader, channel fader and dB conversion.
 *
 * Kept free of Web Audio types so they can be unit-tested under Node.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-26-2026 (output ceiling curve)
 */

export type CrossfaderCurve = 'smooth' | 'sharp';

/** Width of the fade zone at each end of a "sharp" (scratch) crossfader, in fader units. */
const SHARP_EDGE = 0.1;

/**
 * Gains for deck A and deck B at a crossfader position.
 *
 * @param position -1 = full A, 0 = centre, +1 = full B.
 * @param curve "smooth" is equal-power (a² + b² = 1, both at -3 dB in the centre);
 *   "sharp" keeps both decks at full volume except in a narrow cut zone at each end.
 * @returns [gainA, gainB], each in 0..1.
 */
export function crossfaderGains(position: number, curve: CrossfaderCurve): [number, number] {
  const x = Math.max(-1, Math.min(1, position));
  if (curve === 'sharp') {
    const a = Math.min(1, (1 - x) / SHARP_EDGE);
    const b = Math.min(1, (1 + x) / SHARP_EDGE);
    return [a, b];
  }
  const angle = ((x + 1) / 2) * (Math.PI / 2);
  return [Math.cos(angle), Math.sin(angle)];
}

/**
 * Channel fader position to linear gain.
 *
 * A squared law approximates an audio-taper fader: the top half of travel
 * covers the last ~12 dB, where the ear actually needs resolution.
 *
 * @param position fader position, 0 (closed) .. 1 (full).
 * @returns linear gain, 0..1.
 */
export function faderGain(position: number): number {
  const p = Math.max(0, Math.min(1, position));
  return p * p;
}

/** Decibels to linear amplitude. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Linear amplitude to decibels; returns -Infinity for 0. */
export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

/**
 * Knob position to dB for a centre-detented gain knob.
 *
 * 0 -> minDb, 0.5 -> 0 dB, 1 -> maxDb, linear in dB on each side, so an EQ
 * with a deep cut and a small boost still has unity gain at 12 o'clock.
 */
export function centeredDbFromKnob(position: number, minDb: number, maxDb: number): number {
  const p = Math.max(0, Math.min(1, position));
  return p < 0.5 ? minDb * (1 - p / 0.5) : maxDb * ((p - 0.5) / 0.5);
}

/** Inverse of centeredDbFromKnob. */
export function knobFromCenteredDb(db: number, minDb: number, maxDb: number): number {
  if (db < 0) return 0.5 * (1 - Math.max(minDb, db) / minDb);
  return 0.5 + 0.5 * (Math.min(maxDb, db) / maxDb);
}

export interface FilterSetting {
  /** Low-pass cutoff, Hz; FILTER_OPEN_LOW means open. */
  lowpass: number;
  /** High-pass cutoff, Hz; FILTER_OPEN_HIGH means open. */
  highpass: number;
}

/** Cutoffs that leave the audio band untouched. */
export const FILTER_OPEN_LOW = 22000;
export const FILTER_OPEN_HIGH = 10;
/** Knob positions this close to centre bypass both filters. */
const FILTER_DEAD_ZONE = 0.03;

/**
 * One-knob DJ filter: left of centre sweeps a low-pass down, right of centre
 * sweeps a high-pass up, centre is flat. Both sweeps are logarithmic so the
 * knob feels even across its travel.
 *
 * @param position -1 (low-pass at its lowest) .. 0 (off) .. +1 (high-pass at its highest).
 */
export function filterFrequencies(position: number): FilterSetting {
  const p = Math.max(-1, Math.min(1, position));
  if (Math.abs(p) < FILTER_DEAD_ZONE) return { lowpass: FILTER_OPEN_LOW, highpass: FILTER_OPEN_HIGH };
  const amount = (Math.abs(p) - FILTER_DEAD_ZONE) / (1 - FILTER_DEAD_ZONE);
  if (p < 0) return { lowpass: 20000 * Math.pow(150 / 20000, amount), highpass: FILTER_OPEN_HIGH };
  return { lowpass: FILTER_OPEN_LOW, highpass: 20 * Math.pow(6000 / 20, amount) };
}

/** Input range the ceiling curve covers: a WaveShaper clamps beyond +/-1, so the input is scaled by 1/CEILING_RANGE first. */
export const CEILING_RANGE = 2;

/**
 * WaveShaper curve for the output ceiling after the limiter: linear up to
 * `kneeDb`, then bending smoothly (tanh) towards `ceilingDb`, which it never
 * exceeds. The limiter alone let fast transients through: two loud synced
 * decks peaked at +0.55 dBFS.
 *
 * The curve's input is the signal divided by CEILING_RANGE, so it covers
 * +/-2 (+6 dBFS) before the WaveShaper's own clamp applies.
 *
 * @param points curve length (odd, so 0 maps exactly to 0).
 */
export function ceilingCurve(kneeDb = -1, ceilingDb = -0.2, points = 4097): Float32Array {
  const knee = dbToGain(kneeDb);
  const room = dbToGain(ceilingDb) - knee;
  return Float32Array.from({ length: points }, (_, i) => {
    const x = ((i / (points - 1)) * 2 - 1) * CEILING_RANGE;
    const size = Math.abs(x);
    return size <= knee ? x : Math.sign(x) * (knee + room * Math.tanh((size - knee) / room));
  });
}
