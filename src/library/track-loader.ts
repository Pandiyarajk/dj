/**
 * Loading a track onto a deck: read, decode, restore cached analysis and cues,
 * analyse if needed, and keep the cache up to date as cues change.
 *
 * Every step reports on the deck, so a slow or failed load is never silent.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import type { AnalysisClient } from '../analysis/analysis-client';
import type { DeckController, SavedTrackData, TrackInfo } from '../audio/deck-controller';
import { renderDemo } from '../demo/demo-tracks';
import { getTrack, patchTrack, putTrack, trackKey, type CachedTrack } from './db';
import { errorText, type Library, type LibraryEntry } from './library';
import { readTags } from './metadata';

/** Tags already known for a file (from the cache or the library row). */
interface TrackHint {
  title: string;
  artist: string;
  album: string;
}

/** Wait this long after the last cue change before writing it to the cache, ms. */
const SAVE_DEBOUNCE_MS = 800;

export class TrackLoader {
  private readonly tokens = new Map<DeckController, number>();
  /** Library row currently on each deck, for BPM write-back. */
  private readonly rows = new Map<DeckController, string>();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly analysis: AnalysisClient,
    private readonly library: Library,
    decks: DeckController[],
  ) {
    for (const deck of decks) this.persistCues(deck);
  }

  private begin(deck: DeckController): number {
    const token = (this.tokens.get(deck) ?? 0) + 1;
    this.tokens.set(deck, token);
    return token;
  }

  private current(deck: DeckController, token: number): boolean {
    return this.tokens.get(deck) === token;
  }

  /** Load a library row onto a deck. */
  async loadEntry(deck: DeckController, entry: LibraryEntry): Promise<void> {
    this.rows.set(deck, entry.id);
    if (entry.source.kind === 'demo') return this.loadDemo(deck, entry);
    const token = this.begin(deck);
    deck.beginLoad(`Opening "${entry.title}"...`);
    try {
      const file = await entry.source.getFile();
      if (this.current(deck, token)) await this.loadFileWith(deck, file, token, { title: entry.title, artist: entry.artist, album: entry.album });
    } catch (error) {
      if (this.current(deck, token)) deck.fail(`Could not open "${entry.title}": ${errorText(error)}`);
    }
  }

  /** Load a dropped or picked file onto a deck. */
  async loadFile(deck: DeckController, file: File): Promise<void> {
    this.rows.delete(deck);
    const token = this.begin(deck);
    await this.loadFileWith(deck, file, token, null);
  }

  private async loadFileWith(deck: DeckController, file: File, token: number, hint: TrackHint | null): Promise<void> {
    deck.beginLoad(`Reading "${file.name}"...`);
    const key = trackKey(file);
    try {
      const [bytes, cached] = await Promise.all([file.arrayBuffer(), getTrack(key).catch(() => null)]);
      if (!this.current(deck, token)) return;
      deck.setStatusText('Decoding...');
      let audio: AudioBuffer;
      try {
        audio = await this.ctx.decodeAudioData(bytes);
      } catch {
        throw new Error('the browser cannot decode this file (unsupported or damaged)');
      }
      if (!this.current(deck, token)) return;

      const tags: TrackHint = cached ?? hint ?? (await readTags(file));
      const info: TrackInfo = { key, title: tags.title, artist: tags.artist, duration: audio.duration };
      deck.load(audio, info, cached);
      if (cached?.peaks) return;

      const result = await this.analyse(deck, audio, token);
      if (!result) return;
      const record: CachedTrack = { ...info, album: tags.album, ...this.savedData(deck) };
      await putTrack(record).catch((error) => console.warn('Track cache write failed', error));
    } catch (error) {
      if (this.current(deck, token)) deck.fail(`Could not load "${file.name}": ${errorText(error)}`);
    }
  }

  private async loadDemo(deck: DeckController, entry: LibraryEntry): Promise<void> {
    if (entry.source.kind !== 'demo') return;
    const spec = entry.source.spec;
    const token = this.begin(deck);
    deck.beginLoad(`Rendering "${spec.title}"...`);
    // Yield a frame so the loading state paints before the synchronous render.
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (!this.current(deck, token)) return;
    try {
      const audio = renderDemo(spec, this.ctx);
      deck.load(audio, { key: `demo:${spec.id}`, title: spec.title, artist: 'Built-in demo', duration: audio.duration }, null);
      await this.analyse(deck, audio, token);
    } catch (error) {
      if (this.current(deck, token)) deck.fail(`Could not render demo: ${errorText(error)}`);
    }
  }

  /** Analyse a decoded track and hand the result to the deck; null if superseded. */
  private async analyse(deck: DeckController, audio: AudioBuffer, token: number) {
    const mono = downmix(audio);
    try {
      const result = await this.analysis.analyse(mono, audio.sampleRate, (fraction) => {
        if (this.current(deck, token)) deck.setAnalysisProgress(fraction);
      });
      if (!this.current(deck, token)) return null;
      deck.setAnalysis(result);
      const row = this.rows.get(deck);
      if (row) this.library.noteBpm(row, result.bpm);
      return result;
    } catch (error) {
      if (this.current(deck, token)) deck.fail(`Analysis failed: ${errorText(error)}`);
      return null;
    }
  }

  private savedData(deck: DeckController): SavedTrackData {
    const s = deck.state;
    return { bpm: s.bpm, firstBeat: s.firstBeat, peaks: s.peaks, cuePoint: s.cuePoint, hotCues: s.hotCues };
  }

  /** Write cue and hot-cue changes back to the cache, debounced. */
  private persistCues(deck: DeckController): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    deck.store.subscribe((state, previous) => {
      const track = state.track;
      if (!track || track.key.startsWith('demo:') || state.track !== previous.track) return;
      if (state.hotCues === previous.hotCues && state.cuePoint === previous.cuePoint) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        patchTrack(track.key, { cuePoint: state.cuePoint, hotCues: state.hotCues }).catch((error) =>
          console.warn('Cue cache write failed', error),
        );
      }, SAVE_DEBOUNCE_MS);
    });
  }
}

/** Average all channels into one. */
function downmix(audio: AudioBuffer): Float32Array {
  const mono = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i];
  }
  if (audio.numberOfChannels > 1) {
    const scale = 1 / audio.numberOfChannels;
    for (let i = 0; i < mono.length; i++) mono[i] *= scale;
  }
  return mono;
}
