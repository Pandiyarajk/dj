/**
 * Minimal one-pole filters used by the offline analysers.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */

/** Coefficient for a one-pole low-pass at `cutoffHz`. */
function onePoleCoefficient(cutoffHz: number, sampleRate: number): number {
  return 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

/**
 * Low-pass `input` with `stages` cascaded one-pole filters (6 dB/octave each).
 *
 * @returns a new array; `input` is not modified.
 */
export function lowPass(input: Float32Array, cutoffHz: number, sampleRate: number, stages = 2): Float32Array {
  const a = onePoleCoefficient(cutoffHz, sampleRate);
  const out = new Float32Array(input);
  for (let s = 0; s < stages; s++) {
    let y = 0;
    for (let i = 0; i < out.length; i++) {
      y += a * (out[i] - y);
      out[i] = y;
    }
  }
  return out;
}
