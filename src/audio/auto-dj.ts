/**
 * Auto DJ: plays a queue of tracks with synced, beat-length crossfades.
 *
 * Every tick it makes sure the idle deck holds the next track; near the end
 * of the playing track it syncs the idle deck, starts it and moves the
 * crossfader across over TRANSITION_BEATS beats (a quarter of the track at
 * most, for short tracks), then stops the old deck. Anything the DJ does to
 * a deck mid-transition simply carries on: Auto DJ only acts at its own
 * decision points.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import type { MixerState } from './mixer';
import type { DeckController } from './deck-controller';
import type { SyncCoordinator } from './sync-coordinator';
import { formatTime } from './deck-controller';
import type { LibraryEntry } from '../library/library';
import type { TrackLoader } from '../library/track-loader';
import { Store } from '../state/store';

const TICK_MS = 250;
const TRANSITION_BEATS = 16;
/** Seconds of transition when a track has no BPM. */
const TRANSITION_FALLBACK = 12;

export interface AutoDjState {
  running: boolean;
  /** Always-visible status: next track and when, or why it stopped. */
  status: string;
}

export class AutoDj {
  readonly store = new Store<AutoDjState>({ running: false, status: '' });
  private queue: LibraryEntry[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private live: DeckController | null = null;
  private fade: { from: number; to: number; start: number; seconds: number } | null = null;
  private loadingNext = false;
  /** Deck that just finished its transition out: it still holds the old track. */
  private spent: DeckController | null = null;

  constructor(
    private readonly decks: [DeckController, DeckController],
    private readonly loader: TrackLoader,
    private readonly sync: SyncCoordinator,
    private readonly mixer: Store<MixerState>,
  ) {}

  toggle(queue: () => LibraryEntry[]): void {
    if (this.store.get().running) this.stop('Auto DJ stopped');
    else void this.start(queue());
  }

  stop(status: string): void {
    clearInterval(this.timer);
    this.fade = null;
    this.store.set({ running: false, status });
  }

  private other(deck: DeckController): DeckController {
    return deck === this.decks[0] ? this.decks[1] : this.decks[0];
  }

  /** Crossfader value that plays only `deck`. */
  private side(deck: DeckController): number {
    return deck === this.decks[0] ? -1 : 1;
  }

  async start(queue: LibraryEntry[]): Promise<void> {
    this.queue = [...queue];
    const playing = this.decks.find((d) => d.state.playing && d.loaded) ?? null;
    if (!playing && this.queue.length === 0) {
      this.store.set({ running: false, status: 'Auto DJ needs tracks: open a crate or the library first' });
      return;
    }
    this.store.set({ running: true, status: 'Auto DJ starting...' });
    if (playing) {
      this.live = playing;
      // Do not replay the track already on air.
      this.queue = this.queue.filter((e) => e.title !== playing.state.track?.title);
    } else {
      this.live = this.decks[0];
      const first = this.queue.shift()!;
      await this.loader.loadEntry(this.live, first);
      if (!this.live.loaded) return this.stop(`Auto DJ could not load "${first.title}"`);
      this.mixer.set({ crossfader: this.side(this.live) });
      this.live.play();
    }
    // Whatever already sits on the idle deck is not part of the queue: it
    // must be replaced, not mixed into (it was, when starting from stopped decks).
    this.spent = this.other(this.live);
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  private transitionSeconds(deck: DeckController): number {
    const bpm = deck.effectiveBpm;
    const beats = bpm ? (TRANSITION_BEATS * 60) / bpm : TRANSITION_FALLBACK;
    return Math.max(4, Math.min(beats, deck.duration / 4));
  }

  private async tick(): Promise<void> {
    const live = this.live;
    if (!live || !this.store.get().running) return;
    const next = this.other(live);

    if (this.fade) {
      const f = this.fade;
      const t = Math.min(1, (performance.now() - f.start) / (f.seconds * 1000));
      // Equal steps of the fader; the equal-power curve does the rest.
      this.mixer.set({ crossfader: f.from + (f.to - f.from) * t });
      if (t >= 1) {
        this.fade = null;
        live.pause();
        this.spent = live;
        this.live = next;
        this.store.set({ status: `Auto DJ: now playing "${next.state.track?.title ?? ''}"` });
      }
      return;
    }

    if (!live.state.playing) return this.stop('Auto DJ stopped: the playing deck was stopped');

    // Keep the next track ready on the idle deck.
    if ((!next.loaded || next === this.spent) && !this.loadingNext && next.state.status !== 'loading') {
      const entry = this.queue.shift();
      if (!entry) {
        const left = live.duration - live.position();
        this.store.set({ status: `Auto DJ: last track, ${formatTime(left)} left` });
        if (left < 1) this.stop('Auto DJ finished the queue');
        return;
      }
      this.loadingNext = true;
      await this.loader.loadEntry(next, entry);
      this.loadingNext = false;
      this.spent = null;
      return;
    }
    if (!next.loaded || next.state.analysis !== null) return;

    const left = live.duration - live.position();
    const seconds = this.transitionSeconds(live);
    const nextTitle = next.state.track?.title ?? '';
    if (left > seconds + 0.5) {
      this.store.set({ status: `Auto DJ: "${nextTitle}" in ${formatTime(left - seconds)}` });
      return;
    }
    // Transition: sync the incoming deck, start it, sweep the crossfader.
    if (!next.state.synced && next.grid && live.grid) this.sync.toggle(next);
    next.play();
    this.fade = { from: this.mixer.get().crossfader, to: this.side(next), start: performance.now(), seconds };
    this.store.set({ status: `Auto DJ: mixing into "${nextTitle}" over ${seconds.toFixed(0)} s` });
  }
}
