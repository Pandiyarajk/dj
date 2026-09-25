/**
 * Main-thread client for the analysis worker.
 *
 * One client (and so one worker) per deck, so cancelling a superseded load
 * never disturbs the other deck's analysis.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (cancel)
 */
import type { Peaks } from './peaks';

export interface AnalysisRequest {
  id: number;
  /** One array per channel (stereo for loudness); transferred to the worker. */
  channels: Float32Array[];
  sampleRate: number;
}

export interface AnalysisResult {
  peaks: Peaks;
  bpm: number | null;
  firstBeat: number;
  confidence: number;
  /** Integrated loudness, LUFS; null for silence. */
  lufs: number | null;
  /** Sample peak, dBFS. */
  peakDb: number | null;
  /** Camelot key code ("8A") and name ("A minor"), or null when atonal. */
  key: string | null;
  keyName: string | null;
}

export type AnalysisResponse =
  | { id: number; type: 'progress'; fraction: number }
  | ({ id: number; type: 'done' } & AnalysisResult)
  | { id: number; type: 'error'; message: string };

interface Pending {
  resolve: (result: AnalysisResult) => void;
  reject: (error: Error) => void;
  onProgress: (fraction: number) => void;
}

export class AnalysisClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./analysis-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<AnalysisResponse>) => {
      const message = event.data;
      const job = this.pending.get(message.id);
      if (!job) return;
      if (message.type === 'progress') {
        job.onProgress(message.fraction);
      } else if (message.type === 'done') {
        this.pending.delete(message.id);
        job.resolve(message);
      } else {
        this.pending.delete(message.id);
        job.reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      // A worker that fails to load or throws at top level strands every job.
      const error = new Error(`Analysis worker failed: ${event.message || 'could not start'}`);
      for (const job of this.pending.values()) job.reject(error);
      this.pending.clear();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  /**
   * Abandon every job in flight. The worker is terminated (analysis is
   * synchronous inside it, so there is no other way to stop it) and restarted
   * lazily on the next job; pending promises reject with an AbortError.
   * Without this, a superseded 10-minute analysis blocked the next load.
   */
  cancel(): void {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    const error = new DOMException('Analysis superseded', 'AbortError');
    for (const job of this.pending.values()) job.reject(error);
    this.pending.clear();
  }

  /**
   * Analyse mono PCM off the main thread.
   *
   * @param channels per-channel PCM; the buffers are transferred and unusable afterwards.
   */
  analyse(channels: Float32Array[], sampleRate: number, onProgress: (fraction: number) => void): Promise<AnalysisResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      const request: AnalysisRequest = { id, channels, sampleRate };
      this.ensureWorker().postMessage(request, channels.map((c) => c.buffer));
    });
  }
}
