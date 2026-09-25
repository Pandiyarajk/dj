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
 *   play/pause/ended, shared buffer for mono tracks, key lock by WSOLA)
 * Modified: Sep-26-2026 (loop crossfade under key lock, crossfaded jumps,
 *   centred grain search, reverse stays in the loop, rate slew)
 *
 * Key lock (tempo without pitch change) is WSOLA: the read head still moves
 * at `rate` (so positions, sync and loops are unchanged), and the output is
 * rebuilt from Hann-windowed grains read at normal speed around the head,
 * each placed where it best continues the previous grain. The search is
 * kept to +/-2.7 ms so kicks do not flam against the other deck.
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
  | { type: 'loopOff' }
  | { type: 'keyLock'; on: boolean };

/** Messages the processor sends back. */
export type DeckReport =
  | { type: 'position'; frame: number; time: number; playing: boolean; seq: number }
  | { type: 'ended'; seq: number };

/** Samples over which play/pause fade and jumps crossfade (about 5 ms at 48 kHz). */
const RAMP_SAMPLES = 256;
/** Post a position report every this many render quanta (about 10 ms). */
const REPORT_EVERY = 4;
/**
 * Frames over which a loop wrap crossfades the loop end into the loop start
 * (about 11 ms; short loops use a quarter of their length). A hard wrap
 * clicks unless both ends happen to meet at a zero crossing, which only
 * bar-aligned loops on clean material do. 512 measured 11 dB cleaner than 128.
 */
const LOOP_XFADE = 512;
/**
 * Largest rate change per sample. An instant step (a scratch reversal from
 * a controller) clicks; this spreads a full -1 to +1 swing over 10 ms and a
 * tempo change over a few samples.
 */
const RATE_SLEW = 1 / 240;

interface PendingSeek {
  frame: number;
  at: number | null;
  /** Instead of `frame`: wrap the head into the (new) loop when the jump lands. */
  wrapIntoLoop?: boolean;
}

/** WSOLA grain length and hop (50% overlap: Hann windows sum to exactly 1). */
const GRAIN = 1024;
const HOP = GRAIN / 2;
/** Search range for the best grain placement, frames (about 2.7 ms at 48 kHz). */
const SEARCH = 128;
/** Frames compared when scoring a placement (every second one). */
const COMPARE = 256;
/**
 * Score cost of the search edge relative to the target, so ties and near-ties
 * go to the placement closest to the head. Without it, silence (all scores
 * equal) left grains a fixed 128 frames late, and the natural continuation
 * drifted the placement to the edge of the search at every hop.
 */
const DRIFT_PENALTY = 0.15;
/** Reference energy below which there is nothing to match: place at the head. */
const SILENCE = 1e-7;
const WINDOW = Float32Array.from({ length: GRAIN }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / GRAIN));

class DeckProcessor extends AudioWorkletProcessor {
  private left: Float32Array | null = null;
  private right: Float32Array | null = null;
  private length = 0;
  private head = 0;
  private rate = 1;
  private targetRate = 1;
  private playing = false;
  private gain = 0;
  private loopStart = -1;
  private loopEnd = -1;
  /** Loop-wrap crossfade length for the current loop, frames (0 = none). */
  private loopFade = 0;
  private pendingSeek: PendingSeek | null = null;
  private seq = 0;
  private quanta = 0;
  // Key lock (WSOLA) state.
  private keyLock = false;
  private readonly blockL = new Float32Array(HOP);
  private readonly blockR = new Float32Array(HOP);
  private readonly tailL = new Float32Array(HOP);
  private readonly tailR = new Float32Array(HOP);
  private blockPos = HOP;
  /** Start of the previous grain, or -1 after a reset (nothing to continue). */
  private prevStart = -1;
  private readonly searchBuf = new Float32Array(2 * SEARCH + COMPARE);
  private readonly refBuf = new Float32Array(COMPARE / 2);
  // Jump crossfade: the old read position fades out while the new one fades in.
  private fadeFrom = 0;
  private fadeStep = 1;
  private fadePos = RAMP_SAMPLES;

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
        this.loopFade = 0;
        this.pendingSeek = null;
        this.fadePos = RAMP_SAMPLES;
        this.resetStretch();
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
      case 'seek': {
        this.seq = command.seq;
        const seek = { frame: command.frame, at: command.at ?? null };
        // Silent already: jump now, so a seek while paused (or while the
        // context is suspended and process() is not running) lands at once.
        if (this.gain === 0) {
          this.head = this.seekTarget(seek, currentTime);
          this.resetStretch();
        } else if (this.playing) this.jump(this.seekTarget(seek, currentTime));
        // Fading out for a pause: land when silent.
        else this.pendingSeek = seek;
        this.report();
        break;
      }
      case 'rate':
        this.targetRate = command.rate;
        // Nothing audible to smooth: take the new rate at once.
        if (this.gain === 0) this.rate = command.rate;
        break;
      case 'loop': {
        this.loopStart = command.start;
        this.loopEnd = command.end;
        const fade = Math.min(LOOP_XFADE, Math.floor((command.end - command.start) / 4), Math.floor(command.start));
        this.loopFade = fade >= 16 ? fade : 0;
        // A loop edit (halve, reloop from later on) can leave the head past the
        // new end. Crossfade it back in rather than jumping on the next sample.
        if (this.head >= this.loopEnd) {
          if (this.gain === 0) this.head = this.wrapped(this.head);
          else if (this.playing) this.jump(this.wrapped(this.head));
          else this.pendingSeek = { frame: 0, at: null, wrapIntoLoop: true };
        }
        break;
      }
      case 'loopOff':
        this.loopStart = this.loopEnd = -1;
        this.loopFade = 0;
        break;
      case 'keyLock':
        if (command.on === this.keyLock) break;
        // Switching engines mid-play: crossfade from what is audible now.
        if (this.playing && this.gain > 0) this.jump(this.head);
        this.keyLock = command.on;
        this.resetStretch();
        break;
    }
  }

  /**
   * Move the head to `to` while playing, crossfading from the audio that is
   * audible now. The old dip-to-silence left a 3-12 ms gap on every hot cue,
   * seek and platter touch.
   */
  private jump(to: number): void {
    // Under key lock the audible content is the current grain, read at
    // normal speed; without it, the head itself at the playback rate.
    const stretching = this.keyLock && this.prevStart >= 0;
    this.fadeFrom = stretching ? this.prevStart + this.blockPos : this.head;
    this.fadeStep = this.keyLock ? 1 : this.rate;
    this.fadePos = 0;
    this.head = to;
    this.resetStretch();
  }

  private resetStretch(): void {
    this.tailL.fill(0);
    this.tailR.fill(0);
    this.blockPos = HOP;
    this.prevStart = -1;
  }

  /**
   * Sample at integer frame `p`, folded into the active loop; 0 outside the
   * track. The last `loopFade` frames before the loop end crossfade into the
   * frames before the loop start, so the looped signal the grains read is
   * continuous across the wrap, exactly as the resampling path plays it.
   */
  private at(data: Float32Array, p: number): number {
    let frame = p;
    if (this.loopEnd > this.loopStart && this.loopStart >= 0) {
      // Loop points are fractional frames, so a folded position must be floored
      // again: an unfloored index reads undefined and turns the output to NaN.
      if (frame >= this.loopEnd) frame = Math.floor(this.wrapped(frame));
      const fadeStart = this.loopEnd - this.loopFade;
      if (this.loopFade > 0 && frame >= fadeStart) {
        const w = ((frame - fadeStart) / this.loopFade) * (Math.PI / 2);
        const echo = Math.floor(frame - (this.loopEnd - this.loopStart));
        return this.raw(data, frame) * Math.cos(w) + this.raw(data, echo) * Math.sin(w);
      }
    }
    return this.raw(data, frame);
  }

  private raw(data: Float32Array, frame: number): number {
    return frame >= 0 && frame < this.length ? data[frame] : 0;
  }

  /**
   * Next WSOLA block: a grain read at normal speed around the head, placed
   * (within +/-SEARCH) where it best continues the previous grain, and
   * overlap-added with that grain's second half.
   */
  private nextBlock(left: Float32Array, right: Float32Array): void {
    const target = Math.round(this.head);
    let start = target;
    const fresh = this.prevStart < 0;
    if (!fresh) {
      // Copy the reference and the search region to mono buffers once: the
      // scoring loop below then runs on plain arrays (it was 4 folded reads
      // per multiply, about 1 ms of audio-thread time per block).
      const natural = this.prevStart + HOP;
      let refEnergy = 0;
      for (let j = 0; j < COMPARE; j += 2) {
        const a = this.at(left, natural + j) + this.at(right, natural + j);
        this.refBuf[j >> 1] = a;
        refEnergy += a * a;
      }
      if (refEnergy > SILENCE) {
        const base = target - SEARCH;
        const search = this.searchBuf;
        for (let k = 0; k < search.length; k++) search[k] = this.at(left, base + k) + this.at(right, base + k);
        let best = -Infinity;
        // Outward from the head (0, +1, -1, +2, ...), so ties keep the closest.
        for (let d = 0; d <= 2 * SEARCH; d++) {
          const offset = d & 1 ? (d + 1) >> 1 : -(d >> 1);
          const c = offset + SEARCH;
          let dot = 0;
          let energy = 0;
          for (let j = 0; j < COMPARE; j += 2) {
            const b = search[c + j];
            dot += this.refBuf[j >> 1] * b;
            energy += b * b;
          }
          const score = (energy > 0 ? dot / Math.sqrt(energy * refEnergy) : 0) - (DRIFT_PENALTY * Math.abs(offset)) / SEARCH;
          if (score > best) {
            best = score;
            start = target + offset;
          }
        }
      }
    }
    for (let j = 0; j < HOP; j++) {
      // After a reset there is no previous grain to overlap: play the first
      // half-grain unwindowed instead of fading it in over another 11 ms.
      const w = fresh ? 1 : WINDOW[j];
      this.blockL[j] = this.tailL[j] + w * this.at(left, start + j);
      this.blockR[j] = this.tailR[j] + w * this.at(right, start + j);
      const w2 = WINDOW[HOP + j];
      this.tailL[j] = w2 * this.at(left, start + HOP + j);
      this.tailR[j] = w2 * this.at(right, start + HOP + j);
    }
    this.prevStart = start;
    this.blockPos = 0;
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
    // The crossfade reads loopFade frames before the loop start; loopFade is
    // sized when the loop is set so that room exists on both sides.
    const xfadeFrom = looping && this.loopFade > 0 ? this.loopEnd - this.loopFade : Infinity;

    for (let i = 0; i < outL.length; i++) {
      if (this.rate !== this.targetRate) {
        const delta = this.targetRate - this.rate;
        this.rate = Math.abs(delta) <= RATE_SLEW ? this.targetRate : this.rate + Math.sign(delta) * RATE_SLEW;
      }
      const target = this.playing && this.pendingSeek === null ? 1 : 0;
      if (this.gain < target) this.gain = Math.min(target, this.gain + step);
      else if (this.gain > target) this.gain = Math.max(target, this.gain - step);

      if (this.gain === 0) {
        if (this.pendingSeek !== null) {
          this.head = this.seekTarget(this.pendingSeek, currentTime + i / sampleRate);
          this.pendingSeek = null;
          this.resetStretch();
        }
        outL[i] = 0;
        outR[i] = 0;
        continue;
      }

      let l: number;
      let r: number;
      if (this.keyLock) {
        // Overlap-add already crossfades loop wraps: grains read through them.
        if (this.blockPos >= HOP) this.nextBlock(left, right);
        l = this.blockL[this.blockPos];
        r = this.blockR[this.blockPos];
        this.blockPos++;
      } else {
        l = DeckProcessor.sample(left, this.head, last);
        r = DeckProcessor.sample(right, this.head, last);
      }
      if (!this.keyLock && this.head >= xfadeFrom) {
        // Equal-power crossfade into the audio just before the loop start, which
        // the head continues from after the wrap below: no discontinuity.
        const w = ((this.head - xfadeFrom) / this.loopFade) * (Math.PI / 2);
        const out = Math.cos(w);
        const into = Math.sin(w);
        const echo = this.head - span;
        l = l * out + DeckProcessor.sample(left, echo, last) * into;
        r = r * out + DeckProcessor.sample(right, echo, last) * into;
      }
      if (this.fadePos < RAMP_SAMPLES) {
        // Jump crossfade (equal power): the old position fades out underneath.
        const w = ((this.fadePos + 0.5) / RAMP_SAMPLES) * (Math.PI / 2);
        const from = looping && this.fadeFrom >= this.loopEnd ? this.wrapped(this.fadeFrom) : Math.max(0, Math.min(last, this.fadeFrom));
        l = l * Math.sin(w) + DeckProcessor.sample(left, from, last) * Math.cos(w);
        r = r * Math.sin(w) + DeckProcessor.sample(right, from, last) * Math.cos(w);
        this.fadeFrom = from + this.fadeStep;
        this.fadePos++;
      }
      outL[i] = l * this.gain;
      outR[i] = r * this.gain;

      const before = this.head;
      this.head += this.rate;
      if (looping && this.head >= this.loopEnd) this.head = this.wrapped(this.head);
      // Reverse (scratch, reverse play) wraps back to the loop end, so it does
      // not run out of the loop. The looped signal is continuous across the
      // wrap in both directions, so no extra crossfade is needed.
      else if (looping && this.head < this.loopStart && before >= this.loopStart) this.head += span;
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
