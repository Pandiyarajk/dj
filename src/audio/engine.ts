/**
 * Audio engine: the AudioContext, the deck worklet module, both channel strips,
 * the master bus with a safety limiter, and headphone-cue output routing.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import deckProcessorUrl from './worklets/deck-processor.ts?worker&url';
import { ChannelStrip, type CueMode, type MixerState } from './mixer';
import { crossfaderGains, faderGain } from './mixer-math';
import type { Store } from '../state/store';

export interface MeterReading {
  /** Peak absolute sample value over the last analyser window, 0..1+. */
  peak: number;
  /** RMS level over the same window. */
  rms: number;
}

export class AudioEngine {
  readonly strips: [ChannelStrip, ChannelStrip];
  readonly masterAnalyser: AnalyserNode;
  private readonly masterGain: GainNode;
  private readonly masterOut: GainNode;
  private readonly cueBus: GainNode;
  private routing: AudioNode[] = [];
  private cueMode: CueMode | null = null;
  private readonly meterBuffer = new Float32Array(1024);

  private constructor(readonly ctx: AudioContext) {
    this.strips = [new ChannelStrip(ctx), new ChannelStrip(ctx)];
    this.masterGain = ctx.createGain();
    // Safety limiter: two full-scale decks summed would otherwise clip.
    const limiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.003, release: 0.1 });
    this.masterOut = ctx.createGain();
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.cueBus = ctx.createGain();

    for (const strip of this.strips) {
      strip.output.connect(this.masterGain);
      strip.cueSend.connect(this.cueBus);
    }
    this.masterGain.connect(limiter).connect(this.masterOut);
    this.masterOut.connect(this.masterAnalyser);
  }

  /**
   * Create the context and load the deck worklet.
   *
   * The context starts suspended until a user gesture; call resume() from one.
   */
  static async create(): Promise<AudioEngine> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(deckProcessorUrl);
    return new AudioEngine(ctx);
  }

  /** True when the output device exposes a second stereo pair for headphones. */
  get supportsQuad(): boolean {
    return this.ctx.destination.maxChannelCount >= 4;
  }

  /** Seconds between a sample being rendered and being heard. */
  get outputLatency(): number {
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** Keep the audio graph in step with the mixer store. */
  bindMixer(store: Store<MixerState>): void {
    const apply = (state: MixerState): void => {
      const [gainA, gainB] = crossfaderGains(state.crossfader, state.curve);
      this.strips[0].apply(state.channels[0], gainA);
      this.strips[1].apply(state.channels[1], gainB);
      const now = this.ctx.currentTime;
      this.masterGain.gain.setTargetAtTime(faderGain(state.master), now, 0.012);
      this.cueBus.gain.setTargetAtTime(faderGain(state.cueVolume), now, 0.012);
      if (state.cueMode !== this.cueMode) this.route(state.cueMode === 'quad' && !this.supportsQuad ? 'off' : state.cueMode);
    };
    apply(store.get());
    store.subscribe(apply);
  }

  /**
   * Wire master and cue to the output device.
   *
   * - off:   master stereo on outputs 1/2; cue is not heard.
   * - split: one stereo output shared: cue (mono) left, master (mono) right.
   * - quad:  master on outputs 1/2, cue on 3/4 of a 4-channel device.
   */
  private route(mode: CueMode): void {
    this.masterOut.disconnect();
    this.masterOut.connect(this.masterAnalyser);
    this.cueBus.disconnect();
    for (const node of this.routing) node.disconnect();
    this.routing = [];
    const destination = this.ctx.destination;

    if (mode === 'quad') {
      destination.channelCount = 4;
      destination.channelCountMode = 'explicit';
      destination.channelInterpretation = 'discrete';
      const merger = this.ctx.createChannelMerger(4);
      const masterSplit = this.ctx.createChannelSplitter(2);
      const cueSplit = this.ctx.createChannelSplitter(2);
      this.masterOut.connect(masterSplit);
      this.cueBus.connect(cueSplit);
      masterSplit.connect(merger, 0, 0);
      masterSplit.connect(merger, 1, 1);
      cueSplit.connect(merger, 0, 2);
      cueSplit.connect(merger, 1, 3);
      merger.connect(destination);
      this.routing = [merger, masterSplit, cueSplit];
    } else {
      destination.channelCount = 2;
      destination.channelCountMode = 'explicit';
      destination.channelInterpretation = 'speakers';
      if (mode === 'split') {
        const toMono = (): GainNode =>
          new GainNode(this.ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
        const cueMono = toMono();
        const masterMono = toMono();
        const merger = this.ctx.createChannelMerger(2);
        this.cueBus.connect(cueMono).connect(merger, 0, 0);
        this.masterOut.connect(masterMono).connect(merger, 0, 1);
        merger.connect(destination);
        this.routing = [cueMono, masterMono, merger];
      } else {
        this.masterOut.connect(destination);
      }
    }
    this.cueMode = mode;
  }

  /** Peak and RMS of an analyser's most recent window. */
  meter(analyser: AnalyserNode): MeterReading {
    const buffer = this.meterBuffer;
    analyser.getFloatTimeDomainData(buffer);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const v = Math.abs(buffer[i]);
      if (v > peak) peak = v;
      sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / buffer.length) };
  }
}
