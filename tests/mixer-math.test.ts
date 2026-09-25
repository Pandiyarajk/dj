/**
 * Tests for crossfader and fader curves.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { describe, expect, it } from 'vitest';
import {
  centeredDbFromKnob,
  crossfaderGains,
  dbToGain,
  faderGain,
  filterFrequencies,
  FILTER_OPEN_HIGH,
  FILTER_OPEN_LOW,
  gainToDb,
  knobFromCenteredDb,
} from '../src/audio/mixer-math';

describe('filterFrequencies', () => {
  it('is open at and near centre', () => {
    expect(filterFrequencies(0)).toEqual({ lowpass: FILTER_OPEN_LOW, highpass: FILTER_OPEN_HIGH });
    expect(filterFrequencies(0.02)).toEqual({ lowpass: FILTER_OPEN_LOW, highpass: FILTER_OPEN_HIGH });
  });

  it('sweeps a low-pass down to the left and a high-pass up to the right', () => {
    expect(filterFrequencies(-1).lowpass).toBeCloseTo(150, 6);
    expect(filterFrequencies(1).highpass).toBeCloseTo(6000, 6);
    expect(filterFrequencies(-0.5).lowpass).toBeLessThan(filterFrequencies(-0.25).lowpass);
    expect(filterFrequencies(0.5).highpass).toBeGreaterThan(filterFrequencies(0.25).highpass);
    expect(filterFrequencies(-0.5).highpass).toBe(FILTER_OPEN_HIGH);
    expect(filterFrequencies(0.5).lowpass).toBe(FILTER_OPEN_LOW);
  });
});

describe('crossfaderGains', () => {
  it('smooth curve is constant power across the whole throw', () => {
    for (let x = -1; x <= 1.0001; x += 0.05) {
      const [a, b] = crossfaderGains(x, 'smooth');
      expect(a * a + b * b).toBeCloseTo(1, 9);
    }
  });

  it('smooth curve is full A / full B at the ends and -3 dB each in the centre', () => {
    expect(crossfaderGains(-1, 'smooth')).toEqual([1, 0].map((v) => expect.closeTo(v, 9)));
    expect(crossfaderGains(1, 'smooth')).toEqual([0, 1].map((v) => expect.closeTo(v, 9)));
    const [a, b] = crossfaderGains(0, 'smooth');
    expect(gainToDb(a)).toBeCloseTo(-3.01, 1);
    expect(b).toBeCloseTo(a, 9);
  });

  it('sharp curve keeps both decks at full volume except at the edges', () => {
    expect(crossfaderGains(0, 'sharp')).toEqual([1, 1]);
    expect(crossfaderGains(0.85, 'sharp')).toEqual([1, 1]);
    expect(crossfaderGains(1, 'sharp')).toEqual([0, 1]);
    expect(crossfaderGains(-1, 'sharp')).toEqual([1, 0]);
    expect(crossfaderGains(0.95, 'sharp')[0]).toBeCloseTo(0.5, 9);
  });

  it('clamps out-of-range positions', () => {
    expect(crossfaderGains(-5, 'smooth')).toEqual(crossfaderGains(-1, 'smooth'));
    expect(crossfaderGains(5, 'sharp')).toEqual(crossfaderGains(1, 'sharp'));
  });
});

describe('faderGain and dB helpers', () => {
  it('is 0 closed, 1 open and monotonic', () => {
    expect(faderGain(0)).toBe(0);
    expect(faderGain(1)).toBe(1);
    let prev = -1;
    for (let p = 0; p <= 1; p += 0.1) {
      expect(faderGain(p)).toBeGreaterThan(prev);
      prev = faderGain(p);
    }
  });

  it('round-trips dB', () => {
    expect(dbToGain(0)).toBe(1);
    expect(gainToDb(dbToGain(-12))).toBeCloseTo(-12, 9);
    expect(gainToDb(0)).toBe(-Infinity);
  });
});

describe('centre-detented knob mapping', () => {
  it('maps the ends and centre', () => {
    expect(centeredDbFromKnob(0, -26, 6)).toBe(-26);
    expect(centeredDbFromKnob(0.5, -26, 6)).toBe(0);
    expect(centeredDbFromKnob(1, -26, 6)).toBe(6);
  });

  it('round-trips', () => {
    for (let p = 0; p <= 1.0001; p += 0.05) {
      expect(knobFromCenteredDb(centeredDbFromKnob(p, -26, 6), -26, 6)).toBeCloseTo(Math.min(1, p), 9);
    }
  });
});
