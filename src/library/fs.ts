/**
 * Finding audio files: folder picker (File System Access API) with a plain
 * file-input fallback for browsers without it.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */

export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'mp4', 'webm', 'aif', 'aiff'];

export function isAudioFileName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && AUDIO_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

export function supportsFolderPicker(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  if (!window.showDirectoryPicker) throw new Error('This browser cannot open folders; use Add files instead');
  return window.showDirectoryPicker({ id: 'dj-library', mode: 'read' });
}

/**
 * Make sure we may read a (possibly restored) folder handle.
 * Must be called from a user gesture if the browser needs to prompt.
 */
export async function ensureReadPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

export interface FoundFile {
  handle: FileSystemFileHandle;
  /** Path relative to the picked folder, "/"-separated. */
  path: string;
}

/** Recursively list audio files under `dir`. */
export async function* walkAudioFiles(dir: FileSystemDirectoryHandle, prefix = ''): AsyncGenerator<FoundFile> {
  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      yield* walkAudioFiles(handle as FileSystemDirectoryHandle, path);
    } else if (isAudioFileName(name)) {
      yield { handle: handle as FileSystemFileHandle, path };
    }
  }
}

/** Open a multi-file picker; resolves with the chosen audio files (possibly none). */
export function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = AUDIO_EXTENSIONS.map((e) => `.${e}`).join(',') + ',audio/*';
    input.addEventListener('change', () => resolve(Array.from(input.files ?? []).filter((f) => isAudioFileName(f.name))));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}
