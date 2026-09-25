/**
 * Main-thread handle for one deck: transport, tempo, cues, loops and beat grid.
 *
 * State the UI renders lives in `store`; the playhead does not (it changes
 * every frame), so read it with position().
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { Store } from '../state/store';
import type { AudioEngine } from './engine';
import type { ChannelStrip } from './mixer';
import { beatLength, snapToBeat, TEMPO_RANGES, type BeatGrid } from './sync';
import type { DeckCommand, DeckReport } from './worklets/deck-processor';
import type { Peaks } from '../analysis/peaks';

export type DeckId = 'A' | 'B';
export const HOT_CUE_COUNT = 8;
export const LOOP_SIZES = [1, 2, 4, 8, 16] as const;
/** Pitch-bend (nudge) amount while a bend button is held. */
const BEND = 0.04;
/** How long a transient notice stays up, ms. */
const NOTICE_MS = 3000;

export interface TrackInfo {
  /** Stable identity used as the cache key (see library/db). */
  key: string;
  title: string;
  artist: string;
  /** Seconds. */
  duration: number;
}

/** Per-track data that is cached between sessions. */
export interface SavedTrackData {
  bpm: number | null;
  firstBeat: number;
  peaks: Peaks | null;
  cuePoint: number;
  hotCues: (number | null)[];
}

export interface Loop {
  /** Seconds of track time. */
  start: number;
  end: number;
  /** Beat length for auto loops, null for a manual in/out loop. */
  beats: number | null;
}

export interface DeckState {
  status: 'empty' | 'loading' | 'ready' | 'error';
  /** What the deck is doing, or why it failed. Always shown. */
  statusText: string;
  /** Short-lived acknowledgement ("Hot cue 3 set", "Sync needs a BPM"). */
  notice: { text: string; level: 'info' | 'warn' } | null;
  track: TrackInfo | null;
  playing: boolean;
  /** Tempo fader offset, fraction (0.02 = +2%). */
  tempo: number;
  tempoRange: number;
  /** Held pitch-bend offset, fraction. */
  bend: number;
  bpm: number | null;
  firstBeat: number;
  /** 0..1 while analysing, null otherwise. */
  analysis: number | null;
  peaks: Peaks | null;
  cuePoint: number;
  hotCues: (number | null)[];
  loop: Loop | null;
  /** Last loop, so it can be re-engaged. */
  lastLoop: Loop | null;
  /** Pending loop-in point while a manual loop is being set. */
  loopIn: number | null;
  loopSize: number;
  quantize: boolean;
  synced: boolean;
}

function initialState(): DeckState {
  return {
    status: 'empty',
    statusText: 'No track loaded',
    notice: null,
    track: null,
    playing: false,
    tempo: 0,
    tempoRange: TEMPO_RANGES[0],
    bend: 0,
    bpm: null,
    firstBeat: 0,
    analysis: null,
    peaks: null,
    cuePoint: 0,
    hotCues: new Array(HOT_CUE_COUNT).fill(null),
    loop: null,
    lastLoop: null,
    loopIn: null,
    loopSize: 4,
    quantize: true,
    synced: false,
  };
}

export class DeckController {
  readonly store = new Store<DeckState>(initialState());
  private readonly node: AudioWorkletNode;
  private readonly sampleRate: number;
  private lengthFrames = 0;
  /** Last position the processor reported (render time, not heard time). */
  private report = { frame: 0, time: 0, playing: false };
  private seq = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly id: DeckId,
    private readonly engine: AudioEngine,
    strip: ChannelStrip,
  ) {
    this.sampleRate = engine.ctx.sampleRate;
    this.node = new AudioWorkletNode(engine.ctx, 'deck-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node.connect(strip.input);
    this.node.port.onmessage = (event: MessageEvent<DeckReport>) => this.onReport(event.data);
  }

  private send(command: DeckCommand, transfer: Transferable[] = []): void {
    this.node.port.postMessage(command, transfer);
  }

  private onReport(report: DeckReport): void {
    if (report.type === 'ended') {
      this.store.set({ playing: false });
      this.notice('End of track');
      return;
    }
    // A report from before our latest seek describes a position we left.
    if (report.seq < this.seq) return;
    this.report = { frame: report.frame, time: report.time, playing: report.playing };
  }

  get state(): DeckState {
    return this.store.get();
  }

  get loaded(): boolean {
    return this.state.status === 'ready';
  }

  /** Current playback rate (tempo and bend). */
  get rate(): number {
    return 1 + this.state.tempo + this.state.bend;
  }

  /** BPM as heard, or null before analysis. */
  get effectiveBpm(): number | null {
    return this.state.bpm === null ? null : this.state.bpm * (1 + this.state.tempo);
  }

  get grid(): BeatGrid | null {
    const { bpm, firstBeat } = this.state;
    return bpm === null ? null : { bpm, firstBeat };
  }

  get duration(): number {
    return this.lengthFrames / this.sampleRate;
  }

  /** Show a transient acknowledgement on the deck. */
  notice(text: string, level: 'info' | 'warn' = 'info'): void {
    clearTimeout(this.noticeTimer);
    this.store.set({ notice: { text, level } });
    this.noticeTimer = setTimeout(() => this.store.set({ notice: null }), NOTICE_MS);
  }

  // ---- loading ------------------------------------------------------------

  /** Mark the deck as loading, stopping playback first. */
  beginLoad(text: string): void {
    this.pause();
    this.store.set({ status: 'loading', statusText: text, analysis: null });
  }

  setStatusText(text: string): void {
    this.store.set({ statusText: text });
  }

  fail(message: string): void {
    this.store.set({ status: 'error', statusText: message, analysis: null });
  }

  /** Hand a decoded track to the processor. */
  load(buffer: AudioBuffer, info: TrackInfo, saved: SavedTrackData | null): void {
    this.pause();
    const left = buffer.getChannelData(0).slice();
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : left.slice();
    this.send({ type: 'load', left, right }, [left.buffer, right.buffer]);
    this.lengthFrames = buffer.length;
    this.seq++;
    this.send({ type: 'seek', frame: 0, seq: this.seq });
    this.report = { frame: 0, time: this.engine.ctx.currentTime, playing: false };
    this.send({ type: 'rate', rate: this.rate });

    const bpm = saved?.bpm ?? null;
    // Cached peaks mean analysis already ran, even if it found no steady beat.
    const analysed = Boolean(saved?.peaks);
    this.store.set({
      status: 'ready',
      statusText: analysed ? (bpm !== null ? 'Ready' : 'Ready (no steady beat found)') : 'Analysing...',
      track: info,
      playing: false,
      bpm,
      firstBeat: saved?.firstBeat ?? 0,
      peaks: saved?.peaks ?? null,
      analysis: analysed ? null : 0,
      cuePoint: saved?.cuePoint ?? 0,
      hotCues: saved?.hotCues?.slice() ?? new Array(HOT_CUE_COUNT).fill(null),
      loop: null,
      lastLoop: null,
      loopIn: null,
      synced: false,
    });
  }

  setAnalysisProgress(fraction: number): void {
    this.store.set({ analysis: fraction, statusText: `Analysing ${Math.round(fraction * 100)}%` });
  }

  setAnalysis(result: { bpm: number | null; firstBeat: number; peaks: Peaks }): void {
    this.store.set({
      bpm: result.bpm,
      firstBeat: result.firstBeat,
      peaks: result.peaks,
      analysis: null,
      statusText: result.bpm === null ? 'Ready (no steady beat found)' : 'Ready',
    });
  }

  // ---- position -------------------------------------------------------------

  /** Playhead at render time, frames. Use for sync maths. */
  private renderFrame(latency = 0, at = this.engine.ctx.currentTime): number {
    const { frame, time, playing } = this.report;
    let f = frame;
    if (playing) f += (at - time - latency) * this.sampleRate * this.rate;
    const loop = this.state.loop;
    if (loop) {
      const start = loop.start * this.sampleRate;
      const end = loop.end * this.sampleRate;
      if (f >= end && end > start) f = start + ((f - start) % (end - start));
    }
    return Math.max(0, Math.min(this.lengthFrames, f));
  }

  /** Playhead at render time, seconds; at context time `at` if given. */
  renderPosition(at?: number): number {
    return this.renderFrame(0, at) / this.sampleRate;
  }

  /** Playhead as heard (output latency removed), seconds. Use for display. */
  position(): number {
    return this.renderFrame(this.engine.outputLatency) / this.sampleRate;
  }

  /** Context time now, seconds. */
  now(): number {
    return this.engine.ctx.currentTime;
  }

  /**
   * Move the playhead.
   *
   * @param seconds target track position.
   * @param at context time `seconds` refers to (see DeckCommand 'seek'); omit
   *   for "wherever the head is when the jump lands".
   */
  seek(seconds: number, at?: number): void {
    if (!this.loaded) return;
    const frame = Math.max(0, Math.min(this.lengthFrames - 1, seconds * this.sampleRate));
    this.seq++;
    this.send({ type: 'seek', frame, seq: this.seq, at });
    this.report = { frame, time: at ?? this.engine.ctx.currentTime, playing: this.state.playing };
  }

  private snap(seconds: number, mode: 'nearest' | 'floor' = 'nearest'): number {
    const grid = this.grid;
    return this.state.quantize && grid ? snapToBeat(grid, seconds, mode) : seconds;
  }

  // ---- transport ------------------------------------------------------------

  play(): void {
    if (!this.loaded) {
      this.notice('Load a track first', 'warn');
      return;
    }
    void this.engine.resume();
    this.report = { frame: this.renderFrame(), time: this.engine.ctx.currentTime, playing: true };
    this.send({ type: 'play' });
    this.store.set({ playing: true });
  }

  pause(): void {
    if (!this.state.playing) return;
    this.report = { frame: this.renderFrame(), time: this.engine.ctx.currentTime, playing: false };
    this.send({ type: 'pause' });
    this.store.set({ playing: false });
  }

  togglePlay(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }

  /** CDJ-style cue: playing -> back to the cue point and stop; stopped -> set the cue point here. */
  cue(): void {
    if (!this.loaded) {
      this.notice('Load a track first', 'warn');
      return;
    }
    if (this.state.playing) {
      this.pause();
      this.seek(this.state.cuePoint);
      this.notice('Back to cue');
    } else {
      const point = this.snap(this.position());
      this.store.set({ cuePoint: point });
      this.seek(point);
      this.notice(`Cue set at ${formatTime(point)}`);
    }
  }

  // ---- tempo ----------------------------------------------------------------

  /** Tempo from the fader: a manual change drops sync. */
  setTempo(tempo: number): void {
    if (this.state.synced) this.notice('Sync off (tempo moved)');
    this.applyTempo(tempo, false);
  }

  /** Tempo without touching sync; used by the sync coordinator. */
  applyTempo(tempo: number, keepSync = true): void {
    const range = this.state.tempoRange;
    const clamped = Math.max(-range, Math.min(range, tempo));
    this.store.set({ tempo: clamped, synced: keepSync && this.state.synced });
    this.send({ type: 'rate', rate: this.rate });
  }

  setTempoRange(range: number): void {
    this.store.set({ tempoRange: range });
    if (Math.abs(this.state.tempo) > range) this.applyTempo(this.state.tempo);
  }

  cycleTempoRange(): void {
    const index = TEMPO_RANGES.indexOf(this.state.tempoRange as (typeof TEMPO_RANGES)[number]);
    const next = TEMPO_RANGES[(index + 1) % TEMPO_RANGES.length];
    this.setTempoRange(next);
    this.notice(`Tempo range +/-${Math.round(next * 100)}%`);
  }

  resetTempo(): void {
    this.setTempo(0);
  }

  /** Hold-to-nudge: -1 slows, +1 speeds up, 0 releases. */
  bend(direction: -1 | 0 | 1): void {
    this.store.set({ bend: direction * BEND });
    this.send({ type: 'rate', rate: this.rate });
  }

  setSynced(synced: boolean): void {
    this.store.set({ synced });
  }

  toggleQuantize(): void {
    this.store.set({ quantize: !this.state.quantize });
    this.notice(this.state.quantize ? 'Quantize on' : 'Quantize off');
  }

  // ---- hot cues -------------------------------------------------------------

  /** Empty pad: store the current position. Set pad: jump to it. */
  hotCue(index: number): void {
    if (!this.loaded) {
      this.notice('Load a track first', 'warn');
      return;
    }
    const cues = this.state.hotCues.slice();
    const existing = cues[index];
    if (existing === null) {
      cues[index] = this.snap(this.position());
      this.store.set({ hotCues: cues });
      this.notice(`Hot cue ${index + 1} set`);
    } else {
      this.seek(existing);
      this.notice(`Hot cue ${index + 1}`);
    }
  }

  clearHotCue(index: number): void {
    if (this.state.hotCues[index] === null) {
      this.notice(`Hot cue ${index + 1} is already empty`);
      return;
    }
    const cues = this.state.hotCues.slice();
    cues[index] = null;
    this.store.set({ hotCues: cues });
    this.notice(`Hot cue ${index + 1} cleared`);
  }

  // ---- loops ----------------------------------------------------------------

  private setLoop(loop: Loop | null): void {
    if (loop) {
      this.send({ type: 'loop', start: loop.start * this.sampleRate, end: loop.end * this.sampleRate });
      this.store.set({ loop, lastLoop: loop, loopIn: null });
    } else {
      this.send({ type: 'loopOff' });
      this.store.set({ loop: null, loopIn: null });
    }
  }

  private requireGrid(action: string): BeatGrid | null {
    if (!this.loaded) {
      this.notice('Load a track first', 'warn');
      return null;
    }
    const grid = this.grid;
    if (!grid) this.notice(`${action} needs a BPM`, 'warn');
    return grid;
  }

  setLoopSize(beats: number): void {
    this.store.set({ loopSize: beats });
  }

  /** Loop `beats` beats from the current beat; the same size again exits. */
  autoLoop(beats = this.state.loopSize): void {
    const grid = this.requireGrid('Auto loop');
    if (!grid) return;
    const active = this.state.loop;
    if (active && active.beats === beats) {
      this.setLoop(null);
      this.notice('Loop off');
      return;
    }
    const start = this.snap(this.position(), 'floor');
    this.store.set({ loopSize: beats });
    this.setLoop({ start, end: start + beats * beatLength(grid.bpm), beats });
    this.notice(`Loop ${formatBeats(beats)}`);
  }

  loopInPoint(): void {
    if (!this.loaded) return this.notice('Load a track first', 'warn');
    const point = this.snap(this.position());
    this.store.set({ loopIn: point });
    this.notice(`Loop in at ${formatTime(point)}`);
  }

  loopOutPoint(): void {
    const start = this.state.loopIn ?? this.state.loop?.start ?? null;
    if (start === null) return this.notice('Set loop in first', 'warn');
    const end = this.snap(this.position());
    if (end <= start + 0.01) return this.notice('Loop out must be after loop in', 'warn');
    this.setLoop({ start, end, beats: null });
    this.notice('Loop set');
  }

  /** Toggle the current (or last) loop. */
  toggleLoop(): void {
    if (this.state.loop) {
      this.setLoop(null);
      this.notice('Loop off');
    } else if (this.state.lastLoop) {
      this.setLoop(this.state.lastLoop);
      this.notice('Reloop');
    } else {
      this.autoLoop();
    }
  }

  resizeLoop(factor: 0.5 | 2): void {
    const loop = this.state.loop;
    if (!loop) {
      const size = Math.max(LOOP_SIZES[0], Math.min(LOOP_SIZES[LOOP_SIZES.length - 1], this.state.loopSize * factor));
      this.setLoopSize(size);
      this.notice(`Loop size ${formatBeats(size)}`);
      return;
    }
    const span = (loop.end - loop.start) * factor;
    if (span < 0.02) return this.notice('Loop is as short as it goes', 'warn');
    const beats = loop.beats === null ? null : loop.beats * factor;
    this.setLoop({ start: loop.start, end: loop.start + span, beats });
    if (beats !== null) this.store.set({ loopSize: beats });
    if (beats !== null) this.notice(`Loop ${formatBeats(beats)}`);
    else this.notice(factor > 1 ? 'Loop doubled' : 'Loop halved');
  }

  /** Jump by the loop size in beats; an active loop moves with the playhead. */
  beatJump(direction: -1 | 1): void {
    const grid = this.requireGrid('Beat jump');
    if (!grid) return;
    const offset = direction * this.state.loopSize * beatLength(grid.bpm);
    const loop = this.state.loop;
    if (loop) this.setLoop({ ...loop, start: loop.start + offset, end: loop.end + offset });
    this.seek(this.renderPosition() + offset);
    this.notice(`Jump ${direction > 0 ? '+' : '-'}${formatBeats(this.state.loopSize)}`);
  }
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const minutes = Math.floor(s / 60);
  const rest = s - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

export function formatBeats(beats: number): string {
  if (beats >= 1) return `${beats} beat${beats === 1 ? '' : 's'}`;
  return `1/${Math.round(1 / beats)} beat`;
}
