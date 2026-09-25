/**
 * Main-thread handle for one deck: transport, tempo, cues, loops and beat grid.
 *
 * State the UI renders lives in `store`; the playhead does not (it changes
 * every frame), so read it with position().
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (loop validation, phase-preserving jumps, CDJ-style
 *   hold-to-preview cue and hot-cue gate, auto cue, BPM x2 / /2, seq on
 *   play/pause, loop-aware heard position)
 */
import { autoCuePoint } from '../analysis/auto-cue';
import type { Peaks } from '../analysis/peaks';
import { Store } from '../state/store';
import type { AudioEngine } from './engine';
import { fitLoop, phasePreservingTarget } from './loops';
import type { ChannelStrip } from './mixer';
import { beatLength, snapToBeat, TEMPO_RANGES, type BeatGrid } from './sync';
import type { DeckCommand, DeckReport } from './worklets/deck-processor';

export type DeckId = 'A' | 'B';
export const HOT_CUE_COUNT = 8;
export const LOOP_SIZES = [1, 2, 4, 8, 16] as const;
/** Pitch-bend (nudge) amount while a bend button is held. */
const BEND = 0.04;
/** How long a transient notice stays up, ms. */
const NOTICE_MS = 3000;
/** Positions this close to the cue point count as "at the cue", seconds. */
const AT_CUE = 0.02;
/** BPM overrides stay within this range. */
const BPM_LIMITS = [40, 250] as const;

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
  /**
   * Held preview: 'cue' while CUE is held on a stopped deck, or a hot-cue
   * index while its pad is held. Releasing returns to the point and stops;
   * pressing PLAY during the hold keeps playing.
   */
  previewing: 'cue' | number | null;
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
    previewing: null,
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

/** Hooks the sync coordinator installs so deck actions keep a synced mix locked. */
export interface SyncHooks {
  /** A synced deck's own tempo fader moved: returns true if sync handled it. */
  manualTempo(tempo: number): boolean;
  /** A synced deck jumped without quantize: put it back in phase. */
  realign(): void;
}

export class DeckController {
  readonly store = new Store<DeckState>(initialState());
  syncHooks: SyncHooks | null = null;
  private readonly node: AudioWorkletNode;
  private readonly sampleRate: number;
  private lengthFrames = 0;
  /** Last position the processor reported (render time, not heard time). */
  private report = { frame: 0, time: 0, playing: false };
  private seq = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** False until the user sets a cue point on this track; until then it follows the auto cue. */
  private cueChosen = false;

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
    // A report from before our latest seek, play or pause describes a state we left.
    if (report.seq < this.seq) return;
    if (report.type === 'ended') {
      this.store.set({ playing: false, previewing: null });
      this.notice('End of track');
      return;
    }
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
    // Mono tracks send one buffer; the processor plays it on both sides.
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : undefined;
    this.send({ type: 'load', left, right }, right ? [left.buffer, right.buffer] : [left.buffer]);
    this.lengthFrames = buffer.length;
    this.seq++;
    this.send({ type: 'seek', frame: 0, seq: this.seq });
    this.report = { frame: 0, time: this.engine.ctx.currentTime, playing: false };
    this.send({ type: 'rate', rate: this.rate });

    const bpm = saved?.bpm ?? null;
    // Cached peaks mean analysis already ran, even if it found no steady beat.
    const analysed = Boolean(saved?.peaks);
    this.cueChosen = (saved?.cuePoint ?? 0) > 0;
    this.store.set({
      status: 'ready',
      statusText: analysed ? readyText(bpm) : 'Analysing...',
      track: info,
      playing: false,
      previewing: null,
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
    if (analysed) this.applyAutoCue();
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
      statusText: readyText(result.bpm),
    });
    this.applyAutoCue();
  }

  /**
   * Cue to the first beat of the music, as DJ software does, unless the user
   * picked a cue point. Moves a stopped deck still at the start there too, so
   * the first PLAY does not start in leading silence.
   */
  private applyAutoCue(): void {
    const { peaks, playing } = this.state;
    if (this.cueChosen || !peaks) return;
    const point = autoCuePoint(peaks, this.grid);
    if (point <= 0) return;
    this.store.set({ cuePoint: point });
    if (!playing && this.renderPosition() < 0.05) this.seek(point);
  }

  // ---- position -------------------------------------------------------------

  /** Playhead at render time, frames, `latency` seconds earlier. Use latency 0 for sync maths. */
  private renderFrame(latency = 0, at = this.engine.ctx.currentTime): number {
    const { frame, time, playing } = this.report;
    const rate = this.sampleRate * this.rate;
    let f = frame;
    if (playing) f += (at - time) * rate;
    const loop = this.state.loop;
    const start = loop ? loop.start * this.sampleRate : 0;
    const end = loop ? loop.end * this.sampleRate : 0;
    const looping = loop !== null && end > start && frame < end;
    if (looping && f >= end) f = start + ((f - start) % (end - start));
    if (playing && latency > 0) {
      // Step back after wrapping, so just after a wrap the heard position is
      // near the loop end, not before the loop start.
      f -= latency * rate;
      if (looping && f < start) f += end - start;
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
   * @param keepLoop keep an active loop even if the target is outside it.
   *   Otherwise a target outside the loop exits it: the audio thread would
   *   fold it straight back into the loop, landing at a random point.
   */
  seek(seconds: number, at?: number, keepLoop = false): void {
    if (!this.loaded) return;
    const loop = this.state.loop;
    if (loop && !keepLoop && (seconds < loop.start || seconds >= loop.end)) this.setLoop(null);
    const frame = Math.max(0, Math.min(this.lengthFrames - 1, seconds * this.sampleRate));
    this.seq++;
    this.send({ type: 'seek', frame, seq: this.seq, at });
    this.report = { frame, time: at ?? this.engine.ctx.currentTime, playing: this.state.playing };
  }

  /**
   * A user jump (hot cue, waveform click). With quantize on, a playing deck
   * keeps its beat phase, so a mix that was on the beat (or synced) stays there.
   */
  jump(seconds: number): void {
    if (!this.loaded) return;
    const grid = this.grid;
    const { playing, quantize, synced } = this.state;
    if (playing && quantize && grid) {
      // The target is where the head should be *now*; stamp the seek with that
      // instant so the audio thread adds the playback that happens before the
      // jump lands (message latency plus the de-click ramp). Without it the
      // deck landed 1-3.4% of a beat late and a synced mix drifted out.
      const at = this.now();
      this.seek(Math.min(this.duration - 0.01, phasePreservingTarget(grid, this.renderPosition(at), seconds)), at);
      return;
    }
    this.seek(seconds);
    if (playing && synced) this.syncHooks?.realign();
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
    this.seq++;
    this.send({ type: 'play', seq: this.seq });
    this.store.set({ playing: true });
  }

  pause(): void {
    if (!this.state.playing) return;
    this.report = { frame: this.renderFrame(), time: this.engine.ctx.currentTime, playing: false };
    this.seq++;
    this.send({ type: 'pause', seq: this.seq });
    this.store.set({ playing: false, previewing: null });
  }

  togglePlay(): void {
    if (this.state.previewing !== null) {
      // PLAY during a held CUE or hot cue: keep playing when it is released.
      this.store.set({ previewing: null });
      this.notice('Playing');
    } else if (this.state.playing) {
      this.pause();
    } else {
      this.play();
    }
  }

  /**
   * CUE pressed. Playing: back to the cue point and stop. Stopped: set the cue
   * point here (if elsewhere) and preview from it while held.
   */
  cueDown(): void {
    if (!this.loaded) {
      this.notice('Load a track first', 'warn');
      return;
    }
    if (this.state.playing) {
      this.pause();
      this.seek(this.state.cuePoint);
      this.notice('Back to cue');
      return;
    }
    const here = this.position();
    if (Math.abs(here - this.state.cuePoint) > AT_CUE) {
      const point = this.snap(here);
      this.cueChosen = true;
      this.store.set({ cuePoint: point });
      this.notice(`Cue set at ${formatTime(point)}`);
    } else {
      this.notice('Cue preview (release to return)');
    }
    this.seek(this.state.cuePoint);
    this.play();
    this.store.set({ previewing: 'cue' });
  }

  /** CUE released: end a preview (unless PLAY latched it). */
  cueUp(): void {
    if (this.state.previewing !== 'cue') return;
    this.pause();
    this.seek(this.state.cuePoint);
  }

  // ---- tempo ----------------------------------------------------------------

  /** Tempo from the fader. On a synced deck, sync decides (it moves the shared tempo). */
  setTempo(tempo: number): void {
    if (this.state.synced && this.syncHooks?.manualTempo(tempo)) return;
    this.applyTempo(tempo, false);
  }

  /**
   * Tempo without the sync hook; used by the sync coordinator.
   *
   * @returns false when the tempo had to be clamped to the fader range.
   */
  applyTempo(tempo: number, keepSync = true): boolean {
    const range = this.state.tempoRange;
    const clamped = Math.max(-range, Math.min(range, tempo));
    this.store.set({ tempo: clamped, synced: keepSync && this.state.synced });
    this.send({ type: 'rate', rate: this.rate });
    return Math.abs(clamped - tempo) < 1e-9;
  }

  setTempoRange(range: number): void {
    this.store.set({ tempoRange: range });
    if (Math.abs(this.state.tempo) > range) {
      // Narrowing the range under a synced deck clamps its tempo: it can no
      // longer follow, so say so rather than drift while showing SYNC.
      const wasSynced = this.state.synced;
      this.applyTempo(this.state.tempo, false);
      if (wasSynced) this.notice('Sync off: tempo is outside the new range', 'warn');
    }
  }

  cycleTempoRange(): void {
    const index = TEMPO_RANGES.indexOf(this.state.tempoRange as (typeof TEMPO_RANGES)[number]);
    const next = TEMPO_RANGES[(index + 1) % TEMPO_RANGES.length];
    this.setTempoRange(next);
    if (this.state.notice?.level !== 'warn') this.notice(`Tempo range +/-${Math.round(next * 100)}%`);
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

  /**
   * Correct a half- or double-time BPM reading. The grid anchor is kept, so
   * beats stay where they were (doubling adds the off-beats).
   */
  scaleBpm(factor: 2 | 0.5): void {
    const bpm = this.state.bpm;
    if (!this.loaded || bpm === null) {
      this.notice('No BPM to change yet', 'warn');
      return;
    }
    const next = bpm * factor;
    if (next < BPM_LIMITS[0] || next > BPM_LIMITS[1]) {
      this.notice(`BPM would be ${next.toFixed(1)}: out of range`, 'warn');
      return;
    }
    const loop = this.state.loop;
    this.store.set({ bpm: next });
    // An auto loop's length was in beats of the old tempo; keep it as audio.
    if (loop?.beats) this.store.set({ loop: { ...loop, beats: loop.beats * factor } });
    this.notice(`BPM ${factor > 1 ? 'doubled' : 'halved'} to ${next.toFixed(2)}`);
  }

  // ---- hot cues -------------------------------------------------------------

  /**
   * Pad pressed. Empty: store the position. Set, deck playing: jump (keeping
   * the beat phase with quantize). Set, deck stopped: play from it while held.
   */
  hotCueDown(index: number): void {
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
    } else if (this.state.playing && this.state.previewing === null) {
      this.jump(existing);
      this.notice(`Hot cue ${index + 1}`);
    } else {
      this.seek(existing);
      if (!this.state.playing) this.play();
      this.store.set({ previewing: index });
      this.notice(`Hot cue ${index + 1} (release to return)`);
    }
  }

  /** Pad released: end a hot-cue preview (unless PLAY latched it). */
  hotCueUp(index: number): void {
    const cue = this.state.hotCues[index];
    if (this.state.previewing !== index || cue === null) return;
    this.pause();
    this.seek(cue);
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

  /**
   * Engage (or clear) a loop, fitted inside the track first: a loop starting
   * before 0 or ending past the track would never wrap in the audio thread.
   *
   * @returns the loop actually set, or null if none was.
   */
  private setLoop(loop: Loop | null): Loop | null {
    if (!loop) {
      this.send({ type: 'loopOff' });
      this.store.set({ loop: null, loopIn: null });
      return null;
    }
    const grid = this.grid;
    const fitted = fitLoop(loop.start, loop.end, this.duration, grid ? beatLength(grid.bpm) : undefined);
    if (!fitted) {
      this.notice('Loop is longer than the track', 'warn');
      return null;
    }
    const placed = { ...loop, start: fitted.start, end: fitted.end };
    this.send({ type: 'loop', start: placed.start * this.sampleRate, end: placed.end * this.sampleRate });
    this.store.set({ loop: placed, lastLoop: placed, loopIn: null });
    return placed;
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
    const placed = this.setLoop({ start, end: start + beats * beatLength(grid.bpm), beats });
    if (placed) this.notice(`Loop ${formatBeats(beats)}${Math.abs(placed.start - start) > 1e-6 ? ' (moved to fit the track)' : ''}`);
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
    if (this.setLoop({ start, end, beats: null })) this.notice('Loop set');
  }

  /** Toggle the current (or last) loop. */
  toggleLoop(): void {
    if (this.state.loop) {
      this.setLoop(null);
      this.notice('Loop off');
    } else if (this.state.lastLoop) {
      if (this.setLoop(this.state.lastLoop)) this.notice('Reloop');
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
    if (!this.setLoop({ start: loop.start, end: loop.start + span, beats })) return;
    if (beats !== null) this.store.set({ loopSize: beats });
    if (beats !== null) this.notice(`Loop ${formatBeats(beats)}`);
    else this.notice(factor > 1 ? 'Loop doubled' : 'Loop halved');
  }

  /** Jump by the loop size in beats; an active loop moves with the playhead. */
  beatJump(direction: -1 | 1): void {
    const grid = this.requireGrid('Beat jump');
    if (!grid) return;
    const offset = direction * this.state.loopSize * beatLength(grid.bpm);
    // Read the position before moving the loop: once the loop has moved, the
    // estimate wraps into it and the offset would be applied twice.
    const target = this.renderPosition() + offset;
    if (target < 0 || target >= this.duration - 0.05) {
      this.notice(`Cannot jump past the ${target < 0 ? 'start' : 'end'} of the track`, 'warn');
      return;
    }
    const loop = this.state.loop;
    if (loop) this.setLoop({ ...loop, start: loop.start + offset, end: loop.end + offset });
    this.seek(target, undefined, true);
    this.notice(`Jump ${direction > 0 ? '+' : '-'}${formatBeats(this.state.loopSize)}`);
  }
}

function readyText(bpm: number | null): string {
  return bpm === null ? 'Ready (no steady beat found)' : 'Ready';
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
