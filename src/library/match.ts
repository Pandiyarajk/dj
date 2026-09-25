/**
 * Pure helpers for finding the next track: search matching and tempo
 * distance to the deck on air.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { compatibleKeys } from '../analysis/key';
import { tempoForSync } from '../audio/sync';

export interface Searchable {
  title: string;
  artist: string;
  album: string;
  bpm: number | null;
  key: string | null;
}

/** BPM queries match within this many BPM. */
const BPM_QUERY_TOLERANCE = 1;

/**
 * Whether an entry matches a search. Text matches title, artist or album; a
 * plain number matches BPM (within 1 BPM); a Camelot code ("8A") matches key.
 */
export function matchesQuery(entry: Searchable, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (/^\d{2,3}(\.\d+)?$/.test(q)) return entry.bpm !== null && Math.abs(entry.bpm - Number(q)) <= BPM_QUERY_TOLERANCE;
  if (/^(1[0-2]|[1-9])[ab]$/.test(q)) return entry.key?.toLowerCase() === q;
  return entry.title.toLowerCase().includes(q) || entry.artist.toLowerCase().includes(q) || entry.album.toLowerCase().includes(q);
}

/**
 * Tempo change (percent) a track at `bpm` needs to match `reference`,
 * allowing half and double time; null when the track has no BPM.
 */
export function bpmDelta(bpm: number | null, reference: number): number | null {
  if (bpm === null) return null;
  return tempoForSync(reference, bpm).tempo * 100;
}

/**
 * Suggestion score for the next track (lower is better): the tempo change
 * needed, plus a penalty for a clashing key and a large one for a track
 * already played. Null when the track has no BPM.
 */
export function suggestionScore(entry: { bpm: number | null; key: string | null }, reference: { bpm: number; key: string | null }, played: boolean): number | null {
  const delta = bpmDelta(entry.bpm, reference.bpm);
  if (delta === null) return null;
  let score = Math.abs(delta);
  if (reference.key && entry.key && !compatibleKeys(reference.key).includes(entry.key)) score += 4;
  if (played) score += 100;
  return score;
}
