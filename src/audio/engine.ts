/**
 * Audio engine: the AudioContext, the deck worklet module, both channel strips,
 * the master bus with a safety limiter, and headphone-cue output routing.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (cue-bus limiter, gain-reduction reading, click-free re-route)
 */
import deckProcessorUrl from './worklets/deck-processor.ts?worker&url';
import recorderProcessorUrl from './worklets/recorder-processor.ts?worker&url';
import { MixRecorder } from './recorder';
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
  /** Headphone blend: cue bus and master, then the headphone level. */
  private readonly cueMixCue: GainNode;
  private readonly cueMixMaster: GainNode;
  private readonly headphoneLevel: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  /** Gates between the buses and the output routing, ramped around a re-route. */
  private readonly masterFade: GainNode;
  private readonly cueFade: GainNode;
  private routeTimer: ReturnType<typeof setTimeout> | undefined;
  private routing: AudioNode[] = [];
  private cueMode: CueMode | null = null;
  private readonly meterBuffer = new Float32Array(1024);

  private constructor(readonly ctx: AudioContext) {
    this.strips = [new ChannelStrip(ctx), new ChannelStrip(ctx)];
    this.masterGain = ctx.createGain();
    // Safety limiter: two full-scale decks summed would otherwise clip.
    this.limiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.003, release: 0.1 });
    this.masterOut = ctx.createGain();
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.cueBus = ctx.createGain();
    // The cue bus is pre-fader with up to +12 dB of trim: limit it too, or two
    // cued hot tracks clip hard in the headphones.
    const cueLimiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.003, release: 0.1 });
    this.masterFade = ctx.createGain();
    this.cueFade = ctx.createGain();
    this.cueMixCue = ctx.createGain();
    this.cueMixMaster = new GainNode(ctx, { gain: 0 });
    this.headphoneLevel = ctx.createGain();

    for (const strip of this.strips) {
      strip.output.connect(this.masterGain);
      strip.cueSend.connect(this.cueBus);
    }
    this.masterGain.connect(this.limiter).connect(this.masterOut);
    this.masterOut.connect(this.masterAnalyser);
    this.masterOut.connect(this.masterFade);
    // Headphones: cue bus (limited) blended with master by CUE MIX, then the
    // headphone level, then the output routing.
    this.cueBus.connect(cueLimiter).connect(this.cueMixCue).connect(this.headphoneLevel);
    this.masterOut.connect(this.cueMixMaster).connect(this.headphoneLevel);
    this.headphoneLevel.connect(this.cueFade);
  }

  /** Input to the headphone cue bus (library prelisten plays here, never to master). */
  get cueInput(): AudioNode {
    return this.cueBus;
  }

  /** Whether the headphone bus is routed to any output right now. */
  get cueAudible(): boolean {
    return this.cueMode !== null && this.cueMode !== 'off';
  }

  /** True when the browser can switch output devices (AudioContext.setSinkId). */
  get canChooseOutput(): boolean {
    return typeof (this.ctx as unknown as { setSinkId?: unknown }).setSinkId === 'function';
  }

  /** Send all audio to an output device ('' = system default). */
  async setOutputDevice(deviceId: string): Promise<void> {
    const ctx = this.ctx as unknown as { setSinkId?: (id: string) => Promise<void> };
    if (!ctx.setSinkId) throw new Error('This browser cannot choose an output device');
    await ctx.setSinkId(deviceId);
  }

  /**
   * A recorder on the master bus, post-limiter and before the output routing
   * fade, so re-routing the headphone cue never dips the recording.
   */
  createRecorder(): MixRecorder {
    const node = new AudioWorkletNode(this.ctx, 'recorder-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    this.masterOut.connect(node);
    // Pulled by the graph only if connected onward; its output is silence.
    node.connect(this.ctx.destination);
    return new MixRecorder(node, this.ctx.sampleRate);
  }

  /** Master limiter gain reduction right now, dB (0 or negative). */
  get limiterReduction(): number {
    return this.limiter.reduction;
  }

  /**
   * Create the context and load the deck worklet.
   *
   * The context starts suspended until a user gesture; call resume() from one.
   */
  static async create(): Promise<AudioEngine> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await Promise.all([ctx.audioWorklet.addModule(deckProcessorUrl), ctx.audioWorklet.addModule(recorderProcessorUrl)]);
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
      this.strips[0].apply(state.channels[0], gainA, state.autoGain);
      this.strips[1].apply(state.channels[1], gainB, state.autoGain);
      const now = this.ctx.currentTime;
      this.masterGain.gain.setTargetAtTime(faderGain(state.master), now, 0.012);
      this.headphoneLevel.gain.setTargetAtTime(faderGain(state.cueVolume), now, 0.012);
      // Equal-power blend: 0 = cue only, 1 = master only.
      const mix = Math.max(0, Math.min(1, state.cueMix ?? 0));
      this.cueMixCue.gain.setTargetAtTime(Math.cos((mix * Math.PI) / 2), now, 0.012);
      this.cueMixMaster.gain.setTargetAtTime(Math.sin((mix * Math.PI) / 2), now, 0.012);
      // Compare the mode that will actually be used: 'quad' on a 2-output device
      // falls back to 'off', and comparing the raw value re-routed (dropping
      // the master for 30 ms) on every mixer change.
      const wanted = state.cueMode === 'quad' && !this.supportsQuad ? 'off' : state.cueMode;
      if (wanted !== this.cueMode) this.reroute(wanted);
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
  /** Re-route without a click: fade out, rewire, fade back in. The first route is immediate. */
  private reroute(mode: CueMode): void {
    if (this.cueMode === null) return this.route(mode);
    const now = this.ctx.currentTime;
    for (const fade of [this.masterFade, this.cueFade]) fade.gain.setTargetAtTime(0, now, 0.004);
    clearTimeout(this.routeTimer);
    this.cueMode = mode;
    this.routeTimer = setTimeout(() => {
      this.route(mode);
      const later = this.ctx.currentTime;
      for (const fade of [this.masterFade, this.cueFade]) fade.gain.setTargetAtTime(1, later, 0.004);
    }, 30);
  }

  private route(mode: CueMode): void {
    this.masterFade.disconnect();
    this.cueFade.disconnect();
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
      this.masterFade.connect(masterSplit);
      this.cueFade.connect(cueSplit);
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
        this.cueFade.connect(cueMono).connect(merger, 0, 0);
        this.masterFade.connect(masterMono).connect(merger, 0, 1);
        merger.connect(destination);
        this.routing = [cueMono, masterMono, merger];
      } else {
        this.masterFade.connect(destination);
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
