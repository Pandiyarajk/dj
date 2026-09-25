/**
 * Per-channel effects: tempo-synced echo, reverb and flanger.
 *
 *   in --+--------------------------------------> out   (dry, always)
 *        '-> send(amount, when on) -> effect -> out     (wet)
 *
 * Switching the effect off closes the send but leaves the return open, so
 * an echo or reverb tail keeps ringing out: the "echo out" transition.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */

export type FxType = 'echo' | 'reverb' | 'flanger';
export const FX_TYPES: FxType[] = ['echo', 'reverb', 'flanger'];
/** Echo time / flanger sweep choices, in beats. */
export const FX_BEATS = [0.25, 0.5, 0.75, 1, 2] as const;

export interface FxSettings {
  type: FxType;
  on: boolean;
  /** Wet level, 0..1. */
  amount: number;
  beats: number;
}

export function defaultFx(): FxSettings {
  return { type: 'echo', on: false, amount: 0.6, beats: 0.75 };
}

/** Echo delay for a beat division at a tempo, seconds (clamped to the delay line). */
export function echoSeconds(beats: number, bpm: number | null): number {
  const beat = bpm && bpm > 0 ? 60 / bpm : 0.5;
  return Math.max(0.01, Math.min(MAX_DELAY - 0.01, beats * beat));
}

const MAX_DELAY = 4;
const SMOOTHING = 0.02;

/** A decaying stereo noise impulse response: a plain, dense room. */
function impulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.round(seconds * ctx.sampleRate);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let seed = 0x9e3779b9 ^ (c * 0x85ebca6b);
    for (let i = 0; i < length; i++) {
      // xorshift noise: deterministic, decorrelated between channels.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const noise = ((seed >>> 0) / 4294967296) * 2 - 1;
      data[i] = noise * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
}

export class ChannelFx {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly sends: Record<FxType, GainNode>;
  private readonly echoDelay: DelayNode;
  private readonly flangerLfo: OscillatorNode;
  private settings: FxSettings = defaultFx();
  private bpm: number | null = null;

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.connect(this.output);
    const send = (): GainNode => {
      const g = ctx.createGain();
      g.gain.value = 0;
      this.input.connect(g);
      return g;
    };
    this.sends = { echo: send(), reverb: send(), flanger: send() };

    // Echo: a delay line with filtered feedback, so repeats darken as they fade.
    this.echoDelay = new DelayNode(ctx, { maxDelayTime: MAX_DELAY, delayTime: 0.36 });
    const feedback = new GainNode(ctx, { gain: 0.45 });
    const tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3500, Q: 0.5 });
    this.sends.echo.connect(this.echoDelay);
    this.echoDelay.connect(tone).connect(feedback).connect(this.echoDelay);
    this.echoDelay.connect(this.output);

    // Reverb: a generated 2.8 s room.
    const reverb = new ConvolverNode(ctx, { buffer: impulse(ctx, 2.8, 3), disableNormalization: false });
    const reverbLevel = new GainNode(ctx, { gain: 0.7 });
    this.sends.reverb.connect(reverb).connect(reverbLevel).connect(this.output);

    // Flanger: a short delay swept by an LFO, with feedback for the jet sound.
    const flangeDelay = new DelayNode(ctx, { maxDelayTime: 0.02, delayTime: 0.004 });
    const flangeFeedback = new GainNode(ctx, { gain: 0.55 });
    this.flangerLfo = new OscillatorNode(ctx, { type: 'triangle', frequency: 0.25 });
    const depth = new GainNode(ctx, { gain: 0.0028 });
    this.flangerLfo.connect(depth).connect(flangeDelay.delayTime);
    this.flangerLfo.start();
    this.sends.flanger.connect(flangeDelay);
    flangeDelay.connect(flangeFeedback).connect(flangeDelay);
    flangeDelay.connect(this.output);
  }

  private ramp(param: AudioParam, value: number): void {
    param.setTargetAtTime(value, this.ctx.currentTime, SMOOTHING);
  }

  /** Keep time-based effects on the beat of the deck they sit on. */
  setTempo(bpm: number | null): void {
    this.bpm = bpm;
    this.applyTiming();
  }

  apply(settings: FxSettings): void {
    this.settings = settings;
    for (const type of FX_TYPES) this.ramp(this.sends[type].gain, settings.on && settings.type === type ? settings.amount : 0);
    this.applyTiming();
  }

  private applyTiming(): void {
    const { beats } = this.settings;
    this.ramp(this.echoDelay.delayTime, echoSeconds(beats, this.bpm));
    // One flanger sweep per `beats * 4` beats (a bar at 1 beat).
    const sweep = echoSeconds(beats * 4, this.bpm);
    this.ramp(this.flangerLfo.frequency, 1 / Math.max(0.5, sweep));
  }

  /** Current echo time, seconds (for tests and display). */
  get echoTime(): number {
    return this.echoDelay.delayTime.value;
  }
}
