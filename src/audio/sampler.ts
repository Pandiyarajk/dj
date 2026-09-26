/**
 * Dialogue sampler: eight pads that fire short clips (movie dialogues, sound
 * drops) over the mix, with talk-over ducking of the decks.
 *
 * A press plays the pad's clip from the start; a press while it plays stops
 * it. Clips join the master before the limiter, so they are limited and
 * recorded. Assigned clips are stored (bytes and all) so pads survive a
 * reload and work offline.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-26-2026
 */
import { Store } from '../state/store';
import { formatTime } from './deck-controller';
import { faderGain } from './mixer-math';

export const PAD_COUNT = 8;
/** A dialogue pad is not a deck: longer clips belong on a deck. */
export const MAX_CLIP_SECONDS = 60;
export const MAX_CLIP_BYTES = 20 * 1024 * 1024;
/** Talk-over choices, dB (0 = off). */
export const DUCK_LEVELS = [0, -6, -10, -16] as const;
export const DEFAULT_DUCK_DB = -10;

export interface PadState {
  title: string | null;
  /** Clip length, seconds (0 when empty). */
  duration: number;
  loading: boolean;
  playing: boolean;
  /** Playing in the headphones only (Shift+click). */
  previewing: boolean;
  /** Context time the current play started, for the progress bar. */
  startedAt: number;
}

export interface SamplerState {
  pads: PadState[];
  /** Dialogue level, fader position 0..1. */
  level: number;
  /** Talk-over depth, dB (0 = off). */
  duckDb: number;
  /** Always-visible status or refusal. */
  status: string;
}

export type StoredPads = ({ title: string; blob: Blob } | null)[];

export interface SamplerSettings {
  level: number;
  duckDb: number;
}

/** What is persisted: the clip bytes (not the decoded audio) and the settings. */
export interface StoredSampler extends Partial<SamplerSettings> {
  pads?: StoredPads;
}

/**
 * Clips and settings are saved separately: a LEVEL sweep must not rewrite up
 * to 8 x 20 MB of clips on every slider event.
 */
export interface SamplerStorage {
  load(): Promise<StoredSampler | null>;
  saveClips(pads: StoredPads): Promise<void>;
  saveSettings(settings: SamplerSettings): Promise<void>;
}

/** Settings saves wait this long after the last change, ms. */
const SETTINGS_SAVE_DELAY_MS = 400;

/**
 * Talk-over arbiter: the music ducks while any source (pads, mic) is on, by
 * the current depth. Sources report on/off only; nothing else calls duck(),
 * so one source's release can never un-duck another, and a depth change while
 * ducked applies at once.
 */
export class TalkOver {
  private readonly active = new Set<string>();
  private applied = 0;

  constructor(
    private readonly duck: (db: number) => void,
    private depth: number = DEFAULT_DUCK_DB,
  ) {}

  /** Mark `source` on or off. */
  set(source: string, on: boolean): void {
    if (on) this.active.add(source);
    else this.active.delete(source);
    this.apply();
  }

  /** Change the depth, dB (0 = talk-over off). */
  setDepth(db: number): void {
    this.depth = db;
    this.apply();
  }

  /** The music is ducked right now. */
  get ducked(): boolean {
    return this.applied < 0;
  }

  private apply(): void {
    const want = this.active.size > 0 ? this.depth : 0;
    if (want === this.applied) return;
    this.applied = want;
    this.duck(want);
  }
}

/** Minimal audio context surface the sampler uses (a real AudioContext in the app). */
export interface SamplerContext {
  readonly currentTime: number;
  createGain(): GainNode;
  createBufferSource(): AudioBufferSourceNode;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
}

const emptyPad = (): PadState => ({ title: null, duration: 0, loading: false, playing: false, previewing: false, startedAt: 0 });

/** Why a clip is refused, or null when it is fine. `seconds` is unknown (null) before decoding. */
export function clipProblem(bytes: number, seconds: number | null): string | null {
  if (bytes > MAX_CLIP_BYTES) return `too large (${(bytes / 1024 / 1024).toFixed(1)} MB, the limit is ${MAX_CLIP_BYTES / 1024 / 1024} MB)`;
  if (seconds !== null && seconds > MAX_CLIP_SECONDS) return `too long (${formatTime(seconds)}, the limit is ${MAX_CLIP_SECONDS} s: load it on a deck instead)`;
  if (seconds !== null && seconds <= 0) return 'empty';
  return null;
}

/** The talk-over level after `current` in the cycle off, -6, -10, -16. */
export function nextDuck(current: number): number {
  const index = DUCK_LEVELS.indexOf(current as (typeof DUCK_LEVELS)[number]);
  return DUCK_LEVELS[(index + 1) % DUCK_LEVELS.length];
}

/** Label for a talk-over level. */
export function duckLabel(db: number): string {
  return db === 0 ? 'TALK OFF' : `TALK ${db} dB`;
}

/** A title from a file name: the name without its extension. */
export function clipTitle(name: string): string {
  return name.replace(/\.[a-z0-9]{2,5}$/i, '').trim() || 'Clip';
}

export class Sampler {
  readonly store = new Store<SamplerState>({
    pads: Array.from({ length: PAD_COUNT }, emptyPad),
    level: 0.8,
    duckDb: DEFAULT_DUCK_DB,
    status: 'Drop audio files on the pads, or drag tracks from the library',
  });
  private readonly bus: GainNode;
  private readonly previewBus: GainNode;
  private readonly buffers: (AudioBuffer | null)[] = new Array(PAD_COUNT).fill(null);
  private readonly blobs: (Blob | null)[] = new Array(PAD_COUNT).fill(null);
  private readonly sources = new Map<number, AudioBufferSourceNode>();
  /** Bumped per assign, so a slow decode cannot land on a pad reassigned since. */
  private readonly assignGen = new Array<number>(PAD_COUNT).fill(0);
  /** A pad is playing on the master (what talk-over follows). */
  private talking = false;
  /** Pads the user assigned or cleared since boot: restore leaves them alone. */
  private readonly touched = new Set<number>();
  /** Clip saves wait for the restore, or they would save still-decoding pads as empty. */
  private restoring: Promise<void> = Promise.resolve();
  private settingsTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param output where pads play (the master, before the limiter).
   * @param cueInput the headphone bus, for Shift+click preview.
   * @param canPreview whether a headphone route exists.
   * @param onTalk told when pads start or stop playing on the master (for talk-over).
   */
  constructor(
    private readonly ctx: SamplerContext,
    output: AudioNode,
    cueInput: AudioNode,
    private readonly canPreview: () => boolean,
    private readonly onTalk: (talking: boolean) => void,
    private readonly storage: SamplerStorage,
  ) {
    this.bus = ctx.createGain();
    this.bus.gain.value = faderGain(this.store.get().level);
    this.bus.connect(output);
    this.previewBus = ctx.createGain();
    this.previewBus.connect(cueInput);
  }

  /** Context time now, for progress bars. */
  get now(): number {
    return this.ctx.currentTime;
  }

  private setPad(index: number, patch: Partial<PadState>): void {
    const pads = this.store.get().pads.slice();
    pads[index] = { ...pads[index], ...patch };
    this.store.set({ pads });
  }

  private label(index: number): string {
    const title = this.store.get().pads[index].title;
    return title ? `Pad ${index + 1} "${title}"` : `Pad ${index + 1}`;
  }

  /**
   * Put a clip on a pad (replacing what was there).
   *
   * @param fromUser false only for restore: user assigns are saved, and a
   *   restore still in flight will not overwrite them.
   */
  async assign(index: number, title: string, blob: Blob, fromUser = true): Promise<boolean> {
    if (fromUser) this.touched.add(index);
    const early = clipProblem(blob.size, null);
    if (early) {
      this.store.set({ status: `"${title}" not added: ${early}` });
      return false;
    }
    const generation = ++this.assignGen[index];
    this.stop(index);
    this.setPad(index, { loading: true });
    this.store.set({ status: `Loading "${title}" on pad ${index + 1}...` });
    let buffer: AudioBuffer;
    try {
      buffer = await this.ctx.decodeAudioData(await blob.arrayBuffer());
    } catch {
      if (generation === this.assignGen[index]) {
        this.setPad(index, { loading: false });
        this.store.set({ status: `"${title}" not added: the browser cannot decode this file` });
      }
      return false;
    }
    if (generation !== this.assignGen[index]) return false;
    const late = clipProblem(blob.size, buffer.duration);
    if (late) {
      this.setPad(index, { loading: false });
      this.store.set({ status: `"${title}" not added: ${late}` });
      return false;
    }
    this.buffers[index] = buffer;
    this.blobs[index] = blob;
    this.setPad(index, { ...emptyPad(), title, duration: buffer.duration });
    this.store.set({ status: `Pad ${index + 1}: "${title}" (${formatTime(buffer.duration)})` });
    if (fromUser) await this.persistClips();
    return true;
  }

  /** Empty a pad (or cancel a clip still loading onto it). */
  async clear(index: number): Promise<void> {
    const pad = this.store.get().pads[index];
    this.touched.add(index);
    this.assignGen[index]++;
    this.stop(index);
    this.buffers[index] = null;
    this.blobs[index] = null;
    this.setPad(index, emptyPad());
    if (pad.title) this.store.set({ status: `Pad ${index + 1} cleared ("${pad.title}")` });
    else if (pad.loading) this.store.set({ status: `Pad ${index + 1}: loading cancelled` });
    else this.store.set({ status: `Pad ${index + 1} is already empty` });
    await this.persistClips();
  }

  /** A pad press: play from the start, or stop it if it is playing. */
  press(index: number): void {
    const pad = this.store.get().pads[index];
    if (pad.loading) {
      this.store.set({ status: `Pad ${index + 1} is still loading` });
      return;
    }
    if (!this.buffers[index]) {
      this.store.set({ status: `Pad ${index + 1} is empty: drop a clip on it` });
      return;
    }
    // A press while it previews in the headphones sends it live, not silent.
    if (pad.playing && !pad.previewing) this.stop(index, `${this.label(index)} stopped`);
    else this.play(index, false);
  }

  /** Shift+click: hear the clip in the headphones only. */
  preview(index: number): void {
    if (this.store.get().pads[index].loading) {
      this.store.set({ status: `Pad ${index + 1} is still loading` });
      return;
    }
    if (!this.buffers[index]) {
      this.store.set({ status: `Pad ${index + 1} is empty: drop a clip on it` });
      return;
    }
    if (!this.canPreview()) {
      this.store.set({ status: 'Choose a headphone cue mode (Split or 4-channel) to preview a pad' });
      return;
    }
    if (this.store.get().pads[index].playing) this.stop(index);
    this.play(index, true);
  }

  private play(index: number, preview: boolean): void {
    const buffer = this.buffers[index];
    if (!buffer) return;
    this.stop(index);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(preview ? this.previewBus : this.bus);
    // The end of the clip clears the playing state, not the caller: a pad can
    // never be left lit after the audio has stopped.
    source.onended = () => {
      if (this.sources.get(index) !== source) return;
      this.sources.delete(index);
      source.disconnect();
      this.setPad(index, { playing: false, previewing: false });
      this.updateDuck();
    };
    this.sources.set(index, source);
    const startedAt = this.ctx.currentTime;
    source.start();
    this.setPad(index, { playing: true, previewing: preview, startedAt });
    this.store.set({ status: preview ? `Previewing ${this.label(index)} in the headphones` : `Playing ${this.label(index)}` });
    this.updateDuck();
  }

  /** Stop one pad (no-op when it is not playing). */
  stop(index: number, status?: string): void {
    const source = this.sources.get(index);
    if (!source) return;
    this.sources.delete(index);
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already ended.
    }
    source.disconnect();
    this.setPad(index, { playing: false, previewing: false });
    if (status) this.store.set({ status });
    this.updateDuck();
  }

  /** Stop every pad (the B key). */
  stopAll(): void {
    const playing = [...this.sources.keys()];
    for (const index of playing) this.stop(index);
    this.store.set({ status: playing.length ? `Stopped ${playing.length} dialogue${playing.length === 1 ? '' : 's'}` : 'No dialogue is playing' });
  }

  /** Dialogue level, fader position 0..1. */
  setLevel(level: number): void {
    const clamped = Math.max(0, Math.min(1, level));
    this.bus.gain.setTargetAtTime(faderGain(clamped), this.ctx.currentTime, 0.012);
    this.store.set({ level: clamped });
    this.persistSettingsSoon();
  }

  /** Cycle the talk-over depth (it applies to the mic too). */
  cycleDuck(): void {
    const duckDb = nextDuck(this.store.get().duckDb);
    this.store.set({ duckDb, status: duckDb === 0 ? 'Talk-over off: the music keeps its level under dialogues and the mic' : `Talk-over: the music dips ${-duckDb} dB under dialogues and the mic` });
    this.persistSettingsSoon();
  }

  /** Report to talk-over whether any pad plays on the master (previews do not count). */
  private updateDuck(): void {
    const onMaster = this.store.get().pads.some((p) => p.playing && !p.previewing);
    if (onMaster === this.talking) return;
    this.talking = onMaster;
    this.onTalk(onMaster);
  }

  private async persistClips(): Promise<void> {
    await this.restoring;
    const pads = this.store.get().pads.map((p, i) => {
      const blob = this.blobs[i];
      return blob && p.title ? { title: p.title, blob } : null;
    });
    try {
      await this.storage.saveClips(pads);
    } catch {
      this.store.set({ status: 'Pads work, but could not be saved for next time (browser storage refused)' });
    }
  }

  private persistSettingsSoon(): void {
    clearTimeout(this.settingsTimer);
    this.settingsTimer = setTimeout(() => {
      const { level, duckDb } = this.store.get();
      this.storage.saveSettings({ level, duckDb }).catch(() => undefined);
    }, SETTINGS_SAVE_DELAY_MS);
  }

  /** Put back the pads saved last time (pads the user has touched since boot are left alone). */
  restore(): Promise<void> {
    this.restoring = this.doRestore();
    return this.restoring;
  }

  private async doRestore(): Promise<void> {
    const saved = await this.storage.load().catch(() => null);
    if (!saved) return;
    const level = typeof saved.level === 'number' ? saved.level : this.store.get().level;
    const duckDb = DUCK_LEVELS.includes(saved.duckDb as (typeof DUCK_LEVELS)[number]) ? (saved.duckDb as number) : DEFAULT_DUCK_DB;
    this.bus.gain.value = faderGain(level);
    this.store.set({ level, duckDb });
    const pads = (saved.pads ?? []).slice(0, PAD_COUNT);
    let restored = 0;
    await Promise.all(
      pads.map(async (pad, i) => {
        if (pad && !this.touched.has(i) && (await this.assign(i, pad.title, pad.blob, false))) restored++;
      }),
    );
    if (restored > 0) this.store.set({ status: `${restored} dialogue pad${restored === 1 ? '' : 's'} restored` });
  }
}
