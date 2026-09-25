/**
 * Library prelisten: hear a track in the headphones (the cue bus) without
 * touching the decks or the master.
 *
 * Streams through an <audio> element, so even a long file starts at once
 * without decoding the whole thing.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { Store } from '../state/store';

export interface PrelistenState {
  /** Title playing, or null. */
  title: string | null;
  position: number;
  duration: number;
  /** Always-visible status or refusal. */
  status: string;
}

export class Prelisten {
  readonly store = new Store<PrelistenState>({ title: null, position: 0, duration: 0, status: '' });
  private readonly audio = new Audio();
  private url: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  /**
   * @param cueInput where prelisten audio goes (the cue bus: headphones only).
   * @param canHear whether a headphone output is routed; prelisten refuses otherwise.
   */
  constructor(
    ctx: AudioContext,
    cueInput: AudioNode,
    private readonly canHear: () => boolean,
  ) {
    this.audio.preload = 'auto';
    ctx.createMediaElementSource(this.audio).connect(cueInput);
    this.audio.addEventListener('ended', () => this.stop('Prelisten finished'));
    this.audio.addEventListener('error', () => this.stop('This file cannot be played for prelisten'));
  }

  get playing(): boolean {
    return this.store.get().title !== null;
  }

  /** Prelisten a file from `start` seconds (default: 30% in, past the intro). */
  async play(title: string, file: Blob, start?: number): Promise<void> {
    if (!this.canHear()) {
      this.store.set({ status: 'Choose a headphone cue mode (Split or 4-channel) to prelisten' });
      return;
    }
    this.release();
    this.url = URL.createObjectURL(file);
    this.audio.src = this.url;
    this.store.set({ title, position: 0, duration: 0, status: `Prelistening: ${title}` });
    try {
      await new Promise<void>((resolve, reject) => {
        this.audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
        this.audio.addEventListener('error', () => reject(new Error('unplayable')), { once: true });
      });
      this.audio.currentTime = start ?? this.audio.duration * 0.3;
      await this.audio.play();
    } catch {
      this.stop('This file cannot be played for prelisten');
      return;
    }
    clearInterval(this.timer);
    this.timer = setInterval(() => this.store.set({ position: this.audio.currentTime, duration: this.audio.duration || 0 }), 200);
  }

  /** Jump within the track being prelistened, 0..1. */
  seek(fraction: number): void {
    if (!this.playing || !this.audio.duration) return;
    this.audio.currentTime = Math.max(0, Math.min(1, fraction)) * this.audio.duration;
  }

  stop(status = 'Prelisten stopped'): void {
    this.release();
    this.store.set({ title: null, position: 0, duration: 0, status });
  }

  private release(): void {
    clearInterval(this.timer);
    this.audio.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}
