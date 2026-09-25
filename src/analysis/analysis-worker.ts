/**
 * Web Worker that analyses one track at a time: loudness, waveform peaks,
 * tempo and key.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (stereo input, loudness and key)
 */
import { detectBpm } from './bpm';
import { detectKey } from './key';
import { measureLoudness } from './loudness';
import { computePeaks } from './peaks';
import type { AnalysisRequest, AnalysisResponse } from './analysis-client';

const post = (message: AnalysisResponse): void => (self as unknown as Worker).postMessage(message);

/** Average the channels into one (in place into the first when stereo). */
function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const mono = channels[0];
  const scale = 1 / channels.length;
  for (let i = 0; i < mono.length; i++) {
    let sum = 0;
    for (const c of channels) sum += c[i];
    mono[i] = sum * scale;
  }
  return mono;
}

self.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  const { id, channels, sampleRate } = event.data;
  try {
    post({ id, type: 'progress', fraction: 0.05 });
    // Loudness first, on the real channels (a downmix misreads stereo width).
    const loudness = measureLoudness(channels, sampleRate);
    const samples = downmix(channels);
    post({ id, type: 'progress', fraction: 0.2 });
    const peaks = computePeaks(samples, sampleRate);
    post({ id, type: 'progress', fraction: 0.4 });
    const tempo = detectBpm(samples, sampleRate);
    post({ id, type: 'progress', fraction: 0.8 });
    const key = detectKey(samples, sampleRate);
    post({
      id,
      type: 'done',
      peaks,
      bpm: tempo?.bpm ?? null,
      firstBeat: tempo?.firstBeat ?? 0,
      confidence: tempo?.confidence ?? 0,
      lufs: Number.isFinite(loudness.lufs) ? loudness.lufs : null,
      peakDb: Number.isFinite(loudness.peakDb) ? loudness.peakDb : null,
      key: key?.camelot ?? null,
      keyName: key?.name ?? null,
    });
  } catch (error) {
    post({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
