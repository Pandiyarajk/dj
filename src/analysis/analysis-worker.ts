/**
 * Web Worker that analyses one track at a time: waveform peaks, then tempo.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { detectBpm } from './bpm';
import { computePeaks } from './peaks';
import type { AnalysisRequest, AnalysisResponse } from './analysis-client';

const post = (message: AnalysisResponse): void => (self as unknown as Worker).postMessage(message);

self.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  const { id, samples, sampleRate } = event.data;
  try {
    post({ id, type: 'progress', fraction: 0.05 });
    const peaks = computePeaks(samples, sampleRate);
    post({ id, type: 'progress', fraction: 0.35 });
    const tempo = detectBpm(samples, sampleRate);
    post({ id, type: 'done', peaks, bpm: tempo?.bpm ?? null, firstBeat: tempo?.firstBeat ?? 0, confidence: tempo?.confidence ?? 0 });
  } catch (error) {
    post({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
