/**
 * AudioWorklet processor for one deck: variable-rate playback of a loaded track.
 *
 * Owns the PCM, a fractional read head and the playback rate. Seeks, loops and
 * play/pause happen inside process(), so loops are sample-accurate and every
 * discontinuity is de-clicked with a short gain ramp.
 *
 * This file runs in the AudioWorkletGlobalScope and must not import anything:
 * it is loaded on its own via audioWorklet.addModule().
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (loop-wrap crossfade, ramped loop edits, seq on
 *   play/pause/ended, shared buffer for mono tracks)
 */

// AudioWorkletGlobalScope declarations. `declare` inside a module is
// module-scoped, so these do not leak into main-thread code.
declare const sampleRate: number;
declare const currentTime: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

/** Messages the main thread sends. Positions are in frames. */
export type DeckCommand =
  /** `right` is omitted for mono tracks, which then share one buffer. */
  | { type: 'load'; left: Float32Array; right?: Float32Array }
  | { type: 'unload' }
  /** `seq` makes position reports sent before this command stale. */
  | { type: 'play'; seq: number }
  | { type: 'pause'; seq: number }
  /**
   * Jump the read head. With `at` (a context time), `frame` is where the head
   * should be *at that time*: the processor adds however far playback has
   * moved past `at` when the jump actually lands, so sync is not thrown off
   * by message latency or the de-click ramp.
   */
  | { type: 'seek'; frame: number; seq: number; at?: number }
  | { type: 'rate'; rate: number }
  | { type: 'loop'; start: number; end: number }
  | { type: 'loopOff' };

/** Messages the processor sends back. */
export type DeckReport =
  | { type: 'position'; frame: number; time: number; playing: boolean; seq: number }
  | { type: 'ended'; seq: number };

/** Samples over which play/pause/seek fade (about 5 ms at 48 kHz). */
const RAMP_SAMPLES = 256;
/** Post a position report every this many render quanta (about 10 ms). */
const REPORT_EVERY = 4;
/**
 * Frames over which a loop wrap crossfades the loop end into the loop start
 * (about 3 ms). A hard wrap clicks unless both ends happen to meet at a zero
 * crossing, which only bar-aligned loops on clean material do.
 */
const LOOP_XFADE = 128;

interface PendingSeek {
  frame: number;
  at: number | null;
  /** Instead of `frame`: wrap the head into the (new) loop when the jump lands. */
  wrapIntoLoop?: boolean;
}

class DeckProcessor extends AudioWorkletProcessor {
  private left: Float32Array | null = null;
  private right: Float32Array | null = null;
  private length = 0;
  private head = 0;
  private rate = 1;
  private playing = false;
  private gain = 0;
  private loopStart = -1;
  private loopEnd = -1;
  private pendingSeek: PendingSeek | null = null;
  private seq = 0;
  private quanta = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<DeckCommand>) => this.handle(event.data);
  }

  private handle(command: DeckCommand): void {
    switch (command.type) {
      case 'load':
        this.left = command.left;
        this.right = command.right ?? command.left;
        this.length = command.left.length;
        this.head = 0;
        this.playing = false;
        this.gain = 0;
        this.loopStart = this.loopEnd = -1;
        this.pendingSeek = null;
        break;
      case 'unload':
        this.left = this.right = null;
        this.length = 0;
        this.playing = false;
        break;
      case 'play':
        this.seq = command.seq;
        if (this.left) this.playing = true;
        break;
      case 'pause':
        this.seq = command.seq;
        this.playing = false;
        break;
      case 'seek':
        this.seq = command.seq;
        // Silent already: jump now, so a seek while paused (or while the
        // context is suspended and process() is not running) lands at once.
        if (this.gain === 0) this.head = this.seekTarget({ frame: command.frame, at: command.at ?? null }, currentTime);
        else this.pendingSeek = { frame: command.frame, at: command.at ?? null };
        this.report();
        break;
      case 'rate':
        this.rate = command.rate;
        break;
      case 'loop':
        this.loopStart = command.start;
        this.loopEnd = command.end;
        // A loop edit (halve, reloop from later on) can leave the head past the
        // new end. Wrap it through the de-click ramp rather than on the next
        // sample, which would be a hard jump.
        if (this.head >= this.loopEnd) {
          if (this.gain === 0) this.head = this.wrapped(this.head);
          else this.pendingSeek = { frame: 0, at: null, wrapIntoLoop: true };
        }
        break;
      case 'loopOff':
        this.loopStart = this.loopEnd = -1;
        break;
    }
  }

  private clamp(frame: number): number {
    return Math.max(0, Math.min(this.length - 1, frame));
  }

  /** `frame` folded into the active loop. */
  private wrapped(frame: number): number {
    const span = this.loopEnd - this.loopStart;
    return frame >= this.loopEnd && span > 0 ? this.loopStart + ((frame - this.loopStart) % span) : frame;
  }

  /** Head position for a seek landing at context time `now`. */
  private seekTarget(seek: PendingSeek, now: number): number {
    if (seek.wrapIntoLoop) return this.wrapped(this.head);
    // Only a playing deck moves on between `at` and now; a paused one starts from `frame`.
    const late = seek.at !== null && this.playing ? (now - seek.at) * sampleRate * this.rate : 0;
    return this.clamp(seek.frame + late);
  }

  private report(): void {
    // A pending seek reports where the head will be now, not where it was at `at`.
    const pending = this.pendingSeek;
    const frame = pending && !pending.wrapIntoLoop ? this.seekTarget(pending, currentTime) : this.head;
    this.port.postMessage({ type: 'position', frame, time: currentTime, playing: this.playing, seq: this.seq } satisfies DeckReport);
  }

  /** 4-point Hermite interpolation of `data` at fractional index `x`. */
  private static sample(data: Float32Array, x: number, last: number): number {
    const i = Math.floor(x);
    const t = x - i;
    const y0 = data[i > 0 ? i - 1 : 0];
    const y1 = data[i];
    const y2 = data[i + 1 <= last ? i + 1 : last];
    const y3 = data[i + 2 <= last ? i + 2 : last];
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * t + c2) * t + c1) * t + y1;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const outL = outputs[0][0];
    const outR = outputs[0][1] ?? outL;
    // Report the head as it was at the start of this block, which is what
    // `currentTime` refers to.
    if (++this.quanta % REPORT_EVERY === 0) this.report();

    const left = this.left;
    const right = this.right;
    if (!left || !right) {
      outL.fill(0);
      outR.fill(0);
      return true;
    }

    const last = this.length - 1;
    const step = 1 / RAMP_SAMPLES;
    const looping = this.loopEnd > this.loopStart && this.loopStart >= 0;
    const span = this.loopEnd - this.loopStart;
    // The crossfade reads LOOP_XFADE frames before the loop start, so the loop
    // must leave room for it on both sides.
    const xfadeFrom = looping && span > 2 * LOOP_XFADE && this.loopStart >= LOOP_XFADE ? this.loopEnd - LOOP_XFADE : Infinity;

    for (let i = 0; i < outL.length; i++) {
      const target = this.playing && this.pendingSeek === null ? 1 : 0;
      if (this.gain < target) this.gain = Math.min(target, this.gain + step);
      else if (this.gain > target) this.gain = Math.max(target, this.gain - step);

      if (this.gain === 0) {
        if (this.pendingSeek !== null) {
          this.head = this.seekTarget(this.pendingSeek, currentTime + i / sampleRate);
          this.pendingSeek = null;
        }
        outL[i] = 0;
        outR[i] = 0;
        continue;
      }

      let l = DeckProcessor.sample(left, this.head, last);
      let r = DeckProcessor.sample(right, this.head, last);
      if (this.head >= xfadeFrom) {
        // Equal-power crossfade into the audio just before the loop start, which
        // the head continues from after the wrap below: no discontinuity.
        const w = ((this.head - xfadeFrom) / LOOP_XFADE) * (Math.PI / 2);
        const out = Math.cos(w);
        const into = Math.sin(w);
        const echo = this.head - span;
        l = l * out + DeckProcessor.sample(left, echo, last) * into;
        r = r * out + DeckProcessor.sample(right, echo, last) * into;
      }
      outL[i] = l * this.gain;
      outR[i] = r * this.gain;

      this.head += this.rate;
      if (looping && this.head >= this.loopEnd) this.head = this.wrapped(this.head);
      if (this.head >= last) {
        this.head = last;
        // Only once: the fade-out keeps this branch running for RAMP_SAMPLES.
        if (this.playing) {
          this.playing = false;
          this.port.postMessage({ type: 'ended', seq: this.seq } satisfies DeckReport);
        }
      } else if (this.head < 0) {
        this.head = 0;
      }
    }
    return true;
  }
}

registerProcessor('deck-processor', DeckProcessor);
