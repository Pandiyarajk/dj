/*
 * make-corpus.mjs: generate a labelled audio test corpus (WAV) for testing
 * the analysers and the app with music-like material of known BPM, grid,
 * key and relative loudness, in the formats browsers decode.
 *
 * No encoders are needed (none may be installed): everything is WAV, in the
 * variants that matter (sample rates, bit depths, mono/stereo, float).
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-26-2026
 *
 *   node scripts/make-corpus.mjs <output-dir>
 *   writes <output-dir>/*.wav and <output-dir>/labels.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/make-corpus.mjs <output-dir>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

// ---------------------------------------------------------------- helpers

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const NOTE = { C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
const camelot = (tonic, minor) => `${(minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[NOTE[tonic]]}${minor ? 'A' : 'B'}`;

/** Stereo buffer. */
function buffer(seconds, rate) {
  const n = Math.round(seconds * rate);
  return { rate, l: new Float32Array(n), r: new Float32Array(n) };
}

function add(buf, start, fn, seconds, pan = 0) {
  const s0 = Math.round(start * buf.rate);
  const n = Math.round(seconds * buf.rate);
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < n; i++) {
    const k = s0 + i;
    if (k < 0 || k >= buf.l.length) continue;
    const v = fn(i / buf.rate);
    buf.l[k] += v * gl;
    buf.r[k] += v * gr;
  }
}

// ---------------------------------------------------------------- voices

const kick = (t) => Math.sin(2 * Math.PI * (50 * t + (110 / 30) * (1 - Math.exp(-t * 30)))) * Math.exp(-t * 8) * 0.95;
function snare(noise) {
  return (t) => (noise() * 0.55 + Math.sin(2 * Math.PI * 190 * t) * 0.35) * Math.exp(-t * 20) * 0.6;
}
function hat(noise, open = false) {
  let prev = 0;
  let hp = 0;
  return (t) => {
    const x = noise();
    hp = 0.92 * (hp + x - prev);
    prev = x;
    return hp * Math.exp(-t * (open ? 18 : 80)) * 0.28;
  };
}
/** Pad/stab chord: detuned saws through a soft envelope. */
function chord(notes, attack, decay, gain) {
  return (t) => {
    let v = 0;
    for (const m of notes) {
      const f = midiHz(m);
      v += 2 * ((t * f) % 1) - 1 + (2 * ((t * f * 1.004) % 1) - 1);
    }
    return (v / (notes.length * 2)) * gain * Math.min(1, t / attack) * Math.exp(-t * decay);
  };
}
const bassNote = (m, gain) => (t) => Math.tanh(3 * Math.sin(2 * Math.PI * midiHz(m) * t)) * gain * Math.min(1, t * 300) * Math.exp(-t * 3);
const lead = (m, gain) => (t) => (Math.sin(2 * Math.PI * midiHz(m) * t) + 0.3 * Math.sin(4 * Math.PI * midiHz(m) * t)) * gain * Math.min(1, t * 80) * Math.exp(-t * 4);

// ---------------------------------------------------------------- arrangement

/**
 * A track: drums in a style, a chord progression in a key, bass and a lead
 * line from the scale, with optional intro, breakdown, swing, humanise and
 * tempo drift.
 */
function track(spec) {
  const { bpm, seconds, rate = 44100, style, key, minor, offset = 0.2, seed = 1, level = 1, swing = 0, humanise = 0, drift = 0, intro = 0, breakdown = null, beatless = false } = spec;
  const buf = buffer(seconds, rate);
  const noise = rng(seed);
  const jitter = rng(seed * 7 + 3);
  const tonic = NOTE[key] + 48;
  const scale = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const degrees = minor ? [0, 5, 6, 0, 3] : [0, 3, 4, 0, 5];
  const triad = (d) => [0, 2, 4].map((k) => tonic + 12 + scale[(d + k) % 7] + 12 * Math.floor((d + k) / 7));

  // Beat times, with tempo drift (live band) applied to the beat clock.
  const beats = [];
  let t = offset;
  let b = 0;
  while (t < seconds) {
    beats.push(t);
    const local = bpm * (1 + drift * Math.sin((2 * Math.PI * b) / 64));
    t += 60 / local;
    b++;
  }
  const inBreak = (time) => breakdown && time >= breakdown[0] && time < breakdown[1];

  beats.forEach((bt, i) => {
    const bar = Math.floor(i / 4);
    const step = i % 4;
    const human = () => jitter() * humanise;
    const drums = !beatless && bt >= intro && !inBreak(bt);
    const sixteenth = (beats[i + 1] ?? bt + 60 / bpm) - bt;
    const off = (n) => bt + n * (sixteenth / 4) + (n % 2 ? swing * (sixteenth / 4) : 0);
    if (drums) {
      if (style === 'four') {
        add(buf, bt + human(), kick, 0.4);
        add(buf, off(2) + human(), hat(noise, true), 0.12, 0.3);
        if (step === 1 || step === 3) add(buf, bt + human(), snare(noise), 0.25, -0.1);
      } else if (style === 'trance') {
        add(buf, bt + human(), kick, 0.4);
        add(buf, off(2) + human(), bassNote(tonic - 12, 0.35), sixteenth * 0.4);
        for (const n of [0, 1, 2, 3]) add(buf, off(n) + human(), hat(noise), 0.05, 0.4);
      } else if (style === 'breaks') {
        if (step === 0 || (step === 2 && bar % 2)) add(buf, bt + human(), kick, 0.4);
        if (step === 1 || step === 3) add(buf, bt + human(), snare(noise), 0.25);
        for (const n of [0, 2]) add(buf, off(n) + human(), hat(noise), 0.05, 0.3);
        if (step === 2) add(buf, off(2) + human(), kick, 0.3);
      } else if (style === 'halftime') {
        if (step === 0) add(buf, bt + human(), kick, 0.4);
        if (step === 2) add(buf, bt + human(), snare(noise), 0.3);
        for (const n of [0, 2]) add(buf, off(n) + human(), hat(noise), 0.05, -0.3);
      } else if (style === 'twostep') {
        if (step === 0 || step === 2) add(buf, off(step === 2 ? 1 : 0) + human(), kick, 0.4);
        if (step === 1 || step === 3) add(buf, bt + human(), snare(noise), 0.22);
        for (const n of [1, 3]) add(buf, off(n) + human(), hat(noise), 0.05, 0.2);
      }
    }
    // Harmony: one chord per bar, stabs on off-beats, a lead phrase.
    if (step === 0) {
      const d = degrees[bar % degrees.length];
      add(buf, bt, chord(triad(d), beatless ? 0.8 : 0.01, beatless ? 0.2 : 1.2, beatless ? 0.22 : 0.16), (60 / bpm) * 4, 0);
      if (!beatless && !inBreak(bt) && bt >= intro) add(buf, bt, bassNote(tonic - 12 + scale[d], 0.3), (60 / bpm) * 1.5);
    }
    if (!beatless && step === 2 && bar % 2 === 0) {
      const d = degrees[bar % degrees.length];
      add(buf, bt, lead(tonic + 24 + scale[(d + 2) % 7], 0.12), 60 / bpm, 0.4);
    }
  });

  // Master: level, then soft clipping for loud masters.
  for (let i = 0; i < buf.l.length; i++) {
    buf.l[i] = Math.tanh(buf.l[i] * level);
    buf.r[i] = Math.tanh(buf.r[i] * level);
  }
  return buf;
}

// ---------------------------------------------------------------- WAV writer

function wav(buf, { bits = 16, float = false, mono = false } = {}) {
  const channels = mono ? 1 : 2;
  const bytes = float ? 4 : bits / 8;
  const n = buf.l.length;
  const data = Buffer.alloc(n * channels * bytes);
  let o = 0;
  const put = (v) => {
    const x = Math.max(-1, Math.min(1, v));
    if (float) data.writeFloatLE(x, o);
    else if (bits === 8) data.writeUInt8(Math.round((x + 1) * 127.5), o);
    else if (bits === 16) data.writeInt16LE(Math.round(x * 32767), o);
    else if (bits === 24) data.writeIntLE(Math.round(x * 8388607), o, 3);
    o += bytes;
  };
  for (let i = 0; i < n; i++) {
    if (mono) put((buf.l[i] + buf.r[i]) / 2);
    else {
      put(buf.l[i]);
      put(buf.r[i]);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(float ? 3 : 1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(buf.rate, 24);
  header.writeUInt32LE(buf.rate * channels * bytes, 28);
  header.writeUInt16LE(channels * bytes, 32);
  header.writeUInt16LE(bytes * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ---------------------------------------------------------------- corpus

const corpus = [
  { name: 'House 124 A minor', bpm: 124, seconds: 90, style: 'four', key: 'A', minor: true, offset: 0.12 },
  { name: 'Deep House 122 F major (quiet master)', bpm: 122, seconds: 80, style: 'four', key: 'F', minor: false, offset: 0.4, level: 0.35 },
  { name: 'Techno 132 D minor (loud master)', bpm: 132, seconds: 80, style: 'four', key: 'D', minor: true, offset: 0.05, level: 3.5 },
  { name: 'Trance 138 G minor', bpm: 138, seconds: 80, style: 'trance', key: 'G', minor: true, offset: 0.3 },
  { name: 'Drum and Bass 174 E minor', bpm: 174, seconds: 80, style: 'breaks', key: 'E', minor: true, offset: 0.1 },
  { name: 'Dubstep 140 F minor (half-time feel)', bpm: 140, seconds: 80, style: 'halftime', key: 'F', minor: true, offset: 0.25 },
  { name: 'Hip-hop 90 C minor (swung)', bpm: 90, seconds: 80, style: 'halftime', key: 'C', minor: true, offset: 0.33, swing: 0.3 },
  { name: 'UK Garage 130 Bb major (two-step)', bpm: 130, seconds: 80, style: 'twostep', key: 'Bb', minor: false, offset: 0.2 },
  { name: 'Funk 110 E major (live drummer, drift)', bpm: 110, seconds: 90, style: 'breaks', key: 'E', minor: false, offset: 0.5, humanise: 0.008, drift: 0.01 },
  { name: 'Long intro 126 C major', bpm: 126, seconds: 90, style: 'four', key: 'C', minor: false, offset: 0.2, intro: 20 },
  { name: 'Breakdown 128 Eb minor', bpm: 128, seconds: 100, style: 'four', key: 'Eb', minor: true, offset: 0.15, breakdown: [40, 70] },
  { name: 'Ambient beatless D major', bpm: 70, seconds: 60, style: 'four', key: 'D', minor: false, beatless: true },
  { name: 'Extended mix 125 B minor (8 min)', bpm: 125, seconds: 480, style: 'four', key: 'B', minor: true, offset: 0.08 },
];

const variants = [
  { suffix: '44k16', rate: 44100, format: { bits: 16 } },
];
const formatSpecials = [
  { base: 0, suffix: '48k24', rate: 48000, format: { bits: 24 } },
  { base: 0, suffix: '22k16 mono', rate: 22050, format: { bits: 16, mono: true } },
  { base: 3, suffix: '48k float', rate: 48000, format: { float: true } },
  { base: 7, suffix: '44k8', rate: 44100, format: { bits: 8 } },
];

const labels = [];
const write = (spec, suffix, rate, format) => {
  const file = `${spec.name} [${suffix}].wav`;
  const buf = track({ ...spec, rate, seed: labels.length + 1 });
  writeFileSync(join(out, file), wav(buf, format));
  labels.push({
    file,
    bpm: spec.beatless ? null : spec.bpm,
    firstBeat: spec.beatless ? null : spec.offset ?? 0.2,
    key: camelot(spec.key, spec.minor),
    keyName: `${spec.key} ${spec.minor ? 'minor' : 'major'}`,
    loudness: spec.level === undefined ? 'normal' : spec.level < 1 ? 'quiet' : 'loud',
    style: spec.style,
    seconds: spec.seconds,
    rate,
    format,
    notes: [spec.swing ? 'swung' : '', spec.humanise ? 'humanised timing and 1% tempo drift' : '', spec.intro ? `${spec.intro} s drum-less intro` : '', spec.breakdown ? `beatless breakdown ${spec.breakdown.join('-')} s` : '', spec.beatless ? 'no beat at all' : ''].filter(Boolean),
  });
  console.log(`wrote ${file}`);
};
for (const spec of corpus) for (const v of variants) write(spec, v.suffix, v.rate, v.format);
for (const s of formatSpecials) write(corpus[s.base], s.suffix, s.rate, s.format);

writeFileSync(join(out, 'labels.json'), JSON.stringify(labels, null, 2));
console.log(`${labels.length} files, labels.json written`);
