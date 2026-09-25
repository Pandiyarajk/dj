/**
 * Mixer state and the per-channel Web Audio strip.
 *
 * Signal path per channel:
 *   deck -> auto-gain -> trim -> 3-band isolator -> filter -> fader -> crossfader
 *                                            '-> cue tap (pre-fader)
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (isolator EQ with true kills, one-knob filter, auto-gain)
 */
import { dbToGain, faderGain, filterFrequencies, type CrossfaderCurve } from './mixer-math';

export type CueMode = 'off' | 'split' | 'quad';
export type EqBand = 'high' | 'mid' | 'low';

export interface ChannelSettings {
  trimDb: number;
  eqDb: Record<EqBand, number>;
  kill: Record<EqBand, boolean>;
  /** One-knob filter: -1 low-pass .. 0 off .. +1 high-pass. */
  filter: number;
  /** Channel fader position, 0..1. */
  fader: number;
  /** Send this channel to the headphone cue bus. */
  cue: boolean;
}

export interface MixerState {
  channels: [ChannelSettings, ChannelSettings];
  /** -1 = deck A, +1 = deck B. */
  crossfader: number;
  curve: CrossfaderCurve;
  /** Master fader position, 0..1. */
  master: number;
  /** Headphone cue level, 0..1. */
  cueVolume: number;
  cueMode: CueMode;
  /** Level each track by its measured loudness. */
  autoGain: boolean;
}

/** EQ knob range, dB (Pioneer-style: deep cut, small boost). */
export const EQ_MIN_DB = -26;
export const EQ_MAX_DB = 6;
export const TRIM_MIN_DB = -12;
export const TRIM_MAX_DB = 12;
/** Isolator crossover frequencies, Hz: low | mid | high. */
const CROSSOVER_LOW = 250;
const CROSSOVER_HIGH = 2500;
/** Butterworth Q; two in series make a 24 dB/octave Linkwitz-Riley crossover. */
const BUTTERWORTH_Q = Math.SQRT1_2;
/** Filter resonance: a little emphasis at the cutoff, the usual DJ-filter sound. */
const FILTER_Q = 1.1;

export function defaultChannel(): ChannelSettings {
  return {
    trimDb: 0,
    eqDb: { high: 0, mid: 0, low: 0 },
    kill: { high: false, mid: false, low: false },
    filter: 0,
    fader: 0.8,
    cue: false,
  };
}

export function defaultMixer(): MixerState {
  return {
    channels: [defaultChannel(), defaultChannel()],
    crossfader: 0,
    curve: 'smooth',
    master: 0.8,
    cueVolume: 0.7,
    cueMode: 'off',
    autoGain: true,
  };
}

/** Time constant for parameter smoothing, seconds: fast, but no zipper noise. */
const SMOOTHING = 0.012;

export class ChannelStrip {
  /** Deck input: auto-gain, then trim. */
  readonly input: GainNode;
  private readonly trim: GainNode;
  private autoGainDb = 0;
  private autoGainOn = true;
  /** Post-fader, pre-crossfader tap for the channel meter. */
  readonly analyser: AnalyserNode;
  /** Final output, after the crossfader gain. */
  readonly output: GainNode;
  /** Pre-fader send to the cue bus. */
  readonly cueSend: GainNode;
  private readonly bands: Record<EqBand, GainNode>;
  private readonly lowpass: BiquadFilterNode;
  private readonly highpass: BiquadFilterNode;
  private readonly fader: GainNode;

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.trim = ctx.createGain();
    this.input.connect(this.trim);
    this.fader = ctx.createGain();
    this.output = ctx.createGain();
    this.cueSend = ctx.createGain();
    this.cueSend.gain.value = 0;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;

    const biquad = (type: BiquadFilterType, frequency: number, q = BUTTERWORTH_Q): BiquadFilterNode =>
      new BiquadFilterNode(ctx, { type, frequency, Q: q });
    /** A 4th-order Linkwitz-Riley section: two Butterworth biquads in series. */
    const lr4 = (type: 'lowpass' | 'highpass', frequency: number): [AudioNode, AudioNode] => {
      const first = biquad(type, frequency);
      const second = biquad(type, frequency);
      first.connect(second);
      return [first, second];
    };

    // Isolator: a proper 3-way crossover, so KILL removes the band entirely
    // (a shelf at -48 dB left the low-mids and bass harmonics audible).
    // The low band passes through the high crossover's all-pass (its LP plus
    // HP) so all three bands stay in phase and sum flat at unity gain.
    this.bands = { low: ctx.createGain(), mid: ctx.createGain(), high: ctx.createGain() };
    const sum = ctx.createGain();
    const [lowIn, lowOut] = lr4('lowpass', CROSSOVER_LOW);
    const [restIn, restOut] = lr4('highpass', CROSSOVER_LOW);
    this.trim.connect(lowIn);
    this.trim.connect(restIn);
    const [apLowIn, apLowOut] = lr4('lowpass', CROSSOVER_HIGH);
    const [apHighIn, apHighOut] = lr4('highpass', CROSSOVER_HIGH);
    lowOut.connect(apLowIn);
    lowOut.connect(apHighIn);
    apLowOut.connect(this.bands.low);
    apHighOut.connect(this.bands.low);
    const [midIn, midOut] = lr4('lowpass', CROSSOVER_HIGH);
    const [highIn, highOut] = lr4('highpass', CROSSOVER_HIGH);
    restOut.connect(midIn);
    restOut.connect(highIn);
    midOut.connect(this.bands.mid);
    highOut.connect(this.bands.high);
    for (const band of Object.values(this.bands)) band.connect(sum);

    this.lowpass = biquad('lowpass', 22000, FILTER_Q);
    this.highpass = biquad('highpass', 10, FILTER_Q);
    sum.connect(this.lowpass).connect(this.highpass);
    this.highpass.connect(this.fader).connect(this.output);
    this.fader.connect(this.analyser);
    this.highpass.connect(this.cueSend);
  }

  private ramp(param: AudioParam, value: number): void {
    param.setTargetAtTime(value, this.ctx.currentTime, SMOOTHING);
  }

  /** Set the loaded track's auto-gain, dB (applied while auto-gain is on). */
  setAutoGain(db: number): void {
    this.autoGainDb = db;
    this.ramp(this.input.gain, this.autoGainOn ? dbToGain(db) : 1);
  }

  /** Apply channel settings plus this channel's crossfader gain. */
  apply(settings: ChannelSettings, crossfaderGain: number, autoGain = true): void {
    if (autoGain !== this.autoGainOn) {
      this.autoGainOn = autoGain;
      this.setAutoGain(this.autoGainDb);
    }
    this.ramp(this.trim.gain, dbToGain(settings.trimDb));
    for (const band of ['low', 'mid', 'high'] as const) {
      this.ramp(this.bands[band].gain, settings.kill[band] ? 0 : dbToGain(settings.eqDb[band]));
    }
    const { lowpass, highpass } = filterFrequencies(settings.filter ?? 0);
    this.ramp(this.lowpass.frequency, Math.min(lowpass, this.ctx.sampleRate / 2 - 100));
    this.ramp(this.highpass.frequency, highpass);
    this.ramp(this.fader.gain, faderGain(settings.fader));
    this.ramp(this.output.gain, crossfaderGain);
    this.ramp(this.cueSend.gain, settings.cue ? 1 : 0);
  }
}
