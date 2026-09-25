/**
 * AudioWorklet processor that taps the master bus for mix recording.
 *
 * Collects about 100 ms of stereo PCM at a time and transfers it to the main
 * thread; outputs silence (it is connected only so the graph keeps pulling it).
 * Must not import anything: it is loaded standalone by audioWorklet.addModule().
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */

declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

export type RecorderCommand = { type: 'start' } | { type: 'stop' };
export type RecorderReport = { type: 'chunk'; left: Float32Array; right: Float32Array } | { type: 'stopped' };

class RecorderProcessor extends AudioWorkletProcessor {
  private recording = false;
  private readonly size = Math.round(sampleRate / 10);
  private left = new Float32Array(this.size);
  private right = new Float32Array(this.size);
  private fill = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<RecorderCommand>) => {
      if (event.data.type === 'start') {
        this.recording = true;
        this.fill = 0;
      } else {
        this.flush();
        this.recording = false;
        this.port.postMessage({ type: 'stopped' } satisfies RecorderReport);
      }
    };
  }

  private flush(): void {
    if (this.fill === 0) return;
    const left = this.left.slice(0, this.fill);
    const right = this.right.slice(0, this.fill);
    this.port.postMessage({ type: 'chunk', left, right } satisfies RecorderReport, [left.buffer, right.buffer]);
    this.fill = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.recording) return true;
    const input = inputs[0];
    const inL = input?.[0];
    const inR = input?.[1] ?? inL;
    const frames = inL?.length ?? 128;
    for (let i = 0; i < frames; i++) {
      // No input connected yet (or silence): record zeros, keeping time.
      this.left[this.fill] = inL ? inL[i] : 0;
      this.right[this.fill] = inR ? inR[i] : 0;
      if (++this.fill === this.size) this.flush();
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
