/**
 * Main-thread client for the analysis worker.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import type { Peaks } from './peaks';

export interface AnalysisRequest {
  id: number;
  samples: Float32Array;
  sampleRate: number;
}

export interface AnalysisResult {
  peaks: Peaks;
  bpm: number | null;
  firstBeat: number;
  confidence: number;
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
   * Analyse mono PCM off the main thread.
   *
   * @param samples mono samples; the buffer is transferred and unusable afterwards.
   */
  analyse(samples: Float32Array, sampleRate: number, onProgress: (fraction: number) => void): Promise<AnalysisResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      const request: AnalysisRequest = { id, samples, sampleRate };
      this.ensureWorker().postMessage(request, [samples.buffer]);
    });
  }
}
