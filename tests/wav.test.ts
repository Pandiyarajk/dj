/**
 * WAV header and PCM encoding tests.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { describe, expect, it } from 'vitest';
import { toPcm16, wavHeader } from '../src/audio/wav';

describe('wavHeader', () => {
  it('describes 16-bit stereo PCM of the given size', () => {
    const view = new DataView(wavHeader(4800 * 4, 48000));
    const text = (o: number, n: number): string => String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(o + i)));
    expect(text(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 19200);
    expect(text(8, 4)).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(192000);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(19200);
  });
});

describe('toPcm16', () => {
  it('interleaves and scales, clipping beyond full scale', () => {
    const pcm = new DataView(toPcm16(Float32Array.of(0, 1, -1, 2), Float32Array.of(0.5, -0.5, 0, -3)));
    expect(pcm.byteLength).toBe(16);
    expect(pcm.getInt16(0, true)).toBe(0);
    expect(pcm.getInt16(2, true)).toBe(16383);
    expect(pcm.getInt16(4, true)).toBe(32767);
    expect(pcm.getInt16(6, true)).toBe(-16384);
    expect(pcm.getInt16(8, true)).toBe(-32768);
    expect(pcm.getInt16(12, true)).toBe(32767);
    expect(pcm.getInt16(14, true)).toBe(-32768);
  });
});
