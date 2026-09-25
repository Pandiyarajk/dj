/**
 * Deterministic drum-pattern synthesiser.
 *
 * Produces the built-in demo tracks (so the app is usable, and smoke-testable,
 * without any music files) and the known-tempo signals the BPM tests use.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */

export type PatternStyle = 'clicks' | 'house' | 'dnb' | 'halftime';

export interface PatternOptions {
  bpm: number;
  seconds: number;
  sampleRate: number;
  style: PatternStyle;
  /** Time of the first beat, seconds. */
  offset?: number;
  /** Seed for the noise generator, so output is identical run to run. */
  seed?: number;
  /** Bass line root in Hz; 0 for none. */
  bassHz?: number;
}

/** Small deterministic PRNG (mulberry32). */
function noiseSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

type Voice = 'kick' | 'snare' | 'hat' | 'click';

function addVoice(out: Float32Array, start: number, voice: Voice, sampleRate: number, noise: () => number): void {
  const s0 = Math.round(start * sampleRate);
  const lengths: Record<Voice, number> = { kick: 0.35, snare: 0.18, hat: 0.05, click: 0.012 };
  const n = Math.round(lengths[voice] * sampleRate);
  let phase = 0;
  let hpPrev = 0;
  let hpOut = 0;
  for (let i = 0; i < n && s0 + i < out.length; i++) {
    if (s0 + i < 0) continue;
    const t = i / sampleRate;
    let v: number;
    if (voice === 'kick') {
      const freq = 50 + 110 * Math.exp(-t * 30);
      phase += (2 * Math.PI * freq) / sampleRate;
      v = Math.sin(phase) * Math.exp(-t * 9) * 0.9;
    } else if (voice === 'snare') {
      phase += (2 * Math.PI * 190) / sampleRate;
      v = (noise() * 0.6 + Math.sin(phase) * 0.4) * Math.exp(-t * 22) * 0.55;
    } else if (voice === 'hat') {
      const x = noise();
      hpOut = 0.9 * (hpOut + x - hpPrev);
      hpPrev = x;
      v = hpOut * Math.exp(-t * 90) * 0.25;
    } else {
      phase += (2 * Math.PI * 1500) / sampleRate;
      v = Math.sin(phase) * Math.exp(-t * 300) * 0.8;
    }
    out[s0 + i] += v;
  }
}

/** Which voices sound on each 16th-note step of a bar, per style. */
function voicesAt(style: PatternStyle, step: number): Voice[] {
  const voices: Voice[] = [];
  const onBeat = step % 4 === 0;
  switch (style) {
    case 'clicks':
      if (onBeat) voices.push('click');
      break;
    case 'house':
      if (onBeat) voices.push('kick');
      if (step % 4 === 2) voices.push('hat');
      if (step === 4 || step === 12) voices.push('snare');
      break;
    case 'dnb':
      // Two-step: kick on 1 and the "and" of 3, snare on 2 and 4, 8th-note hats.
      if (step === 0 || step === 10) voices.push('kick');
      if (step === 4 || step === 12) voices.push('snare');
      if (step % 2 === 0) voices.push('hat');
      break;
    case 'halftime':
      // Hip-hop feel: kick on 1, snare on 3, hats on the beats.
      if (step === 0 || step === 6) voices.push('kick');
      if (step === 8) voices.push('snare');
      if (onBeat) voices.push('hat');
      break;
  }
  return voices;
}

/**
 * Render a mono drum pattern.
 *
 * @returns PCM in -1..1 (peaks are soft-limited), length seconds * sampleRate.
 */
export function renderPattern(options: PatternOptions): Float32Array<ArrayBuffer> {
  const { bpm, seconds, sampleRate, style, offset = 0, seed = 1, bassHz = 0 } = options;
  const out = new Float32Array(Math.round(seconds * sampleRate));
  const noise = noiseSource(seed);
  const sixteenth = 60 / bpm / 4;

  for (let step = 0; ; step++) {
    const time = offset + step * sixteenth;
    if (time >= seconds) break;
    for (const voice of voicesAt(style, step % 16)) addVoice(out, time, voice, sampleRate, noise);
  }

  if (bassHz > 0) {
    // Off-beat bass stabs on a four-bar root progression.
    const roots = [1, 1, 1.189, 0.891];
    const beat = 60 / bpm;
    for (let b = 0; offset + b * beat < seconds; b++) {
      const start = Math.round((offset + b * beat + beat / 2) * sampleRate);
      const freq = bassHz * roots[Math.floor(b / 4) % roots.length];
      const n = Math.round(beat * 0.4 * sampleRate);
      for (let i = 0; i < n && start + i < out.length; i++) {
        const t = i / sampleRate;
        const saw = 2 * ((t * freq) % 1) - 1;
        out[start + i] += saw * 0.18 * Math.min(1, t * 200) * Math.exp(-t * 6);
      }
    }
  }

  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i]);
  return out;
}
