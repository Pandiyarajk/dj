/**
 * Runs the real deck AudioWorklet processor under Node: stubs the
 * AudioWorkletGlobalScope (sampleRate, currentTime, AudioWorkletProcessor,
 * registerProcessor), then drives process() block by block.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import type { DeckCommand } from '../src/audio/worklets/deck-processor';

const QUANTUM = 128;

interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: (message: unknown) => void;
}

export interface ProcessorHandle {
  send(command: DeckCommand): void;
  /** Render `frames` of output; returns [left, right]. */
  render(frames: number): [Float32Array, Float32Array];
  /** Messages the processor posted. */
  messages: unknown[];
}

type ProcessorCtor = new () => { port: FakePort; process(i: Float32Array[][], o: Float32Array[][]): boolean };
let ctor: ProcessorCtor | null = null;

export async function deckProcessor(sampleRate = 48000): Promise<ProcessorHandle> {
  const g = globalThis as unknown as Record<string, unknown>;
  g.sampleRate = sampleRate;
  g.currentTime = 0;
  if (!ctor) {
    g.AudioWorkletProcessor = class {
      readonly messages: unknown[] = [];
      readonly port: FakePort = { onmessage: null, postMessage: (m: unknown) => this.messages.push(m) };
    };
    g.registerProcessor = (_name: string, c: ProcessorCtor) => {
      ctor = c;
    };
    await import('../src/audio/worklets/deck-processor');
  }
  const processor = new (ctor as ProcessorCtor)() as unknown as { port: FakePort; messages: unknown[]; process(i: Float32Array[][], o: Float32Array[][]): boolean };
  return {
    messages: processor.messages,
    send: (command) => processor.port.onmessage?.({ data: command }),
    render: (frames) => {
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let done = 0; done < frames; done += QUANTUM) {
        const l = new Float32Array(QUANTUM);
        const r = new Float32Array(QUANTUM);
        processor.process([], [[l, r]]);
        left.set(l.subarray(0, Math.min(QUANTUM, frames - done)), done);
        right.set(r.subarray(0, Math.min(QUANTUM, frames - done)), done);
        g.currentTime = (g.currentTime as number) + QUANTUM / sampleRate;
      }
      return [left, right];
    },
  };
}
