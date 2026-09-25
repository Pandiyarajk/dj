/**
 * Played-track history: what was actually heard, when, on which deck.
 *
 * A track counts as played once it has been audible (playing, channel fader
 * up, crossfader not cutting it) for PLAYED_AFTER seconds, so previews and
 * loads that never went out are not logged.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { Store } from '../state/store';
import { getSetting, setSetting } from './db';

export interface HistoryItem {
  /** Epoch ms when it counted as played. */
  at: number;
  deck: 'A' | 'B';
  title: string;
  artist: string;
  bpm: number | null;
  key: string | null;
  /** Library row id, when it came from the library (to mark rows as played). */
  entryId: string | null;
}

export const PLAYED_AFTER = 30;
const HISTORY_KEY = 'history';
const MAX_ITEMS = 1000;

/** Quote a CSV field when it needs it. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Tracklist as CSV (time, deck, artist, title, BPM, key), oldest first. */
export function historyToCsv(items: HistoryItem[]): string {
  const rows = [['time', 'deck', 'artist', 'title', 'bpm', 'key']];
  for (const item of [...items].sort((a, b) => a.at - b.at)) {
    rows.push([new Date(item.at).toISOString(), item.deck, item.artist, item.title, item.bpm === null ? '' : item.bpm.toFixed(2), item.key ?? '']);
  }
  return rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n';
}

export class PlayHistory {
  readonly store = new Store<{ items: HistoryItem[] }>({ items: [] });

  async load(): Promise<void> {
    const items = await getSetting<HistoryItem[]>(HISTORY_KEY).catch(() => null);
    if (items) this.store.set({ items });
  }

  add(item: HistoryItem): void {
    const items = [item, ...this.store.get().items].slice(0, MAX_ITEMS);
    this.store.set({ items });
    void setSetting(HISTORY_KEY, items).catch(() => undefined);
  }

  clear(): void {
    this.store.set({ items: [] });
    void setSetting(HISTORY_KEY, []).catch(() => undefined);
  }

  /** Library row ids played in the log. */
  playedIds(): Set<string> {
    return new Set(this.store.get().items.map((i) => i.entryId).filter((id): id is string => id !== null));
  }
}
