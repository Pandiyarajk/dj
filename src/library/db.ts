/**
 * IndexedDB cache: per-track analysis, cues and tags, plus small settings
 * (such as the last library folder handle).
 *
 * The cache is a convenience. Every function rejects if IndexedDB is
 * unavailable (private windows, blocked storage) and callers carry on without it.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import type { SavedTrackData } from '../audio/deck-controller';

export interface CachedTrack extends SavedTrackData {
  key: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
}

const DB_NAME = 'dj';
const DB_VERSION = 1;
const TRACKS = 'tracks';
const SETTINGS = 'settings';

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (opening) return opening;
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TRACKS)) db.createObjectStore(TRACKS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'));
  });
  // Let a later call retry after a failure instead of caching the rejection.
  attempt.catch(() => {
    opening = null;
  });
  opening = attempt;
  return attempt;
}

async function run<T>(store: string, mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = body(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error ?? request.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Cache key for a file: name, size and modification time. Cheap to compute
 * (no hashing) and stable across sessions and folder moves.
 */
export function trackKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export async function getTrack(key: string): Promise<CachedTrack | null> {
  const result = await run<CachedTrack | undefined>(TRACKS, 'readonly', (s) => s.get(key));
  return result ?? null;
}

export async function putTrack(track: CachedTrack): Promise<void> {
  await run(TRACKS, 'readwrite', (s) => s.put(track));
}

/** Merge fields into an existing record; does nothing if the track was never cached. */
export async function patchTrack(key: string, patch: Partial<CachedTrack>): Promise<void> {
  const existing = await getTrack(key);
  if (existing) await putTrack({ ...existing, ...patch, key });
}

export async function getSetting<T>(name: string): Promise<T | null> {
  const result = await run<T | undefined>(SETTINGS, 'readonly', (s) => s.get(name) as IDBRequest<T | undefined>);
  return result ?? null;
}

export async function setSetting(name: string, value: unknown): Promise<void> {
  await run(SETTINGS, 'readwrite', (s) => s.put(value, name));
}
