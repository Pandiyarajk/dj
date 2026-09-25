/**
 * WAV (RIFF, 16-bit PCM, stereo) encoding for mix recordings.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */

/** Largest data size a RIFF header can describe (4 GB minus the header). */
export const MAX_WAV_DATA_BYTES = 0xffffffff - 36;

/** 44-byte WAV header for `dataBytes` of 16-bit stereo PCM. */
export function wavHeader(dataBytes: number, sampleRate: number, channels = 2): ArrayBuffer {
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) header.setUint8(offset + i, value.charCodeAt(i));
  };
  const blockAlign = channels * 2;
  text(0, 'RIFF');
  header.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, channels, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * blockAlign, true);
  header.setUint16(32, blockAlign, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, dataBytes, true);
  return header.buffer;
}

/** Interleave two channels into 16-bit little-endian PCM, clipping at full scale. */
export function toPcm16(left: Float32Array, right: Float32Array): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(left.length * 4));
  for (let i = 0; i < left.length; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    out.setInt16(i * 4, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    out.setInt16(i * 4 + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
  }
  return out.buffer;
}
