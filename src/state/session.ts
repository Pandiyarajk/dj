/**
 * Session save and restore: what was on the decks and the mixer, so a reload
 * or crash mid-set can be undone.
 *
 * The session is written every couple of seconds and on page hide. On the
 * next visit a banner offers to restore it; nothing is restored unasked.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import type { DeckController } from '../audio/deck-controller';
import { defaultChannel, defaultMixer, type MixerState } from '../audio/mixer';
import { getSetting, setSetting } from '../library/db';
import type { Library, LibraryEntry } from '../library/library';
import type { TrackLoader } from '../library/track-loader';
import type { Store } from './store';
import { formatTime } from '../audio/deck-controller';

const SESSION_KEY = 'session';
/**
 * Synchronous mirror written on page hide: the IndexedDB write started there
 * does not land before unload, so the banner showed a position up to 2 s old.
 */
const MIRROR_KEY = 'dj.session';
const SAVE_EVERY_MS = 2000;
/** Older sessions are not offered. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SessionDeck {
  /** Library row id, or null for a loose file (which cannot be reopened). */
  entryId: string | null;
  title: string;
  position: number;
  tempo: number;
  tempoRange: number;
  quantize: boolean;
  loopSize: number;
}

export interface Session {
  savedAt: number;
  decks: (SessionDeck | null)[];
  mixer: MixerState;
}

/** One-line description of a saved deck for the restore banner. */
export function describeDeck(id: string, deck: SessionDeck | null): string {
  return deck ? `Deck ${id}: ${deck.title} at ${formatTime(deck.position)}` : `Deck ${id}: empty`;
}

/** Fill in fields a saved mixer from an older version may lack. */
export function upgradeMixer(saved: Partial<MixerState>): MixerState {
  const base = defaultMixer();
  const channels = (saved.channels ?? base.channels).map((c) => ({ ...defaultChannel(), ...c })) as MixerState['channels'];
  return { ...base, ...saved, channels };
}

export class SessionManager {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly decks: DeckController[],
    private readonly mixer: Store<MixerState>,
    private readonly loader: TrackLoader,
    private readonly library: Library,
  ) {}

  /** Start saving periodically and on page hide. */
  start(): void {
    this.timer = setInterval(() => void this.save(), SAVE_EVERY_MS);
    const saveNow = (): void => {
      const session = this.snapshot();
      if (!session) return;
      try {
        localStorage.setItem(MIRROR_KEY, JSON.stringify(session));
      } catch {
        // Storage blocked or full: the periodic IndexedDB save still applies.
      }
      void setSetting(SESSION_KEY, session).catch(() => undefined);
    };
    window.addEventListener('pagehide', saveNow);
    window.addEventListener('beforeunload', saveNow);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private snapshot(): Session | null {
    const decks = this.decks.map((deck): SessionDeck | null => {
      const track = deck.state.track;
      if (!deck.loaded || !track) return null;
      const source = this.loader.sourceOf(deck);
      const entryId = source && 'entry' in source ? source.entry.id : null;
      const s = deck.state;
      return { entryId, title: track.title, position: deck.position(), tempo: s.tempo, tempoRange: s.tempoRange, quantize: s.quantize, loopSize: s.loopSize };
    });
    // An empty console is not worth offering back.
    if (decks.every((d) => d === null)) return null;
    return { savedAt: Date.now(), decks, mixer: this.mixer.get() };
  }

  async save(): Promise<void> {
    const session = this.snapshot();
    if (session) await setSetting(SESSION_KEY, session).catch(() => undefined);
  }

  /** The saved session if it is recent enough to offer, else null. */
  async saved(): Promise<Session | null> {
    const stored = await getSetting<Session>(SESSION_KEY).catch(() => null);
    const mirror = ((): Session | null => {
      try {
        const raw = localStorage.getItem(MIRROR_KEY);
        return raw ? (JSON.parse(raw) as Session) : null;
      } catch {
        return null;
      }
    })();
    // The newer of the two: the mirror usually wins after a reload.
    const session = [stored, mirror].filter((s): s is Session => s !== null && Array.isArray(s.decks)).sort((a, b) => b.savedAt - a.savedAt)[0];
    if (!session || Date.now() - session.savedAt > MAX_AGE_MS) return null;
    return session;
  }

  async discard(): Promise<void> {
    try {
      localStorage.removeItem(MIRROR_KEY);
    } catch {
      // Nothing to remove.
    }
    await setSetting(SESSION_KEY, null).catch(() => undefined);
  }

  /**
   * Put a saved session back: mixer first, then each deck's track at its
   * position (paused). Must run from a user gesture: reopening the library
   * folder may need a permission prompt.
   *
   * @returns one message per deck saying what happened.
   */
  async restore(session: Session): Promise<string[]> {
    this.mixer.set(upgradeMixer(session.mixer));
    const find = (id: string): LibraryEntry | undefined => this.library.store.get().entries.find((e) => e.id === id);
    const needsFolder = session.decks.some((d) => d?.entryId && !d.entryId.startsWith('demo:') && !d.entryId.startsWith('file:') && !find(d.entryId));
    if (needsFolder) await this.library.reopenFolder();

    const results: string[] = [];
    await Promise.all(
      this.decks.map(async (deck, i) => {
        const saved = session.decks[i];
        if (!saved) return;
        const entry = saved.entryId ? find(saved.entryId) : undefined;
        if (!entry) {
          const why = saved.entryId === null || saved.entryId.startsWith('file:') ? 'it was a loose file: add or drop it again' : 'open its folder again';
          deck.notice(`Could not restore "${saved.title}": ${why}`, 'warn');
          results.push(`Deck ${deck.id}: not restored`);
          return;
        }
        await this.loader.loadEntry(deck, entry, saved.position);
        if (!deck.loaded) {
          results.push(`Deck ${deck.id}: failed to load`);
          return;
        }
        deck.setTempoRange(saved.tempoRange);
        deck.applyTempo(saved.tempo, false);
        if (deck.state.quantize !== saved.quantize) deck.toggleQuantize();
        deck.setLoopSize(saved.loopSize);
        deck.notice(`Restored at ${formatTime(saved.position)}`);
        results.push(`Deck ${deck.id}: restored`);
      }),
    );
    return results;
  }
}
