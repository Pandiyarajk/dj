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
}

const EXTENSION = /\.[a-z0-9]{2,5}$/i;

/** Title and artist from a file name such as "Artist - Title.mp3". */
export function tagsFromFileName(name: string): TrackTags {
  const base = name.replace(EXTENSION, '').replace(/_/g, ' ').trim();
  const split = base.indexOf(' - ');
  if (split > 0) {
    return { title: base.slice(split + 3).trim(), artist: base.slice(0, split).trim(), album: '', duration: null, bpm: null };
  }
  return { title: base, artist: '', album: '', duration: null, bpm: null };
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
    };
  } catch {
    return fallback;
  }
}
