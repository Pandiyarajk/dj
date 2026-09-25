/**
 * Loading a track onto a deck: read, decode, restore cached analysis and cues,
 * analyse if needed, and keep the cache up to date as cues change.
 *
 * Every step reports on the deck, so a slow or failed load is never silent.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (atomic merged writes, analysis versioning, per-deck
 *   cancellable analysis, flush on page hide, lower peak memory, undo last load)
 */
import { AnalysisClient, type AnalysisResult } from '../analysis/analysis-client';
import { formatTime, type DeckController, type SavedTrackData, type TrackInfo } from '../audio/deck-controller';
import { renderDemo } from '../demo/demo-tracks';
import { ANALYSIS_VERSION, getTrack, hasCurrentAnalysis, patchTrack, trackKey, updateTrack, type CachedTrack } from './db';
import { errorText, type Library, type LibraryEntry } from './library';
import { readTags } from './metadata';

/** Tags already known for a file (from the cache or a tag-read library row). */
interface TrackHint {
  title: string;
  artist: string;
  album: string;
}

/** What was loaded onto a deck: a library row or a loose file. */
export type LoadSource = { entry: LibraryEntry } | { file: File };

/** A deck's previous track, for undo. */
interface PreviousLoad {
  source: LoadSource;
  title: string;
  /** Where the previous track was, seconds. */
  position: number;
}

/** Wait this long after the last cue change before writing it to the cache, ms. */
const SAVE_DEBOUNCE_MS = 800;

interface PendingCues {
  cuePoint: number;
  hotCues: (number | null)[];
  deck: DeckController;
  timer: ReturnType<typeof setTimeout>;
}

export class TrackLoader {
  private readonly tokens = new Map<DeckController, number>();
  /** Library row currently on each deck, for BPM write-back. */
  private readonly rows = new Map<DeckController, string>();
  /** What each deck holds now, and what it held before the last load (undo). */
  private readonly current = new Map<DeckController, LoadSource>();
  private readonly previous = new Map<DeckController, PreviousLoad>();
  /** Deck of the most recent load, which Ctrl+Z undoes. */
  private lastLoaded: DeckController | null = null;
  /** One analysis worker per deck, so cancelling one load never stalls the other deck. */
  private readonly analysers = new Map<DeckController, AnalysisClient>();
  /** Unsaved cue edits per track key (not per deck: a deck may move on before the write). */
  private readonly pendingCues = new Map<string, PendingCues>();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly library: Library,
    decks: DeckController[],
  ) {
    for (const deck of decks) {
      this.analysers.set(deck, new AnalysisClient());
      this.persistCues(deck);
    }
    // The debounce would otherwise lose the last edit when the tab closes.
    window.addEventListener('pagehide', () => this.flushCues());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushCues();
    });
  }

  private begin(deck: DeckController): number {
    const token = (this.tokens.get(deck) ?? 0) + 1;
    this.tokens.set(deck, token);
    // A superseded analysis would otherwise keep this deck's worker busy.
    this.analysers.get(deck)?.cancel();
    return token;
  }

  private isCurrent(deck: DeckController, token: number): boolean {
    return this.tokens.get(deck) === token;
  }

  /**
   * Load onto a deck, remembering what was there so the load can be undone.
   *
   * @param restoreAt seek here once loaded (undo and session restore).
   */
  async load(deck: DeckController, source: LoadSource, restoreAt?: number): Promise<void> {
    const held = this.current.get(deck);
    const track = deck.state.track;
    if (held && track && deck.loaded) this.previous.set(deck, { source: held, title: track.title, position: deck.position() });
    this.current.set(deck, source);
    this.lastLoaded = deck;
    const after = restoreAt === undefined ? undefined : () => deck.seek(restoreAt);
    if ('entry' in source) await this.loadEntryWith(deck, source.entry, after);
    else await this.loadFileSource(deck, source.file, after);
  }

  /** Put back the deck's previous track at its old position (a second undo redoes). */
  async undo(deck: DeckController | null = this.lastLoaded): Promise<void> {
    const prev = deck ? this.previous.get(deck) : undefined;
    if (!deck || !prev) {
      (deck ?? null)?.notice('Nothing to undo');
      return;
    }
    if (deck.state.playing) {
      deck.notice('Deck is playing: pause it before undoing the load', 'warn');
      return;
    }
    await this.load(deck, prev.source, prev.position);
    if (deck.loaded) deck.notice(`Restored "${prev.title}" at ${formatTime(prev.position)}`);
  }

  /** What a deck holds now (for session save). */
  sourceOf(deck: DeckController): LoadSource | undefined {
    return this.current.get(deck);
  }

  /** Load a library row onto a deck. */
  loadEntry(deck: DeckController, entry: LibraryEntry, restoreAt?: number): Promise<void> {
    return this.load(deck, { entry }, restoreAt);
  }

  /** Load a dropped or picked file onto a deck. */
  loadFile(deck: DeckController, file: File): Promise<void> {
    return this.load(deck, { file });
  }

  private async loadEntryWith(deck: DeckController, entry: LibraryEntry, after?: () => void): Promise<void> {
    this.rows.set(deck, entry.id);
    if (entry.source.kind === 'demo') return this.loadDemo(deck, entry, after);
    const token = this.begin(deck);
    deck.beginLoad(`Opening "${entry.title}"...`);
    try {
      const file = await entry.source.getFile();
      // A row still showing a file-name guess is no hint: read the real tags.
      const hint = entry.tagsKnown ? { title: entry.title, artist: entry.artist, album: entry.album } : null;
      if (this.isCurrent(deck, token)) await this.loadFileWith(deck, file, token, hint, after);
    } catch (error) {
      if (this.isCurrent(deck, token)) deck.fail(`Could not open "${entry.title}": ${errorText(error)}`);
    }
  }

  private async loadFileSource(deck: DeckController, file: File, after?: () => void): Promise<void> {
    this.rows.delete(deck);
    const token = this.begin(deck);
    await this.loadFileWith(deck, file, token, null, after);
  }

  private async loadFileWith(deck: DeckController, file: File, token: number, hint: TrackHint | null, after?: () => void): Promise<void> {
    deck.beginLoad(`Reading "${file.name}"...`);
    const key = trackKey(file);
    try {
      const [bytes, cached] = await Promise.all([file.arrayBuffer(), getTrack(key).catch(() => null)]);
      if (!this.isCurrent(deck, token)) return;
      deck.setStatusText('Decoding...');
      let audio: AudioBuffer | null;
      try {
        audio = await this.ctx.decodeAudioData(bytes);
      } catch {
        throw new Error('the browser cannot decode this file (unsupported or damaged)');
      }
      if (!this.isCurrent(deck, token)) return;

      const tags: TrackHint = cached ?? hint ?? (await readTags(file));
      const info: TrackInfo = { key, title: tags.title, artist: tags.artist, duration: audio.duration };
      const upToDate = hasCurrentAnalysis(cached);
      // Stale analysis (older detector or peaks format) is dropped; cues are kept.
      const saved: SavedTrackData | null = cached && !upToDate ? { ...cached, bpm: null, peaks: null } : cached;
      // Downmix before handing the buffer over, then let the AudioBuffer go:
      // holding it through analysis doubled peak memory on long tracks.
      const channels = upToDate ? null : channelCopies(audio);
      const sampleRate = audio.sampleRate;
      deck.load(audio, info, saved);
      after?.();
      audio = null;
      if (!channels) return;

      const result = await this.analyse(deck, channels, sampleRate, token);
      if (!result) return;
      this.saveAnalysis(deck, { ...info, album: tags.album }, result);
    } catch (error) {
      if (this.isCurrent(deck, token)) deck.fail(`Could not load "${file.name}": ${errorText(error)}`);
    }
  }

  private async loadDemo(deck: DeckController, entry: LibraryEntry, after?: () => void): Promise<void> {
    if (entry.source.kind !== 'demo') return;
    const spec = entry.source.spec;
    const token = this.begin(deck);
    deck.beginLoad(`Rendering "${spec.title}"...`);
    // Yield a frame so the loading state paints before the synchronous render.
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (!this.isCurrent(deck, token)) return;
    try {
      const audio = renderDemo(spec, this.ctx);
      const channels = channelCopies(audio);
      deck.load(audio, { key: `demo:${spec.id}`, title: spec.title, artist: 'Built-in demo', duration: audio.duration }, null);
      after?.();
      await this.analyse(deck, channels, audio.sampleRate, token);
    } catch (error) {
      if (this.isCurrent(deck, token)) deck.fail(`Could not render demo: ${errorText(error)}`);
    }
  }

  /** Analyse PCM (transferred to the worker) and hand the result to the deck; null if superseded. */
  private async analyse(deck: DeckController, channels: Float32Array[], sampleRate: number, token: number): Promise<AnalysisResult | null> {
    const client = this.analysers.get(deck);
    if (!client) return null;
    try {
      const result = await client.analyse(channels, sampleRate, (fraction) => {
        if (this.isCurrent(deck, token)) deck.setAnalysisProgress(fraction);
      });
      if (!this.isCurrent(deck, token)) return null;
      deck.setAnalysis(result);
      const row = this.rows.get(deck);
      if (row) this.library.noteAnalysis(row, result.bpm, result.key);
      return result;
    } catch (error) {
      if (this.isCurrent(deck, token)) deck.fail(`Analysis failed: ${errorText(error)}`);
      return null;
    }
  }

  /**
   * Store fresh analysis. Merges into any existing record in one transaction:
   * the same track on the other deck may have saved cues in the meantime,
   * and a whole-record write would erase them.
   */
  private saveAnalysis(deck: DeckController, info: Omit<CachedTrack, keyof SavedTrackData>, result: AnalysisResult): void {
    const s = deck.state;
    const analysis = {
      bpm: result.bpm,
      firstBeat: result.firstBeat,
      peaks: result.peaks,
      lufs: result.lufs,
      peakDb: result.peakDb,
      camelot: result.key,
      analysisVersion: ANALYSIS_VERSION,
    };
    updateTrack(info.key, (existing) =>
      existing ? { ...existing, ...analysis } : { ...info, ...analysis, cuePoint: s.cuePoint, hotCues: s.hotCues },
    ).catch((error) => this.saveFailed(deck, error));
  }

  private saveFailed(deck: DeckController, error: unknown): void {
    console.warn('Track cache write failed', error);
    deck.notice('Could not save to the browser cache (storage full or blocked): cues will not be remembered', 'warn');
  }

  /** Write cue and hot-cue changes back to the cache, debounced per track. */
  private persistCues(deck: DeckController): void {
    deck.store.subscribe((state, previous) => {
      const track = state.track;
      if (!track || track.key.startsWith('demo:') || state.track !== previous.track) return;
      if (state.hotCues === previous.hotCues && state.cuePoint === previous.cuePoint) return;
      const pending = this.pendingCues.get(track.key);
      if (pending) clearTimeout(pending.timer);
      const timer = setTimeout(() => this.writeCues(track.key), SAVE_DEBOUNCE_MS);
      this.pendingCues.set(track.key, { cuePoint: state.cuePoint, hotCues: state.hotCues, deck, timer });
    });
  }

  private writeCues(key: string): void {
    const pending = this.pendingCues.get(key);
    if (!pending) return;
    this.pendingCues.delete(key);
    clearTimeout(pending.timer);
    patchTrack(key, { cuePoint: pending.cuePoint, hotCues: pending.hotCues }).catch((error) => this.saveFailed(pending.deck, error));
  }

  /** Write every pending cue edit now (page hidden or closing). */
  flushCues(): void {
    // Deleting visited entries while iterating a Map is safe.
    for (const key of this.pendingCues.keys()) this.writeCues(key);
  }
}

/**
 * Copies of the first two channels, for the worker (which downmixes itself,
 * after measuring loudness on the real channels).
 */
function channelCopies(audio: AudioBuffer): Float32Array[] {
  const count = Math.min(2, audio.numberOfChannels);
  return Array.from({ length: count }, (_, c) => audio.getChannelData(c).slice());
}
