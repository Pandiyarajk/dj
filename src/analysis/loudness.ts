/**
 * Integrated loudness (ITU-R BS.1770-4 / EBU R128) and peak, for auto-gain.
 *
 * K-weighting (a high shelf plus the RLB high-pass) per channel, mean square
 * in 400 ms blocks with 75% overlap, an absolute gate at -70 LUFS and a
 * relative gate 10 LU below the gated mean. Streaming: memory is one value
 * per 100 ms, whatever the track length.
 *
 * Measured on the real channels: BS.1770 on a mono downmix is wrong by +3 dB
 * (fully correlated audio) to -6 dB (uncorrelated), depending on stereo width.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */

/** Direct-form biquad with state, fed one sample at a time. */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}

  next(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** The two K-weighting stages for a sample rate (BS.1770 coefficients, derived per rate). */
function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: high shelf, about +4 dB above 1.5 kHz (models the head).
  let f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  let a0 = 1 + k / q + k * k;
  const shelf = new Biquad((vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0);
  // Stage 2: the RLB high-pass at about 38 Hz.
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + k / q + k * k;
  const highpass = new Biquad(1, -2, 1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0);
  return [shelf, highpass];
}

export interface Loudness {
  /** Integrated loudness, LUFS; -Infinity for silence. */
  lufs: number;
  /** Highest sample peak across channels, dBFS. */
  peakDb: number;
}

const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = 10;

function blockLoudness(meanSquare: number): number {
  return meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity;
}

/**
 * Integrated loudness and peak of a (stereo or mono) signal.
 *
 * @param channels one Float32Array per channel, equal lengths.
 */
export function measureLoudness(channels: Float32Array[], sampleRate: number): Loudness {
  const step = Math.round(sampleRate * 0.1);
  const length = channels[0]?.length ?? 0;
  const steps = Math.floor(length / step);
  // Sum over channels of each channel's mean square, per 100 ms step.
  const power = new Float64Array(steps);
  let peak = 0;
  for (const data of channels) {
    const [shelf, highpass] = kWeighting(sampleRate);
    for (let s = 0; s < steps; s++) {
      let sum = 0;
      for (let i = s * step, end = i + step; i < end; i++) {
        const x = data[i];
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
        const y = highpass.next(shelf.next(x));
        sum += y * y;
      }
      power[s] += sum / step;
    }
  }

  // 400 ms blocks = 4 steps, hopping one step (75% overlap).
  const blocks: number[] = [];
  for (let s = 0; s + 4 <= steps; s++) blocks.push((power[s] + power[s + 1] + power[s + 2] + power[s + 3]) / 4);
  const loud = blocks.filter((z) => blockLoudness(z) > ABSOLUTE_GATE);
  if (loud.length === 0) return { lufs: -Infinity, peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity };
  const threshold = blockLoudness(loud.reduce((a, b) => a + b, 0) / loud.length) - RELATIVE_GATE;
  const gated = loud.filter((z) => blockLoudness(z) > threshold);
  const lufs = blockLoudness(gated.reduce((a, b) => a + b, 0) / gated.length);
  return { lufs, peakDb: 20 * Math.log10(peak) };
}

/** Loudness the auto-gain brings every track to, LUFS (club masters sit around -8). */
export const AUTO_GAIN_TARGET = -10;
const MAX_ADJUST_DB = 12;
/** Boosts stop so the peak stays below this, dBFS: otherwise the limiter pumps. */
const PEAK_CEILING = -1;

/**
 * Gain that brings a track to AUTO_GAIN_TARGET, in dB: clamped to +/-12 dB,
 * and a boost never pushes the peak above the ceiling. 0 for silence.
 */
export function autoGainDb(loudness: Loudness | null): number {
  if (!loudness || !Number.isFinite(loudness.lufs)) return 0;
  let gain = Math.max(-MAX_ADJUST_DB, Math.min(MAX_ADJUST_DB, AUTO_GAIN_TARGET - loudness.lufs));
  if (gain > 0 && Number.isFinite(loudness.peakDb)) gain = Math.min(gain, Math.max(0, PEAK_CEILING - loudness.peakDb));
  return gain;
}
