/**
 * Mix recording: the master bus, post-limiter, as 16-bit stereo WAV.
 *
 * With the File System Access API the recording streams straight to a file
 * the user picks (an hour-long set never sits in memory); otherwise it is
 * kept in memory and offered as a download when stopped.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { Store } from '../state/store';
import { MAX_WAV_DATA_BYTES, toPcm16, wavHeader } from './wav';
import type { RecorderReport } from './worklets/recorder-processor';

export interface RecorderState {
  recording: boolean;
  /** Seconds recorded so far. */
  seconds: number;
  bytes: number;
  /** Always-visible result or error line. */
  status: string;
}

interface FileSink {
  kind: 'file';
  writable: FileSystemWritableFileStream;
  name: string;
}

interface MemorySink {
  kind: 'memory';
  chunks: ArrayBuffer[];
}

export class MixRecorder {
  readonly store = new Store<RecorderState>({ recording: false, seconds: 0, bytes: 0, status: '' });
  /** Last in-memory recording (also what the download link points at). */
  lastBlob: Blob | null = null;
  private sink: FileSink | MemorySink | null = null;
  private writes: Promise<void> = Promise.resolve();
  private stopped: (() => void) | null = null;

  constructor(
    private readonly node: AudioWorkletNode,
    private readonly sampleRate: number,
  ) {
    node.port.onmessage = (event: MessageEvent<RecorderReport>) => this.onReport(event.data);
  }

  private onReport(report: RecorderReport): void {
    if (report.type === 'stopped') {
      this.stopped?.();
      return;
    }
    const sink = this.sink;
    if (!sink) return;
    const pcm = toPcm16(report.left, report.right);
    const s = this.store.get();
    if (s.bytes + pcm.byteLength > MAX_WAV_DATA_BYTES) {
      // RIFF cannot describe more than 4 GB (about 6 hours): stop cleanly.
      void this.stop('Stopped at the 4 GB WAV limit');
      return;
    }
    if (sink.kind === 'memory') sink.chunks.push(pcm);
    else this.writes = this.writes.then(() => sink.writable.write(pcm));
    this.store.set({ bytes: s.bytes + pcm.byteLength, seconds: (s.bytes + pcm.byteLength) / (this.sampleRate * 4) });
  }

  /**
   * Start recording. Call from a user gesture (the file picker needs one).
   *
   * @param options.memory record in memory even if a file picker exists (tests, or by choice).
   */
  async start(options: { memory?: boolean } = {}): Promise<void> {
    if (this.store.get().recording) return;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
    const name = `dj-mix-${stamp}.wav`;
    const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (!options.memory && picker) {
      try {
        const handle = await picker({ suggestedName: name, types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }] });
        const writable = await handle.createWritable();
        await writable.write(wavHeader(0, this.sampleRate));
        this.sink = { kind: 'file', writable, name: handle.name };
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        this.store.set({ status: aborted ? 'Recording not started (no file chosen)' : `Could not open the file: ${String(error)}` });
        return;
      }
    } else {
      this.sink = { kind: 'memory', chunks: [] };
    }
    this.writes = Promise.resolve();
    this.lastBlob = null;
    this.store.set({ recording: true, seconds: 0, bytes: 0, status: this.sink.kind === 'file' ? `Recording to ${this.sink.name}` : 'Recording (in memory)' });
    this.node.port.postMessage({ type: 'start' });
  }

  /** Stop, finish the file (or build the download) and report what was written. */
  async stop(reason?: string): Promise<void> {
    const sink = this.sink;
    if (!sink || !this.store.get().recording) return;
    const done = new Promise<void>((resolve) => (this.stopped = resolve));
    this.node.port.postMessage({ type: 'stop' });
    await done;
    this.stopped = null;
    this.sink = null;
    const { bytes, seconds } = this.store.get();
    const header = wavHeader(bytes, this.sampleRate);
    const length = formatDuration(seconds);
    try {
      if (sink.kind === 'file') {
        await this.writes;
        // Patch the header now the size is known, then close.
        await sink.writable.write({ type: 'write', position: 0, data: header });
        await sink.writable.close();
        this.store.set({ recording: false, status: `${reason ? `${reason}. ` : ''}Saved ${length} to ${sink.name}` });
      } else {
        this.lastBlob = new Blob([header, ...sink.chunks], { type: 'audio/wav' });
        this.download(this.lastBlob);
        this.store.set({ recording: false, status: `${reason ? `${reason}. ` : ''}Recorded ${length}: downloading` });
      }
    } catch (error) {
      this.store.set({ recording: false, status: `Recording could not be saved: ${String(error)}` });
    }
  }

  toggle(): void {
    if (this.store.get().recording) void this.stop();
    else void this.start();
  }

  private download(blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `dj-mix-${new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')}.wav`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export function formatDuration(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}
