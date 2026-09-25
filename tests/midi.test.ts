/**
 * MIDI decoding, 14-bit pairing, relative jogs, shift layer, LED output.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { describe, expect, it } from 'vitest';
import { Actions } from '../src/input/actions';
import { decodeMidi, MidiInput, relativeTicks, type MidiBinding } from '../src/input/midi';

function harness(bindings?: MidiBinding[]) {
  const actions = new Actions();
  const calls: Array<[string, number]> = [];
  for (const name of ['deck.A.tempo', 'deck.A.play', 'deck.A.sync', 'deck.A.keylock', 'deck.A.jog.top', 'deck.A.hotcue.1', 'deck.A.hotcue.1.clear', 'mixer.A.fader']) {
    actions.register(name, (v) => calls.push([name, v]));
  }
  const midi = new MidiInput(actions, bindings);
  return { midi, calls };
}

describe('decodeMidi', () => {
  it('decodes notes (note on with velocity 0 is an off) and CCs', () => {
    expect(decodeMidi([0x91, 0x0b, 127])).toEqual({ kind: 'note', channel: 1, number: 0x0b, value: 127, pressed: true });
    expect(decodeMidi([0x90, 0x0b, 0])?.pressed).toBe(false);
    expect(decodeMidi([0x80, 0x0b, 64])?.pressed).toBe(false);
    expect(decodeMidi([0xb6, 0x1f, 100])).toMatchObject({ kind: 'cc', channel: 6, number: 0x1f, value: 100 });
    expect(decodeMidi([0xf8, 0, 0])).toBeNull();
    expect(decodeMidi([0x90, 1])).toBeNull();
  });

  it('reads relative jog ticks around 64', () => {
    expect(relativeTicks(65)).toBe(1);
    expect(relativeTicks(60)).toBe(-4);
  });
});

describe('MidiInput', () => {
  it('pairs an MSB with its CC+32 LSB into 14 bits', () => {
    const { midi, calls } = harness();
    midi.handleMessage([0xb0, 0x00, 64]);
    midi.handleMessage([0xb0, 0x20, 1]);
    expect(calls[0]).toEqual(['deck.A.tempo', 64 / 127]);
    expect(calls[1][0]).toBe('deck.A.tempo');
    expect(calls[1][1]).toBeCloseTo((64 * 128 + 1) / 16383, 9);
  });

  it('sends jog wheels as signed ticks', () => {
    const { midi, calls } = harness();
    midi.handleMessage([0xb0, 0x22, 67]);
    midi.handleMessage([0xb0, 0x22, 61]);
    expect(calls).toEqual([
      ['deck.A.jog.top', 3],
      ['deck.A.jog.top', -3],
    ]);
  });

  it('uses the shift layer while SHIFT is held', () => {
    const { midi, calls } = harness();
    midi.handleMessage([0x90, 0x58, 127]);
    midi.handleMessage([0x90, 0x3f, 127]);
    midi.handleMessage([0x90, 0x58, 127]);
    midi.handleMessage([0x90, 0x3f, 0]);
    expect(calls.map((c) => c[0])).toEqual(['deck.A.sync', 'deck.A.keylock']);
  });

  it('hands the next control to MIDI learn instead of triggering', () => {
    const { midi, calls } = harness();
    let learned: unknown = null;
    midi.learnNext((m) => (learned = m));
    midi.handleMessage([0x92, 0x40, 127]);
    expect(learned).toMatchObject({ kind: 'note', channel: 2, number: 0x40 });
    expect(calls).toEqual([]);
  });

  it('sends only changed LED states', () => {
    const { midi } = harness();
    const sent: number[][] = [];
    let playing = true;
    midi.setLedSource(() => new Map([['deck.A.play', playing]]));
    midi.updateLeds((b) => sent.push(b));
    midi.updateLeds((b) => sent.push(b));
    playing = false;
    midi.updateLeds((b) => sent.push(b));
    expect(sent).toEqual([
      [0x90, 0x0b, 127],
      [0x90, 0x0b, 0],
    ]);
  });
});
