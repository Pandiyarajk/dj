/**
 * Background analysis of the whole library, so the BPM and Key columns are
 * filled (and sortable) before a set, not only for tracks already played.
 *
 * One track at a time, on its own worker, pausing while any deck is loading
 * or analysing so it never slows down a load.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { AnalysisClient } from '../analysis/analysis-client';
import { HOT_CUE_COUNT, type DeckController } from '../audio/deck-controller';
import { Store } from '../state/store';
import { ANALYSIS_VERSION, getTrack, hasCurrentAnalysis, trackKey, updateTrack } from './db';
import { errorText, type Library, type LibraryEntry } from './library';
import { readTags } from './metadata';

export interface BackgroundState {
  running: boolean;
  /** Always-visible progress or result line. */
  status: string;
  done: number;
  total: number;
  failed: number;
}

/** Poll interval while waiting for the decks to go idle, ms. */
const IDLE_POLL_MS = 400;

export class BackgroundAnalyser {
  readonly store = new Store<BackgroundState>({ running: false, status: '', done: 0, total: 0, failed: 0 });
  private readonly client = new AnalysisClient();
  private generation = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly library: Library,
    private readonly decks: DeckController[],
  ) {}

  toggle(): void {
    if (this.store.get().running) this.pause();
    else void this.run();
  }

  pause(): void {
    this.generation++;
    this.client.cancel();
    const s = this.store.get();
    this.store.set({ running: false, status: `Paused: ${s.done} of ${s.total} analysed` });
  }

  private decksBusy(): boolean {
    return this.decks.some((d) => d.state.status === 'loading' || d.state.analysis !== null);
  }

  private async waitForIdleDecks(generation: number): Promise<boolean> {
    while (this.decksBusy()) {
      if (generation !== this.generation) return false;
      this.store.set({ status: 'Waiting for the decks to finish loading...' });
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
    }
    return generation === this.generation;
  }

  async run(): Promise<void> {
    const generation = ++this.generation;
    const pending = this.library.store.get().entries.filter((e) => e.source.kind === 'file' && (e.bpm === null || e.key === null));
    if (pending.length === 0) {
      // Say so, rather than doing nothing visible.
      this.store.set({ running: false, status: 'Every track is already analysed', done: 0, total: 0, failed: 0 });
      return;
    }
    this.store.set({ running: true, done: 0, total: pending.length, failed: 0, status: `Analysing 0 of ${pending.length}...` });

    for (const entry of pending) {
      if (!(await this.waitForIdleDecks(generation))) return;
      const s = this.store.get();
      this.store.set({ status: `Analysing ${s.done + 1} of ${s.total}: ${entry.title}` });
      const ok = await this.analyseOne(entry, generation);
      if (generation !== this.generation) return;
      const now = this.store.get();
      this.store.set({ done: now.done + 1, failed: now.failed + (ok ? 0 : 1) });
    }
    const end = this.store.get();
    this.store.set({ running: false, status: `${end.done - end.failed} analysed${end.failed ? `, ${end.failed} could not be read` : ''}` });
  }

  /** Analyse one row and cache it; false if it could not be read or decoded. */
  private async analyseOne(entry: LibraryEntry, generation: number): Promise<boolean> {
    if (entry.source.kind !== 'file') return true;
    try {
      const file = await entry.source.getFile();
      const key = trackKey(file);
      const cached = await getTrack(key).catch(() => null);
      if (cached && hasCurrentAnalysis(cached)) {
        this.library.noteAnalysis(entry.id, cached.bpm, cached.camelot ?? null);
        return true;
      }
      const audio = await this.ctx.decodeAudioData(await file.arrayBuffer());
      if (generation !== this.generation) return true;
      const channels = Array.from({ length: Math.min(2, audio.numberOfChannels) }, (_, c) => audio.getChannelData(c).slice());
      const result = await this.client.analyse(channels, audio.sampleRate, () => undefined);
      const tags = entry.tagsKnown ? entry : await readTags(file);
      const analysis = {
        bpm: result.bpm,
        firstBeat: result.firstBeat,
        peaks: result.peaks,
        lufs: result.lufs,
        peakDb: result.peakDb,
        camelot: result.key,
        analysisVersion: ANALYSIS_VERSION,
      };
      // Merge: cues saved from a deck in the meantime must survive.
      await updateTrack(key, (existing) =>
        existing
          ? { ...existing, ...analysis }
          : { key, title: tags.title, artist: tags.artist, album: tags.album, duration: audio.duration, cuePoint: 0, hotCues: new Array(HOT_CUE_COUNT).fill(null), ...analysis },
      );
      this.library.noteAnalysis(entry.id, result.bpm, result.key);
      return true;
    } catch (error) {
      if (generation === this.generation) console.warn(`Background analysis of "${entry.title}" failed: ${errorText(error)}`);
      return false;
    }
  }
}
