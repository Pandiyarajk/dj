/**
 * The track library: where tracks come from (a folder, loose files or the
 * built-in demos) and what is known about each one.
 *
 * Scanning lists files immediately from their names, then fills in tags and
 * cached BPMs in the background so a large folder is browsable at once.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (tagsKnown, independent scan and add-files jobs)
 */
import { Store } from '../state/store';
import { getSetting, getTrack, setSetting, trackKey } from './db';
import { ensureReadPermission, pickFiles, pickFolder, walkAudioFiles } from './fs';
import { readTags, tagsFromFileName } from './metadata';
import type { DemoSpec } from '../demo/demo-tracks';

export interface LibraryEntry {
  /** Unique row id: the path within the source. */
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number | null;
  bpm: number | null;
  /** Camelot key code, from analysis or the file's key tag. */
  key: string | null;
  /**
   * True once title/artist come from the file's tags (or the cache) rather
   * than a guess from the file name. A guess must never be cached as the tags.
   */
  tagsKnown: boolean;
  /** Where the track comes from. */
  source: { kind: 'file'; getFile: () => Promise<File> } | { kind: 'demo'; spec: DemoSpec };
}

export interface LibraryState {
  entries: LibraryEntry[];
  /** Always-visible description of what the library is doing. */
  status: string;
  busy: boolean;
  /** True when a folder from a previous session can be reopened. */
  canReopen: boolean;
}

const LAST_FOLDER = 'lastFolder';
/** Parallel tag reads while enriching a scan. */
const TAG_CONCURRENCY = 4;

export class Library {
  readonly store = new Store<LibraryState>({ entries: [], status: 'No music loaded yet', busy: false, canReopen: false });
  /** Bumped by each folder scan; an older scan and its tag reads stop. */
  private scanGeneration = 0;

  constructor() {
    getSetting<FileSystemDirectoryHandle>(LAST_FOLDER)
      .then((handle) => this.store.set({ canReopen: handle !== null }))
      .catch(() => undefined);
  }

  /** Update BPM and key for an entry once a deck has analysed it. */
  noteAnalysis(id: string, bpm: number | null, key: string | null): void {
    const entries = this.store.get().entries.map((e) => (e.id === id ? { ...e, bpm, key: key ?? e.key } : e));
    this.store.set({ entries });
  }

  addDemos(specs: DemoSpec[]): void {
    const demos: LibraryEntry[] = specs.map((spec) => ({
      id: `demo:${spec.id}`,
      title: spec.title,
      artist: 'Built-in demo',
      album: '',
      duration: spec.seconds,
      bpm: spec.bpm,
      key: null,
      tagsKnown: true,
      source: { kind: 'demo', spec },
    }));
    const others = this.store.get().entries.filter((e) => e.source.kind !== 'demo');
    this.store.set({ entries: [...demos, ...others], status: `${demos.length} demo tracks added` });
  }

  async openFolder(): Promise<void> {
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await pickFolder();
    } catch (error) {
      // AbortError = the user closed the picker; say so rather than doing nothing visible.
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      this.store.set({ status: aborted ? 'Folder picker closed, nothing changed' : errorText(error) });
      return;
    }
    setSetting(LAST_FOLDER, handle)
      .then(() => this.store.set({ canReopen: true }))
      .catch(() => undefined);
    await this.scanFolder(handle);
  }

  async reopenFolder(): Promise<void> {
    const handle = await getSetting<FileSystemDirectoryHandle>(LAST_FOLDER).catch(() => null);
    if (!handle) {
      this.store.set({ status: 'No previous folder to reopen', canReopen: false });
      return;
    }
    if (!(await ensureReadPermission(handle).catch(() => false))) {
      this.store.set({ status: `Permission to read "${handle.name}" was not granted` });
      return;
    }
    await this.scanFolder(handle);
  }

  async addFiles(files?: File[]): Promise<void> {
    const chosen = files ?? (await pickFiles());
    if (chosen.length === 0) {
      this.store.set({ status: 'No audio files chosen, nothing changed' });
      return;
    }
    const entries = chosen.map((file) => fileEntry(`file:${file.name}:${file.size}:${file.lastModified}`, file.name, async () => file));
    this.merge(entries, false);
    // Not tied to the scan generation: adding files must not cancel a folder
    // scan in progress, and a scan must not strand these files' tag reads.
    await this.enrich(entries, () => true);
  }

  private async scanFolder(dir: FileSystemDirectoryHandle): Promise<void> {
    const generation = ++this.scanGeneration;
    const isCurrent = (): boolean => generation === this.scanGeneration;
    this.store.set({ busy: true, status: `Scanning "${dir.name}"...` });
    const found: LibraryEntry[] = [];
    try {
      for await (const { handle, path } of walkAudioFiles(dir)) {
        if (!isCurrent()) return;
        found.push(fileEntry(`${dir.name}/${path}`, handle.name, () => handle.getFile()));
        if (found.length % 200 === 0) this.store.set({ status: `Scanning "${dir.name}": ${found.length} tracks...` });
      }
    } catch (error) {
      this.store.set({ busy: false, status: `Scan failed: ${errorText(error)}` });
      return;
    }
    this.merge(found, true);
    if (found.length === 0) {
      this.store.set({ busy: false, status: `No audio files found in "${dir.name}"` });
      return;
    }
    await this.enrich(found, isCurrent);
  }

  /** Put entries in the table; a folder scan replaces earlier file entries. */
  private merge(entries: LibraryEntry[], replaceFiles: boolean): void {
    const kept = this.store.get().entries.filter((e) => (replaceFiles ? e.source.kind === 'demo' : !entries.some((n) => n.id === e.id)));
    this.store.set({ entries: [...kept, ...entries] });
  }

  /** Fill in tags and cached BPMs, a few files at a time. */
  private async enrich(entries: LibraryEntry[], isCurrent: () => boolean): Promise<void> {
    this.store.set({ busy: true });
    let done = 0;
    let next = 0;
    const updates = new Map<string, Partial<LibraryEntry>>();
    const flush = (): void => {
      if (updates.size === 0) return;
      const entriesNow = this.store.get().entries.map((e) => {
        const patch = updates.get(e.id);
        // Tags never replace a known value with an unknown one: a deck may have
        // analysed this track's BPM while its tags were still being read.
        return patch ? { ...e, ...patch, bpm: patch.bpm ?? e.bpm, key: patch.key ?? e.key, duration: patch.duration ?? e.duration } : e;
      });
      updates.clear();
      // A superseded job still lands its finished rows, but must not overwrite the current job's status.
      this.store.set(isCurrent() ? { entries: entriesNow, status: `Reading tags: ${done} of ${entries.length}` } : { entries: entriesNow });
    };
    const timer = setInterval(flush, 300);

    const worker = async (): Promise<void> => {
      while (next < entries.length && isCurrent()) {
        const entry = entries[next++];
        if (entry.source.kind !== 'file') continue;
        try {
          const file = await entry.source.getFile();
          const cached = await getTrack(trackKey(file)).catch(() => null);
          if (cached) {
            updates.set(entry.id, { title: cached.title, artist: cached.artist, album: cached.album, duration: cached.duration, bpm: cached.bpm, key: cached.camelot ?? null, tagsKnown: true });
          } else {
            const tags = await readTags(file);
            updates.set(entry.id, { title: tags.title, artist: tags.artist, album: tags.album, duration: tags.duration, bpm: tags.bpm, key: tags.key, tagsKnown: true });
          }
        } catch {
          // Unreadable file: keep the name-based entry; loading it will report the error.
        }
        done++;
      }
    };

    await Promise.all(Array.from({ length: TAG_CONCURRENCY }, worker));
    clearInterval(timer);
    flush();
    if (isCurrent()) {
      const total = this.store.get().entries.filter((e) => e.source.kind === 'file').length;
      this.store.set({ busy: false, status: `${total} track${total === 1 ? '' : 's'} in library` });
    }
  }
}

function fileEntry(id: string, name: string, getFile: () => Promise<File>): LibraryEntry {
  const tags = tagsFromFileName(name);
  return { id, title: tags.title, artist: tags.artist, album: '', duration: null, bpm: null, key: null, tagsKnown: false, source: { kind: 'file', getFile } };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
