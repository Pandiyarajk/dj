/**
 * Track tags: read with music-metadata, falling back to the file name.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */

export interface TrackTags {
  title: string;
  artist: string;
  album: string;
  /** Seconds, when the container reports it cheaply. */
  duration: number | null;
  /** BPM tag, if the file carries one. */
  bpm: number | null;
  /** Key tag as a Camelot code, if the file carries a readable one. */
  key: string | null;
}

const PITCH: Record<string, number> = { C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11 };
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

/**
 * Normalise a key tag to Camelot. Accepts Camelot ("8A"), Open Key ("1m" is
 * not supported: ambiguous), and note names ("Am", "A minor", "F#", "Ebmaj").
 */
export function keyTagToCamelot(tag: string | undefined | null): string | null {
  if (!tag) return null;
  const text = tag.trim();
  const camelot = /^(1[0-2]|[1-9])\s*([AB])$/i.exec(text);
  if (camelot) return `${Number(camelot[1])}${camelot[2].toUpperCase()}`;
  const note = /^([A-G])\s*([#b]?)\s*(m|min|minor|maj|major)?$/i.exec(text);
  if (!note) return null;
  const pitch = PITCH[(note[1] + note[2]).toUpperCase()];
  if (pitch === undefined) return null;
  const quality = (note[3] ?? '').toLowerCase();
  const minor = quality === 'm' || quality.startsWith('min');
  return `${(minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[pitch]}${minor ? 'A' : 'B'}`;
}

const EXTENSION = /\.[a-z0-9]{2,5}$/i;

/** Title and artist from a file name such as "Artist - Title.mp3". */
export function tagsFromFileName(name: string): TrackTags {
  const base = name.replace(EXTENSION, '').replace(/_/g, ' ').trim();
  const split = base.indexOf(' - ');
  if (split > 0) {
    return { title: base.slice(split + 3).trim(), artist: base.slice(0, split).trim(), album: '', duration: null, bpm: null, key: null };
  }
  return { title: base, artist: '', album: '', duration: null, bpm: null, key: null };
}

/** Read tags from a file; never throws, falls back to the file name. */
export async function readTags(file: File): Promise<TrackTags> {
  const fallback = tagsFromFileName(file.name);
  try {
    // Loaded on demand: the parser is large and only the library needs it.
    const { parseBlob } = await import('music-metadata');
    const { common, format } = await parseBlob(file, { skipCovers: true, duration: false });
    return {
      title: common.title?.trim() || fallback.title,
      artist: common.artist?.trim() || fallback.artist,
      album: common.album?.trim() ?? '',
      duration: format.duration ?? null,
      bpm: typeof common.bpm === 'number' && common.bpm > 0 ? common.bpm : null,
      key: keyTagToCamelot(common.key),
    };
  } catch {
    return fallback;
  }
}
