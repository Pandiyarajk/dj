/**
 * Built-in demo tracks, rendered on demand by the synthesiser.
 *
 * They make the app usable with no music files, and give `?demo=1` something
 * deterministic to load for smoke tests.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { renderPattern, type PatternStyle } from './synth';

export interface DemoSpec {
  id: string;
  title: string;
  bpm: number;
  seconds: number;
  style: PatternStyle;
  bassHz: number;
  offset: number;
  seed: number;
}

export const DEMO_TRACKS: DemoSpec[] = [
  { id: 'house-124', title: 'Demo House 124', bpm: 124, seconds: 120, style: 'house', bassHz: 55, offset: 0.12, seed: 7 },
  { id: 'house-128', title: 'Demo House 128', bpm: 128, seconds: 120, style: 'house', bassHz: 49, offset: 0.31, seed: 11 },
  { id: 'dnb-174', title: 'Demo Drum and Bass 174', bpm: 174, seconds: 90, style: 'dnb', bassHz: 41, offset: 0.05, seed: 3 },
  { id: 'halftime-87', title: 'Demo Half-time 87', bpm: 87, seconds: 90, style: 'halftime', bassHz: 44, offset: 0.2, seed: 5 },
];

/** Render a demo track into a stereo AudioBuffer at the context's sample rate. */
export function renderDemo(spec: DemoSpec, ctx: BaseAudioContext): AudioBuffer {
  const samples = renderPattern({
    bpm: spec.bpm,
    seconds: spec.seconds,
    sampleRate: ctx.sampleRate,
    style: spec.style,
    offset: spec.offset,
    seed: spec.seed,
    bassHz: spec.bassHz,
  });
  const buffer = ctx.createBuffer(2, samples.length, ctx.sampleRate);
  buffer.copyToChannel(samples, 0);
  buffer.copyToChannel(samples, 1);
  return buffer;
}
