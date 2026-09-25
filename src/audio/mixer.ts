/**
 * Mixer state and the per-channel Web Audio strip.
 *
 * Signal path per channel:
 *   deck -> trim -> low shelf -> mid peak -> high shelf -> fader -> crossfader
 *                                                      '-> cue tap (pre-fader)
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { dbToGain, faderGain, type CrossfaderCurve } from './mixer-math';

export type CueMode = 'off' | 'split' | 'quad';
export type EqBand = 'high' | 'mid' | 'low';

export interface ChannelSettings {
  trimDb: number;
  eqDb: Record<EqBand, number>;
  kill: Record<EqBand, boolean>;
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
}

/** EQ knob range, dB (Pioneer-style: deep cut, small boost). */
export const EQ_MIN_DB = -26;
export const EQ_MAX_DB = 6;
export const TRIM_MIN_DB = -12;
export const TRIM_MAX_DB = 12;
/** Gain a killed band is set to. */
const KILL_DB = -48;

const EQ_SETTINGS: Record<EqBand, { type: BiquadFilterType; frequency: number; q: number }> = {
  low: { type: 'lowshelf', frequency: 200, q: 0.7 },
  mid: { type: 'peaking', frequency: 1000, q: 0.5 },
  high: { type: 'highshelf', frequency: 3500, q: 0.7 },
};

export function defaultChannel(): ChannelSettings {
  return {
    trimDb: 0,
    eqDb: { high: 0, mid: 0, low: 0 },
    kill: { high: false, mid: false, low: false },
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
  };
}

/** Time constant for parameter smoothing, seconds: fast, but no zipper noise. */
const SMOOTHING = 0.012;

export class ChannelStrip {
  readonly input: GainNode;
  /** Post-fader, pre-crossfader tap for the channel meter. */
  readonly analyser: AnalyserNode;
  /** Final output, after the crossfader gain. */
  readonly output: GainNode;
  /** Pre-fader send to the cue bus. */
  readonly cueSend: GainNode;
  private readonly eq: Record<EqBand, BiquadFilterNode>;
  private readonly fader: GainNode;

  constructor(private readonly ctx: AudioContext) {
    this.input = ctx.createGain();
    this.fader = ctx.createGain();
    this.output = ctx.createGain();
    this.cueSend = ctx.createGain();
    this.cueSend.gain.value = 0;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;

    const make = (band: EqBand): BiquadFilterNode => {
      const s = EQ_SETTINGS[band];
      return new BiquadFilterNode(ctx, { type: s.type, frequency: s.frequency, Q: s.q, gain: 0 });
    };
    this.eq = { low: make('low'), mid: make('mid'), high: make('high') };

    this.input.connect(this.eq.low).connect(this.eq.mid).connect(this.eq.high);
    this.eq.high.connect(this.fader).connect(this.output);
    this.fader.connect(this.analyser);
    this.eq.high.connect(this.cueSend);
  }

  private ramp(param: AudioParam, value: number): void {
    param.setTargetAtTime(value, this.ctx.currentTime, SMOOTHING);
  }

  /** Apply channel settings plus this channel's crossfader gain. */
  apply(settings: ChannelSettings, crossfaderGain: number): void {
    this.ramp(this.input.gain, dbToGain(settings.trimDb));
    for (const band of ['low', 'mid', 'high'] as const) {
      this.ramp(this.eq[band].gain, settings.kill[band] ? KILL_DB : settings.eqDb[band]);
    }
    this.ramp(this.fader.gain, faderGain(settings.fader));
    this.ramp(this.output.gain, crossfaderGain);
    this.ramp(this.cueSend.gain, settings.cue ? 1 : 0);
  }
}
