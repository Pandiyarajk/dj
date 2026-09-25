/**
 * Minimal one-pole filters used by the offline analysers.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (streaming form, so analysis never holds full-length filtered copies)
 */

/** Coefficient for a one-pole low-pass at `cutoffHz`. */
function onePoleCoefficient(cutoffHz: number, sampleRate: number): number {
  return 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

/**
 * Streaming low-pass: `stages` cascaded one-pole filters (6 dB/octave each).
 *
 * Feed it one sample at a time; memory is O(stages), whatever the track length.
 */
export class LowPass {
  private readonly a: number;
  private readonly state: Float64Array;

  constructor(cutoffHz: number, sampleRate: number, stages = 2) {
    this.a = onePoleCoefficient(cutoffHz, sampleRate);
    this.state = new Float64Array(stages);
  }

  next(x: number): number {
    let v = x;
    for (let s = 0; s < this.state.length; s++) {
      this.state[s] += this.a * (v - this.state[s]);
      v = this.state[s];
    }
    return v;
  }
}

/**
 * Low-pass a whole buffer.
 *
 * @returns a new array; `input` is not modified.
 */
export function lowPass(input: Float32Array, cutoffHz: number, sampleRate: number, stages = 2): Float32Array {
  const filter = new LowPass(cutoffHz, sampleRate, stages);
  return Float32Array.from(input, (x) => filter.next(x));
}
